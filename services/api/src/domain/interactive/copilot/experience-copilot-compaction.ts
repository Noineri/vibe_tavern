/**
 * Experience-Copilot compaction service (COPILOT_CONTEXT_METER_PLAN, Wave 2 /
 * CM-5 + CM-6).
 *
 * LLM summarize-and-replace: an LLM call folds everything older than the
 * current keep-window (the prior digest + the messages since it that are being
 * replaced) into a NEW digest message. The digest REPLACES the old messages in
 * the MODEL window only — the UI keeps rendering the full history; the stream's
 * pre-split (`resolveDigestBoundary`) drops the covered prefix before assembly.
 *
 * Anchor semantics (CM-5, approved): a digest message (role === "digest")
 * stores the id of the FIRST KEPT message in its `toolCallId` column
 * (see {@link COPILOT_DIGEST_ANCHOR_FIELD}). `resolveDigestBoundary` is the
 * single source of truth for the split, shared with the stream. The digest is
 * APPENDED to the message list (end position); the anchor — not list position —
 * marks the boundary.
 *
 * Mirrors `ChatSummaryService`: `nonstreamingProviderExecute` is INJECTABLE (so
 * tests substitute a fake WITHOUT `mock.module("ai")`), and the provider/model
 * resolution + API-key validation reuse `summary-generation-seam.ts`. Manual
 * compact propagates errors (nothing-to-compact 400, provider 502 via the
 * global handler); auto-compact (CM-6) is fire-and-forget under a per-thread
 * {@link BackgroundTaskLocks} lane and NEVER blocks/fails the stream.
 */

import {
  findSafeCompactionBoundary,
  estimateTokens,
  setModelHint,
} from "@vibe-tavern/prompt-pipeline";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotMessage,
  CopilotContextMetrics,
} from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../../infrastructure/ai/nonstreaming-provider-executor.js";
import { BackgroundTaskLocks } from "../../../shared/background-task-locks.js";
import { notFound, validation, conflict } from "../../../shared/errors.js";
import { logSendDebug } from "../../../shared/send-debug-log.js";
import {
  providerRequiresApiKey,
  resolveEffectiveSummaryProfile,
} from "../../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../../providers/provider-profile-service.js";
import {
  resolveDigestBoundary,
  renderDigestSection,
  estimateHistoryTokens,
  COPILOT_DIGEST_ANCHOR_FIELD,
  type ExperienceCopilotFlowMessage,
} from "./experience-copilot-prompt.js";
import { storeMessagesToHistory } from "./experience-copilot-stream.js";

/** How many of the most recent messages stay verbatim (unsummarized) when
 *  compacting. The plan did not pin a number; 8 ≈ 2–3 authoring turns of recent
 *  context, and the assembler's budget-trim still trims within this window when
 *  the effective profile budget is tighter. */
const KEEP_WINDOW_MESSAGES = 8;

/** Auto-compaction threshold: fraction of `budgetTokens` that triggers a
 *  background compaction after a turn settles (CM-6). */
const AUTO_COMPACT_THRESHOLD = 0.8;

/** The summarization system prompt: dense, self-contained, and lossless with
 *  respect to decisions / current state / TODOs / tool findings. */
const COMPACTION_SYSTEM_PROMPT = [
  "You are compacting the history of an AI pair-programming session that authors Vibe Tavern interactive experiences (a `rules` JavaScript package registered via `context.experience.register`, and an optional `visual` package).",
  "Produce a DENSE, self-contained summary of the conversation below that a future turn can use INSTEAD of the original messages.",
  "Preserve, with concrete detail:",
  "- Decisions made and their rationale.",
  "- The CURRENT state of the rules package and visual package: the latest accepted edits (write_buffer / edit_buffer proposals) and the user's feedback on them.",
  "- Open TODOs, unresolved questions, and explicit next steps.",
  "- Tool findings (run_test / run_simulate results, skill-file findings) that changed the plan.",
  "Do NOT invent anything not present in the transcript. Output ONLY the summary text — no preamble, no markdown fences.",
].join("\n");

export interface CompactCopilotInput {
  threadId: string;
  /** Optional explicit pair — required when the thread has no last-used pair. */
  providerProfileId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CompactCopilotResult {
  digest: ExperienceCopilotMessage;
  metrics: CopilotContextMetrics;
}

/** Internal options distinguishing the manual (throw-on-empty) from the
 *  fire-and-forget auto (skip-on-empty) path. */
interface CompactInternalOptions {
  /** Auto-compact: when there is nothing to compact, return null instead of
   *  throwing a 400 (the trigger is best-effort, not user-initiated). */
  readonly skipWhenNothingToCompact?: boolean;
}

export class ExperienceCopilotCompactionService {
  /** Shared per-thread lane: manual and auto compaction dedupe to one run. */
  private readonly locks = new BackgroundTaskLocks();

  constructor(
    private readonly store: ExperienceCopilotStore,
    private readonly providerProfiles: ProviderProfileService,
    private readonly execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
  ) {}

  /** Manual compaction (route): synchronous, errors propagate (400/404/502). */
  async compact(input: CompactCopilotInput): Promise<CompactCopilotResult> {
    let result: CompactCopilotResult | null = null;
    let failure: unknown = null;

    const ran = await this.locks.runExclusive(input.threadId, async () => {
      try {
        result = await this.compactInternal(input, {});
      } catch (err) {
        failure = err;
      }
    });

    if (!ran) {
      throw conflict("Compaction is already in progress for this thread.");
    }
    if (failure !== null) {
      throw failure;
    }
    return result!;
  }

  /** CM-6 fire-and-forget auto-compaction. Returns immediately after the
   *  threshold/toggle checks; the actual compaction runs under the per-thread
   *  lock and is skipped (never awaited) if a manual/auto compaction is already
   *  in-flight. Errors are logged, never re-thrown. */
  async autoCompactAfterTurn(threadId: string): Promise<void> {
    const thread = await this.store.getById(threadId);
    if (!thread) return;

    const metrics = thread.contextMetrics;
    // Unmetered (no explicit budget) → cannot compute a percentage → skip.
    if (!metrics || !(metrics.budgetTokens > 0)) return;
    if (!(metrics.totalTokens >= AUTO_COMPACT_THRESHOLD * metrics.budgetTokens)) return;
    if (!thread.autoCompact) return;
    // No last-used pair → the service cannot resolve a provider/model → skip.
    if (!thread.lastProviderProfileId || !thread.lastModel) return;

    await this.locks.runExclusive(
      threadId,
      async () => {
        await this.compactInternal(
          {
            threadId,
            providerProfileId: thread.lastProviderProfileId ?? undefined,
            model: thread.lastModel ?? undefined,
          },
          { skipWhenNothingToCompact: true },
        );
      },
      (err) =>
        logSendDebug("api.experience-copilot.auto-compact.error", {
          threadId,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  /** The single compaction implementation, shared by manual + auto. Resolves
   *  provider/model (explicit ?? thread's last-used ?? profile default),
   *  splits the history at a tool-pair-safe keep-window, summarizes the
   *  replaced prefix (+ prior digest), persists the digest with its anchor, and
   *  recomputes + persists an honest post-compaction metric estimate. */
  private async compactInternal(
    input: CompactCopilotInput,
    opts: CompactInternalOptions,
  ): Promise<CompactCopilotResult | null> {
    const thread = await this.store.getById(input.threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${input.threadId}' was not found.`);
    }

    const messages = await this.store.listMessages(input.threadId);

    // ── Split at the digest boundary + keep-window (tool-pair-safe) ─────────
    const boundary = resolveDigestBoundary(messages);
    const priorDigestText = boundary.lastDigest?.content ?? null;
    const window = boundary.kept as readonly ExperienceCopilotMessage[];

    const keptFlow = storeMessagesToHistory(window);
    const cursor = keptFlow.length > KEEP_WINDOW_MESSAGES
      ? findSafeCompactionBoundary(keptFlow, KEEP_WINDOW_MESSAGES)
      : 0;
    const toSummarize = window.slice(0, cursor);
    const keep = window.slice(cursor);

    if (toSummarize.length === 0) {
      if (opts.skipWhenNothingToCompact) return null;
      throw validation(
        "Nothing to compact: the copilot history is already within the keep-window.",
      );
    }

    // ── Resolve provider + model (explicit ?? last-used ?? profile default) ─
    const providerProfileId = (input.providerProfileId ?? thread.lastProviderProfileId ?? "").trim();
    if (!providerProfileId) {
      throw validation("Provider profile is required for compaction (no prior turn to inherit).");
    }
    const profile = await this.providerProfiles.getProviderProfile(providerProfileId);
    if (!profile) {
      throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
    }
    if (providerRequiresApiKey(profile.providerPreset) && !isLoopbackEndpoint(profile.endpoint) && !profile.apiKey?.trim()) {
      throw validation("Selected provider has no saved API key.");
    }
    const model = (input.model ?? thread.lastModel ?? profile.defaultModel ?? "").trim();
    if (!model) {
      throw validation("Select a model for compaction.");
    }
    const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.providerProfiles);

    // ── Summarize (injectable executor; provider errors → 502 via wrapper) ──
    const prompt = buildCompactionPrompt(priorDigestText, toSummarize);
    const generation = await this.execute({
      profile: effectiveProfile,
      model,
      prompt,
      signal: input.signal,
    });    const summary = generation.text.trim();
    if (!summary) {
      throw validation("Provider returned an empty summary.");
    }

    // ── Persist the digest at the cursor (anchor = first kept message) ──────
    const anchor = keep[0].id;
    const digest = await this.store.appendMessage(input.threadId, {
      role: "digest",
      content: summary,
      // COPILOT_DIGEST_ANCHOR_FIELD: on a digest, toolCallId holds the first
      // kept message's id (the boundary anchor), NOT a tool-result correlation.
      toolCallId: anchor,
    });

    // ── Recomputed post-compaction metrics (honest "estimate") ─────────────
    // `setModelHint` aligns `estimateTokens` with the model that produced the
    // summary (same convention the assembler uses).
    setModelHint(model);
    const priorMetrics = thread.contextMetrics;
    const digestTokens = estimateTokens(renderDigestSection(summary));
    // The keep-window never contains digests (it sits strictly after the last
    // digest's anchor), but the converter types it as the full history union —
    // narrow so the estimate stays on the flow type the assembler's formatter
    // expects.
    const keepFlow: ExperienceCopilotFlowMessage[] = storeMessagesToHistory(keep).filter(
      (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
    );
    const historyTokens = estimateHistoryTokens(keepFlow);
    const systemTokens = priorMetrics?.systemTokens ?? 0;
    const metrics: CopilotContextMetrics = {
      systemTokens,
      digestTokens,
      historyTokens,
      totalTokens: systemTokens + digestTokens + historyTokens,
      budgetTokens: priorMetrics?.budgetTokens ?? 0,
      reserveTokens: priorMetrics?.reserveTokens ?? 0,
      source: "estimate",
      measuredAt: new Date().toISOString(),
    };
    await this.store.updateContextMetrics(input.threadId, metrics, providerProfileId, model);

    logSendDebug("api.experience-copilot.compact.done", {
      threadId: input.threadId,
      digestId: digest.id,
      summarizedMessages: toSummarize.length,
      keptMessages: keep.length,
      summaryLength: summary.length,
      hadPriorDigest: priorDigestText !== null,
    });

    return { digest, metrics };
  }
}

/** True when the endpoint points at a loopback host (localhost / 127.0.0.1 /
 *  [::1]) — a local gateway (e.g. a self-hosted proxy on 127.0.0.1) injects
 *  its own credentials, so an empty profile API key is legitimate there and
 *  must NOT block compaction (mirrors provider-support's local-endpoint
 *  inference). */
function isLoopbackEndpoint(endpoint: string | null | undefined): boolean {
  const value = (endpoint ?? "").toLowerCase();
  return value.includes("localhost") || value.includes("127.0.0.1") || value.includes("[::1]");
}

/** Build the minimal `AssemblePromptResponse` the non-streaming executor
 *  consumes (it only reads `finalPayload.messages` via `toSdkMessages`): a
 *  system instruction + a single user message carrying the prior digest (if
 *  any) and the messages being replaced, rendered as a readable transcript. */
function buildCompactionPrompt(
  priorDigestText: string | null,
  toSummarize: readonly ExperienceCopilotMessage[],
): AssemblePromptResponse {
  const transcript = toSummarize
    .map((m) => {
      if (m.role === "tool") {
        return `[tool-result] ${m.content}`;
      }
      const toolPart = m.toolCallsJson ? `\n[tool-calls] ${m.toolCallsJson}` : "";
      return `${m.role.toUpperCase()}: ${m.content}${toolPart}`;
    })
    .join("\n\n");

  const userContent = priorDigestText
    ? `# Prior compacted context\n${priorDigestText}\n\n# Messages to fold in\n${transcript}`
    : transcript;

  return {
    layers: [],
    tokenAccounting: {},
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: {
      messages: [
        { role: "system", content: COMPACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    },
  };
}
