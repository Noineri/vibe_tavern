/**
 * Generic agent compaction service (AGENT_SHELL_PLAN, Wave 2 / AS-2b) — the
 * kind-AGNOSTIC summarize-and-replace mechanism carved out of
 * `experience-copilot-compaction.ts` (COPILOT_CONTEXT_METER_PLAN, Wave 2 /
 * CM-5 + CM-6): budget-trim + digest-boundary split + tool-pair-safe
 * keep-window + echo stubs + token estimate. Everything KIND-SPECIFIC is
 * injected through {@link AgentCompactionSeams} — the stored-message → flow
 * conversion, the summarizer system-prompt resolver (SC-8a: kind service
 * prompt — profile override else asset), the digest sampler overrides, and
 * the labels/log channels. The experience wiring lives in the old module
 * (`ExperienceCopilotCompactionService`, a thin subclass kept for
 * compatibility; AS-10 removes that shim).
 *
 * LLM summarize-and-replace: an LLM call folds everything older than the
 * current keep-window (the prior digest + the messages since it that are being
 * replaced) into a NEW digest message. The digest REPLACES the old messages in
 * the MODEL window only — the UI keeps rendering the full history; the stream's
 * pre-split (`resolveDigestBoundary`) drops the covered prefix before assembly.
 *
 * Anchor semantics (CM-5, approved): a digest message (role === "digest")
 * stores the id of the FIRST KEPT message in its `toolCallId` column
 * (see {@link AGENT_DIGEST_ANCHOR_FIELD}). `resolveDigestBoundary` is the
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
import type { CopilotContextMetrics } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { BackgroundTaskLocks } from "../../shared/background-task-locks.js";
import { notFound, validation, conflict } from "../../shared/errors.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import {
  resolveEffectiveSummaryProfile,
} from "../chat/summary-generation-seam.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import {
  resolveDigestBoundary,
  renderDigestSection,
  estimateHistoryTokens,
  stubHistoricalToolEchoes,
  type AgentHistoryMessage,
  type AgentFlowMessage,
  type DigestBoundaryMessage,
} from "./agent-prompt.js";

/** How many of the most recent messages stay verbatim (unsummarized) when
 *  compacting. The plan did not pin a number; 8 ≈ 2–3 authoring turns of recent
 *  context, and the assembler's budget-trim still trims within this window when
 *  the effective profile budget is tighter. */
const KEEP_WINDOW_MESSAGES = 8;

/** Auto-compaction threshold: fraction of `budgetTokens` that triggers a
 *  background compaction after a turn settles (CM-6). */
const AUTO_COMPACT_THRESHOLD = 0.8;

export interface CompactCopilotInput {
  threadId: string;
  /** Optional explicit pair — required when the thread has no last-used pair. */
  providerProfileId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CompactCopilotResult<M extends DigestBoundaryMessage> {
  digest: M;
  metrics: CopilotContextMetrics;
}

/** Structural thread subset the auto-compact gate reads. The concrete store's
 *  thread type satisfies this without adapters (same pattern as
 *  `CopilotContextDeps` in agent-context.ts). */
export interface AgentCompactionThread {
  readonly contextMetrics: CopilotContextMetrics | null;
  readonly autoCompact: boolean;
  readonly lastProviderProfileId: string | null;
  readonly lastModel: string | null;
}

/** The digest-append payload the service persists (CM-5 anchor overload:
 *  `toolCallId` carries the FIRST KEPT message's id on a digest row). */
export interface AgentDigestAppendInput {
  readonly role: "digest";
  readonly content: string;
  readonly toolCallId: string;
}

/** Structural store subset the compaction mechanism needs. The concrete
 *  per-kind store satisfies this without adapters (method syntax keeps param
 *  bivariance). */
export interface AgentCompactionStore<M extends DigestBoundaryMessage> {
  getById(threadId: string): Promise<AgentCompactionThread | null>;
  listMessages(threadId: string): Promise<readonly M[]>;
  appendMessage(threadId: string, input: AgentDigestAppendInput): Promise<M>;
  updateContextMetrics(
    threadId: string,
    metrics: CopilotContextMetrics,
    providerProfileId: string,
    model: string,
  ): Promise<unknown>;
}

/** The KIND-SPECIFIC seams injected into the generic mechanism — everything
 *  that cannot live in the kind-agnostic core without dragging kind knowledge
 *  (or an import of the kind's subsystem) into `domain/agent/`. */
export interface AgentCompactionSeams<M extends DigestBoundaryMessage> {
  /** Stored messages → history flow, the SAME conversion the kind's stream
   *  uses (the summarizer transcript and the model window must agree). */
  readonly storeMessagesToFlow: (messages: readonly M[]) => AgentHistoryMessage[];
  /** Resolves the kind's summarization system prompt AT COMPACTION TIME
   *  (SC-8a) from the kind's own service prompt — the active service-prompt
   *  profile's override when set, else the bundled asset (byte-identical to
   *  the pre-SC-8a compile-time constant) — the same resolution ladder
   *  `resolveSummaryPrompt` uses for the RP chat summary. Resolved per call
   *  so a profile edit applies to the next compaction without a restart. */
  readonly resolveSystemPrompt: () => Promise<string>;
  /** Digest sampler overrides (cool + roomy — a reasoning model must not burn
   *  the output cap on thinking alone). */
  readonly overrideTemperature: number;
  readonly overrideMaxTokens: number;
  /** Error label for a missing thread (e.g. the store entity name). */
  readonly threadLabel: string;
  /** Debug-log channel prefix (e.g. "api.experience-copilot"); the suffixes
   *  `.compact.done` / `.auto-compact.error` are appended here. */
  readonly logChannelPrefix: string;
}

/** Internal options distinguishing the manual (throw-on-empty) from the
 *  fire-and-forget auto (skip-on-empty) path. */
interface CompactInternalOptions {
  /** Auto-compact: when there is nothing to compact, return null instead of
   *  throwing a 400 (the trigger is best-effort, not user-initiated). */
  readonly skipWhenNothingToCompact?: boolean;
}

export class AgentCompactionService<M extends DigestBoundaryMessage> {
  /** Shared per-thread lane: manual and auto compaction dedupe to one run. */
  private readonly locks = new BackgroundTaskLocks();

  constructor(
    private readonly store: AgentCompactionStore<M>,
    private readonly providerProfiles: ProviderProfileService,
    private readonly execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
    private readonly seams: AgentCompactionSeams<M>,
  ) {}

  /** Manual compaction (route): synchronous, errors propagate (400/404/502). */
  async compact(input: CompactCopilotInput): Promise<CompactCopilotResult<M>> {
    let result: CompactCopilotResult<M> | null = null;
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
        logSendDebug(`${this.seams.logChannelPrefix}.auto-compact.error`, {
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
  ): Promise<CompactCopilotResult<M> | null> {
    const thread = await this.store.getById(input.threadId);
    if (!thread) {
      throw notFound(
        this.seams.threadLabel,
        `Copilot thread '${input.threadId}' was not found.`,
      );
    }

    const messages = await this.store.listMessages(input.threadId);

    // ── Split at the digest boundary + keep-window (tool-pair-safe) ─────────
    const boundary = resolveDigestBoundary(messages);
    const priorDigestText = boundary.lastDigest?.content ?? null;
    const window = boundary.kept as readonly M[];

    const keptFlow = this.seams.storeMessagesToFlow(window);
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
    const model = (input.model ?? thread.lastModel ?? profile.defaultModel ?? "").trim();
    if (!model) {
      throw validation("Select a model for compaction.");
    }
    const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.providerProfiles);

    // ── Summarize (injectable executor; provider errors → 502 via wrapper) ──
    // #16: the transcript is built from the FLOW conversion of the replaced
    // messages with ALL tool echoes stubbed (keepUserTurns: 0 — everything
    // being summarized is superseded; the summaries survive in the stubs, and
    // the CURRENT buffers ride in the assembler's context package anyway).
    // This keeps the summarizer call cheap for echo-heavy sessions and agrees
    // with what the model window showed for those same messages.
    const toSummarizeFlow = stubHistoricalToolEchoes(
      this.seams.storeMessagesToFlow(toSummarize).filter(
        (m): m is AgentFlowMessage => m.role !== "digest",
      ),
      { keepUserTurns: 0 },
    );
    const systemPrompt = await this.seams.resolveSystemPrompt();
    const prompt = buildCompactionPrompt(systemPrompt, priorDigestText, toSummarizeFlow);
    const generation = await this.execute({
      profile: effectiveProfile,
      model,
      prompt,
      signal: input.signal,
      // Kind-owned digest samplers (injected seams): the RP profile's
      // temperature/maxTokens are for chat RP, not summarization — cool and
      // roomy so a reasoning model can't burn the cap on thinking alone.
      overrideTemperature: this.seams.overrideTemperature,
      overrideMaxTokens: this.seams.overrideMaxTokens,
    });    const summary = generation.text.trim();
    if (!summary) {
      throw validation("Provider returned an empty summary.");
    }

    // ── Persist the digest at the cursor (anchor = first kept message) ──────
    const anchor = keep[0].id;
    const digest = await this.store.appendMessage(input.threadId, {
      role: "digest",
      content: summary,
      // AGENT_DIGEST_ANCHOR_FIELD: on a digest, toolCallId holds the first
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
    const keepFlow: AgentFlowMessage[] = this.seams.storeMessagesToFlow(keep).filter(
      (m): m is AgentFlowMessage => m.role !== "digest",
    );
    // #16: estimate the keep window the way the NEXT turn's assembly will see
    // it — with superseded echoes stubbed (messages older than the last two
    // user turns) — so post-compaction historyTokens stays honest.
    const historyTokens = estimateHistoryTokens(stubHistoricalToolEchoes(keepFlow));
    const systemTokens = priorMetrics?.systemTokens ?? 0;
    const metrics: CopilotContextMetrics = {
      systemTokens,
      digestTokens,
      historyTokens,
      totalTokens: systemTokens + digestTokens + historyTokens,
      // Compaction does not touch the pinned-context block — carry the prior
      // segment forward (0 for legacy rows, defaulted at parse).
      attachedTokens: priorMetrics?.attachedTokens ?? 0,
      budgetTokens: priorMetrics?.budgetTokens ?? 0,
      reserveTokens: priorMetrics?.reserveTokens ?? 0,
      source: "estimate",
      measuredAt: new Date().toISOString(),
    };
    await this.store.updateContextMetrics(input.threadId, metrics, providerProfileId, model);

    logSendDebug(`${this.seams.logChannelPrefix}.compact.done`, {
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

/** Build the minimal `AssemblePromptResponse` the non-streaming executor
 *  consumes (it only reads `finalPayload.messages` via `toSdkMessages`): a
 *  system instruction + a single user message carrying the prior digest (if
 *  any) and the messages being replaced, rendered as a readable transcript.
 *  Takes the FLOW history (store messages converted via the kind's
 *  `storeMessagesToFlow` seam and echo-stubbed — see compactInternal). */
function buildCompactionPrompt(
  systemPrompt: string,
  priorDigestText: string | null,
  toSummarize: readonly AgentFlowMessage[],
): AssemblePromptResponse {
  const transcript = toSummarize
    .map((m) => {
      if (m.role === "tool") {
        return `[tool-result] ${JSON.stringify(m.content)}`;
      }
      const toolPart = m.toolCalls ? `\n[tool-calls] ${JSON.stringify(m.toolCalls)}` : "";
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
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    },
  };
}
