/**
 * Script-agent prompt assembly (AGENT_SHELL_PLAN, Wave 3 / AS-7).
 *
 * Builds the system message + compacted history the script-agent model sees
 * each turn. Adapted from {@link assembleExperienceCopilotPrompt} (AS-2's
 * generic primitives — history shapes, digest handling, compaction, echo
 * stubbing — are reused verbatim from `domain/agent/agent-prompt.ts`); the
 * SPECIES half is script-specific:
 *
 * - the base prompt comes from the resolved profile (the built-in `script`
 *   seed loads `agent-script/base.md` live; user overrides of the
 *   `script_agent_base` service prompt apply on the seed path — SP-5 parity);
 * - the API-knowledge section is the RESOLVED `script` or `dice_script`
 *   service prompt BY THE THREAD'S SCRIPT KIND (user overrides honored) —
 *   never both, never swapped (the plan's failure point #1: a dice script fed
 *   the prompt-script API section or vice versa);
 * - the per-turn CONTEXT PACKAGE (script identity, scope + linked owners, the
 *   LIVE code buffer from the request, trust honesty note, save state) is
 *   rendered THROUGH THE KIND DESCRIPTOR (`kinds/script-kind.ts`), proving the
 *   plugin path with a second kind.
 *
 * PURE INPUT — the history and the context values are FUNCTION INPUT, not
 * store fetches. The caller (the future stream/adapter wiring, AS-8+) loads
 * the script row + link names and passes the LIVE `code` buffer from the
 * request; this module never reads a store (the live-buffer contract — the
 * plan's failure point #3: the model must never be fed stale DB code).
 *
 * The experience assembler's RU-label map and user-flow sections have NO
 * script analog yet (named deviation, surfaced to the owner: the RU map is
 * experience-flavored panel copy; a script-editor label map is AS-8+ material
 * once the host UI exists).
 */

import { dirname } from "node:path";
import {
  estimateTokens,
  planHistoryCompaction,
  setModelHint,
} from "@vibe-tavern/prompt-pipeline";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import type { AgentPlan } from "@vibe-tavern/domain";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
import type { AppDb } from "@vibe-tavern/db";
import { resolveServicePromptText } from "../../service-prompts/service-prompt-resolver.js";
import { renderAgentPlanSection } from "../../agent-plan/agent-plan-prompt.js";
import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import { getServicePromptAssetFile } from "../../service-prompts/service-prompt-registry.js";
import {
  resolveBuiltinScriptAgentProfile,
  resolveScriptAgentSkillCatalog,
} from "./script-agent-module.js";
import { renderAgentSkillCatalog } from "../agent-prompt.js";
import { getAgentKindOf } from "../agent-kind-registry.js";
import type { ScriptAgentContext, ScriptAgentContextCard } from "../kinds/script-kind.js";
// Side effect: registers the `script` kind so the descriptor path below
// resolves in ANY process that assembles a prompt (tests included — they do
// not go through server-runtime).
import "../kinds/script-kind.js";
import {
  renderDigestSection,
  estimateHistoryTokens,
  stubHistoricalToolEchoes,
  type AgentHistoryMessage,
  type AgentFlowMessage,
} from "../agent-prompt.js";

// ─── Input / result ──────────────────────────────────────────────────────────

export interface ScriptAgentAssembleInput {
  /** The agent message history (oldest → newest). */
  readonly history: readonly AgentHistoryMessage[];
  /** Model id for the token-counting hint. */
  readonly model?: string;
  /** Context budget for history compaction; null/undefined opts out. */
  readonly contextBudget?: number | null;
  /** Tokens reserved for the response (subtracted from the history budget). */
  readonly responseReserve?: number;
  /** The script's display name. */
  readonly scriptName: string;
  /** Which runtime this script targets — selects the API-knowledge section. */
  readonly scriptKind: "prompt" | "dice";
  /** The script's scope ("global" | "entity" | "chat"). */
  readonly scopeType: string;
  /** The linked owners' display names (resolved by the caller from links). */
  readonly ownerNames: readonly string[];
  /** The full character/persona cards for the context package (every linked
   *  owner plus the request's build-panel character/persona; the caller
   *  resolves them — see `ScriptAgentContextCard`). */
  readonly cards?: readonly ScriptAgentContextCard[];
  /**
   * The CURRENT code — the LIVE buffer from the turn's request. This is the
   * value the model's `code` working buffer is seeded with and the value the
   * context package shows; a stored-code read belongs to the CALLER's past,
   * never here.
   */
  readonly code: string;
  /** Trust flag (see `isScriptAuthoringTrusted`) — drives the honesty note. */
  readonly codeTrusted: boolean;
  /** Whether the live code buffer is saved (rendered only when defined). */
  readonly codeSaved?: boolean;
  /** The RESOLVED agent profile for this thread. When omitted, the built-in
   *  `script` seed resolves internally (the fixed module behavior). */
  readonly profile?: CopilotProfile;
  /** Optional user-skill root for the two-root catalog scan. */
  readonly skillUserRoot?: string;
  /** CX-3: the rendered pinned-context block, injected with the recency anchor. */
  readonly attachedContextBlock?: string;
  /** The script-owned durable plan (rendered as a system section when set). */
  readonly plan?: AgentPlan | null;
  /** Optional DB handle — present ⇒ the `script`/`dice_script` service prompts
   *  resolve through the active service-prompt profile (user overrides). */
  readonly db?: AppDb;
}

/** One message in the final assembled prompt (system + compacted history). */
export type ScriptAgentPromptMessage =
  | { role: "system"; content: string }
  | AgentFlowMessage;

export interface ScriptAgentAssembleResult {
  /** The full system message (base prompt + skill catalog + API reference + digest + plan + context package). */
  readonly systemMessage: string;
  /** Messages for the AI SDK `streamText`/`generateText`: `[systemMessage, ...compactedHistory]`. */
  readonly messages: ReadonlyArray<ScriptAgentPromptMessage>;
  /** Segmented token accounting (CM-3): `system` (without the digest section),
   *  `digest`, `history`, `attached` (pinned block + anchor; 0 when nothing
   *  pinned), and `total` (their sum). */
  readonly tokenAccounting: {
    readonly system: number;
    readonly digest: number;
    readonly history: number;
    readonly attached: number;
    readonly total: number;
  };
  /** Compaction summary when history was budget-trimmed; undefined otherwise. */
  readonly compactionSummary?: string;
  /** Skill roots derived from the resolved catalog — the stream passes these to
   *  the tool builder so `read_skill_file` resolves against the same root the
   *  catalog was built from. Empty when no skills are available. */
  readonly skillRoots: readonly string[];
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/**
 * Assemble the script-agent prompt. Pure — all state comes in through
 * {@link ScriptAgentAssembleInput}; no store access. Mirrors the experience
 * assembler's cache-friendly section order (#16): STABLE prefix (base prompt +
 * skill catalog + the kind-matched API reference) first, VOLATILE tail (digest
 * → plan → context package) last.
 */
export async function assembleScriptAgentPrompt(
  input: ScriptAgentAssembleInput,
): Promise<ScriptAgentAssembleResult> {
  if (input.model !== undefined) setModelHint(input.model);

  // ── Resolve profile + skill catalog + the kind-matched API reference ──────
  // The API-knowledge service-prompt key is chosen BY THE SCRIPT KIND — the
  // single dispatch point (failure point #1): a dice script gets
  // `dice_script`, a prompt script gets `script`, never both, never swapped.
  const apiField: ServicePromptFieldKey = input.scriptKind === "dice" ? "dice_script" : "script";
  const profile = input.profile ?? (await resolveBuiltinScriptAgentProfile(input.db));
  const resolveRef = (field: ServicePromptFieldKey) =>
    input.db
      ? resolveServicePromptText(input.db, field)
      : loadPromptAsset(getServicePromptAssetFile(field));
  const [allSkills, apiReference] = await Promise.all([
    resolveScriptAgentSkillCatalog(input.skillUserRoot),
    resolveRef(apiField),
  ]);
  const skillCatalogBlock = renderAgentSkillCatalog(allSkills.entries);
  const basePrompt = profile.basePrompt;
  const skillRoots = [...new Set(allSkills.entries.map((e) => dirname(e.skillDir)))];

  // ── Context package THROUGH THE KIND DESCRIPTOR (the plugin path) ─────────
  const contextPackage = getAgentKindOf<ScriptAgentContext>("script").renderContextPackage({
    scriptName: input.scriptName,
    scriptKind: input.scriptKind,
    scopeType: input.scopeType,
    ownerNames: input.ownerNames,
    cards: input.cards ?? [],
    code: input.code,
    codeTrusted: input.codeTrusted,
    codeSaved: input.codeSaved,
  });
  const recencyAnchorText = getAgentKindOf<ScriptAgentContext>("script").recencyAnchorText;
  const planSection = renderAgentPlanSection(input.plan ?? null);

  // ── Lift digest messages out of the history flow (CM-3) ───────────────────
  const digestMessages = input.history.filter((m) => m.role === "digest");
  const lastDigest = digestMessages.length > 0 ? digestMessages[digestMessages.length - 1] : null;
  const digestText = lastDigest !== null && lastDigest.role === "digest" ? lastDigest.content : null;
  const historyFlow: AgentFlowMessage[] = input.history.filter(
    (m): m is AgentFlowMessage => m.role !== "digest",
  );
  const digestSectionText = digestText !== null ? renderDigestSection(digestText) : "";

  // ── Assemble the system message (stable prefix, volatile tail) ────────────
  const stableSections: string[] = [basePrompt];
  if (skillCatalogBlock) {
    stableSections.push("", skillCatalogBlock);
  }
  stableSections.push(
    "",
    input.scriptKind === "dice"
      ? "# Dice-script API reference (the `context.dice` runtime — reference material; use the tools above to propose edits, do NOT output raw code in chat)"
      : "# Prompt-script API reference (the `context` channels — reference material; use the tools above to propose edits, do NOT output raw code in chat)",
    "",
    apiReference,
  );
  const volatileNoDigest: string[] = [];
  if (planSection) {
    volatileNoDigest.push("", planSection);
  }
  volatileNoDigest.push("", contextPackage);
  const systemWithoutDigest = [...stableSections, ...volatileNoDigest].join("\n");
  const systemMessage = digestSectionText
    ? [...stableSections, "", digestSectionText, ...volatileNoDigest].join("\n")
    : systemWithoutDigest;

  const systemTokens = estimateTokens(systemWithoutDigest);
  const digestTokens = digestSectionText ? estimateTokens(digestSectionText) : 0;
  const attachedTokens = input.attachedContextBlock
    ? estimateTokens(input.attachedContextBlock) + estimateTokens(recencyAnchorText)
    : 0;

  // ── Budget-based compaction (tool-pair-safe) ──────────────────────────────
  const fullHistory = stubHistoricalToolEchoes(historyFlow);
  const nonHistoryTokens = systemTokens + digestTokens + attachedTokens;
  const plan = planHistoryCompaction({
    messages: fullHistory,
    nonHistoryTokens,
    contextBudget: input.contextBudget,
    responseReserve: input.responseReserve,
    countHistoryTokens: estimateHistoryTokens,
  });
  const recentMessages = plan ? plan.messages : fullHistory;

  const recentHistoryTokens = estimateHistoryTokens(recentMessages);
  const totalTokenEstimate = systemTokens + digestTokens + attachedTokens + recentHistoryTokens;

  let compactionSummary: string | undefined;
  if (plan) {
    compactionSummary =
      `Kept ${recentMessages.length} of ${fullHistory.length} recent messages ` +
      `(budget-trimmed to ~${plan.preservedHistoryTokens} tokens, budget=${input.contextBudget}, reserve=${input.responseReserve}).`;
  }

  // ── Final messages (system + compacted history + CX-3 injected block) ─────
  const messages: ScriptAgentPromptMessage[] = [{ role: "system", content: systemMessage }, ...recentMessages];
  if (input.attachedContextBlock) {
    const lastMessage = messages[messages.length - 1];
    const insertAt = lastMessage && lastMessage.role === "user" ? messages.length - 1 : messages.length;
    messages.splice(
      insertAt,
      0,
      { role: "user", content: input.attachedContextBlock },
      { role: "user", content: recencyAnchorText },
    );
  }

  return {
    systemMessage,
    messages,
    tokenAccounting: {
      system: systemTokens,
      digest: digestTokens,
      history: recentHistoryTokens,
      attached: attachedTokens,
      total: totalTokenEstimate,
    },
    ...(compactionSummary !== undefined ? { compactionSummary } : {}),
    skillRoots,
  };
}
