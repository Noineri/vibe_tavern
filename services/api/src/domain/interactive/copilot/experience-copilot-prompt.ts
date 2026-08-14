/**
 * Experience-Copilot prompt assembly (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 2 / ER-5; module + skill wiring Wave 6 / ER-16).
 *
 * Builds the system message + compacted message-history the copilot model sees
 * each turn. ADAPTED from {@link assembleCoauthorPrompt} (same assembly shape —
 * system message + compacted history), but with copilot-specific input/result
 * types because the copilot is a STANDALONE editor-embedded subsystem, NOT a
 * chat-mode — it does NOT reuse {@link ChatModeAssembleInput} /
 * {@link ChatModeAssembleResult} from `chat-mode-strategy.ts`.
 *
 * PURE INPUT — the message history and the context package are FUNCTION INPUT,
 * not a DB/store fetch. This makes the module unit-testable without a store: a
 * test feeds 30 messages and asserts compaction. The ER-6 endpoint fetches the
 * history via the ER-3 {@link ExperienceCopilotStore} and passes it in; this
 * module never touches a store.
 *
 * The copilot PROPOSES edits (`write_buffer`/`edit_buffer`), can self-test
 * (`run_test`/`run_simulate`), and NEVER binds — binding is the user's action
 * via the BE-6 endpoints. The system message is assembled from: the module's
 * base-prompt asset (ER-16 — role + tool mechanics + key constraints, loaded
 * live from `experience-copilot/base.md`), the resolved skill catalog (ER-16 —
 * the on-demand `read_skill_file` channel), the per-turn context package, and
 * BOTH API contracts so the model can author either buffer correctly: the rules
 * DSL (`interactive-rules.md`, `context.experience.register({...})`) and the
 * host↔visual bridge (`interactive-visual.md`, the `VibeExperience` SDK).
 *
 * History compaction: `HISTORY_LIMIT = 20` caps the recent window (tool-pair-
 * safe via {@link findSafeCompactionBoundary}); {@link planHistoryCompaction}
 * then budget-trims within that window, preserving tool-call/tool-result pairs
 * (the prompt-pipeline compaction invariant — never split a tool call from its
 * result).
 */

import { dirname } from "node:path";
import {
  estimateTokens,
  findSafeCompactionBoundary,
  planHistoryCompaction,
  setModelHint,
} from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
import { runExperienceTest } from "../experience-tester.js";
import type {
  ExperienceCopilotRunSimulateDigest,
  ExperienceCopilotRunTestDigest,
} from "./experience-copilot-tools.js";
import {
  resolveBuiltinCopilotProfile,
  resolveExperienceCopilotSkillCatalog,
  renderExperienceCopilotSkillCatalog,
} from "./experience-copilot-module.js";

/** How many of the most recent history messages to include before budget trimming. */
const HISTORY_LIMIT = 20;

// ─── History message shape (mirrors AI SDK v5/v6 message parts) ──────────────

/** One copilot history message in the AI SDK message shape. Mirrors
 *  coauthor-prompt's `CoauthorHistoryMessage`: tool calls carry `input` (the
 *  parsed args), tool results carry `output` (the SDK v6 discriminated union). */
export type ExperienceCopilotHistoryMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };

// ─── Context-package types ───────────────────────────────────────────────────

/** Metadata-only view of a visual bound to this experience (the caller supplies
 *  this via a BE-6 fetch; the full visual source is NOT injected here). */
export interface ExperienceCopilotBoundVisual {
  readonly id: string;
  readonly name: string;
  /** Visual kind (e.g. the runtime visual-kind discriminator). */
  readonly kind: string;
}

/** A compact summary of the discovered experience definition, derived from the
 *  current rules source via a create-only test run. Omitted when discovery fails
 *  (broken/empty rules) so the model can write rules fresh — never throws. */
export interface ExperienceCopilotContract {
  readonly apiVersion: number;
  readonly manifestId: string;
  readonly manifestName: string;
  readonly declaredCapabilities: readonly string[];
  readonly hasChoose: boolean;
  readonly hasFlavor: boolean;
}

/** The inline 3-step creation flow the user is currently in. */
export type ExperienceCopilotStep = "rules" | "visual" | "test";

/** The latest test/simulate digest the user sent back from the test panel. */
export type ExperienceCopilotTestFeedback =
  | ExperienceCopilotRunTestDigest
  | ExperienceCopilotRunSimulateDigest;

// ─── Input / result ──────────────────────────────────────────────────────────

export interface ExperienceCopilotAssembleInput {
  /** The copilot message history (oldest → newest). The ER-6 endpoint fetches
   *  this via the ER-3 {@link ExperienceCopilotStore} and passes it in. */
  readonly history: readonly ExperienceCopilotHistoryMessage[];
  /** Model id for the token-counting hint. */
  readonly model?: string;
  /** Context budget for history compaction; null/undefined opts out. */
  readonly contextBudget?: number | null;
  /** Tokens reserved for the response (subtracted from the history budget). */
  readonly responseReserve?: number;
  /** The CURRENT rules source at turn start (full text). Drives contract
   *  discovery; surfaces as read-only context for the model. */
  readonly rules: string;
  /** The CURRENT active visual source (full text), if any. */
  readonly visual?: string;
  /** Visuals already bound to this experience, metadata-only (id/name/kind). */
  readonly boundVisuals?: readonly ExperienceCopilotBoundVisual[];
  /** The latest test/simulate digest the user sent back. Optional. */
  readonly testFeedback?: ExperienceCopilotTestFeedback | null;
  /** The current authoring step (inline 3-step creation flow). */
  readonly step: ExperienceCopilotStep;
  /** The RESOLVED copilot profile for this experience (CP-7). When omitted,
   *  the assembler resolves the built-in seed (CP-4) internally — the ER-16
   *  fixed module, so an experience with no assigned profile behaves EXACTLY
   *  as pre-plan (zero behavior change). */
  readonly profile?: CopilotProfile;
  /** Optional copilot user-skill root for the two-root catalog scan (CP-4).
   *  When omitted, only the built-in root is scanned (the pre-plan behavior). */
  readonly skillUserRoot?: string;
}

/** One message in the final assembled prompt (system + compacted history). */
export type ExperienceCopilotPromptMessage =
  | { role: "system"; content: string }
  | ExperienceCopilotHistoryMessage;

export interface ExperienceCopilotAssembleResult {
  /** The full system message (module base prompt + skill catalog + context package + SDK API references). */
  readonly systemMessage: string;
  /** Messages to pass to the AI SDK `streamText`/`generateText`:
   *  `[systemMessage, ...compactedHistory]`. */
  readonly messages: ReadonlyArray<ExperienceCopilotPromptMessage>;
  /** Token accounting for budget tracking. */
  readonly tokenAccounting: {
    readonly total: number;
    readonly recentHistory: number;
  };
  /** Compaction summary when history was windowed or budget-trimmed; undefined
   *  when no history was dropped. */
  readonly compactionSummary?: string;
  /** Skill roots derived from the resolved skill catalog (ER-16) — the stream
   *  passes these to {@link buildExperienceCopilotTools} so the reused
   *  `read_skill_file` tool resolves paths against the same root the catalog was
   *  built from. Empty when no skills are available (reads then reject). */
  readonly skillRoots: readonly string[];
}

// ─── Contract derivation ─────────────────────────────────────────────────────

/** Derive a compact contract summary from the current rules source. Runs a
 *  create-only test (pure — the stateless experience tester); on failure
 *  (broken/empty rules) returns null so the model writes rules fresh. */
function deriveContract(rules: string): ExperienceCopilotContract | null {
  if (!rules.trim()) return null;
  const result = runExperienceTest({ rulesCode: rules, actions: [] });
  if (!result.ok) return null;
  const def = result.data.definition;
  return {
    apiVersion: def.apiVersion,
    manifestId: def.manifest.id,
    manifestName: def.manifest.name,
    declaredCapabilities: def.declaredCapabilities.map((c) => c.capability),
    hasChoose: def.hasChoose,
    hasFlavor: def.hasFlavor,
  };
}

// ─── System-message section renderers ────────────────────────────────────────

// The role framing + tool mechanics + key constraints live in the profile's
// base prompt — the built-in seed loads `experience-copilot/base.md` live each
// turn (ER-16/CP-4), the same live-edit-on-disk property Co-Author modules
// have; an assigned profile supplies its own inline text. The skill catalog
// (the on-demand `read_skill_file` channel) is rendered by
// `renderExperienceCopilotSkillCatalog`.

function renderContextPackage(
  rules: string,
  visual: string | undefined,
  boundVisuals: readonly ExperienceCopilotBoundVisual[] | undefined,
  contract: ExperienceCopilotContract | null,
  testFeedback: ExperienceCopilotTestFeedback | null | undefined,
  step: ExperienceCopilotStep,
): string {
  const sections = [
    "# Current working context",
    `Authoring step: **${step}**`,
  ];

  // Rules buffer
  sections.push("", "## Current rules buffer");
  sections.push(rules.trim() ? "```js\n" + rules + "\n```" : "(empty — help the user write valid rules)");

  // Visual buffer (only when present)
  if (visual !== undefined && visual.trim()) {
    sections.push("", "## Current visual buffer", "```js\n" + visual + "\n```");
  }

  // Bound visuals (metadata only)
  if (boundVisuals && boundVisuals.length > 0) {
    sections.push(
      "",
      "## Bound visuals (metadata only — the user binds these; you cannot)",
      ...boundVisuals.map((v) => `- **${v.name}** (kind: ${v.kind}) [id: \`${v.id}\`]`),
    );
  }

  // Contract (discovered definition)
  if (contract !== null) {
    sections.push(
      "",
      "## Discovered experience definition",
      `- manifest: **${contract.manifestName}** (id: \`${contract.manifestId}\`)`,
      `- apiVersion: ${contract.apiVersion}`,
      `- capabilities: ${contract.declaredCapabilities.length > 0 ? contract.declaredCapabilities.join(", ") : "(none)"}`,
      `- choose method: ${contract.hasChoose ? "present" : "absent"}`,
      `- flavor method: ${contract.hasFlavor ? "present" : "absent"}`,
    );
  } else {
    sections.push(
      "",
      "## Discovered experience definition",
      "(discovery failed or rules are empty — the user may be starting fresh; help them write a valid rules package)",
    );
  }

  // Test feedback (the latest digest the user sent back from the test panel)
  if (testFeedback) {
    sections.push(
      "",
      "## Latest test feedback (sent by the user from the test panel)",
      "```json",
      JSON.stringify(testFeedback),
      "```",
    );
  }

  return sections.join("\n");
}

// ─── History token estimation ────────────────────────────────────────────────

function formatHistoryMessages(messages: ReadonlyArray<ExperienceCopilotHistoryMessage>): string {
  return messages.map((message) => {
    const content = message.role === "tool"
      ? JSON.stringify(message.content)
      : `${message.content || ""}${message.toolCalls ? JSON.stringify(message.toolCalls) : ""}`;
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
}

function estimateHistoryTokens(messages: ReadonlyArray<ExperienceCopilotHistoryMessage>): number {
  return estimateTokens(formatHistoryMessages(messages));
}

// ─── Assembler ───────────────────────────────────────────────────────────────

/**
 * Assemble the experience-copilot prompt. Pure — all state comes in through
 * {@link ExperienceCopilotAssembleInput}; no store access. Returns the system
 * message + compacted history ready for the AI SDK `streamText`/`generateText`,
 * plus the skill roots the stream forwards to the tool builder.
 *
 * Compaction has two layers: (1) the history is windowed to the last
 * {@link HISTORY_LIMIT} messages (tool-pair-safe via
 * {@link findSafeCompactionBoundary}); (2) {@link planHistoryCompaction} then
 * budget-trims within that window, preserving tool-call/tool-result pairs.
 */
export async function assembleExperienceCopilotPrompt(
  input: ExperienceCopilotAssembleInput,
): Promise<ExperienceCopilotAssembleResult> {
  if (input.model !== undefined) setModelHint(input.model);

  // ── Derive contract from current rules (pure create-only test) ─────────────
  const contract = deriveContract(input.rules);

  // ── Resolve profile + skill catalog + the canonical API refs ────────────────
  // The profile supplies the base prompt (role + tool mechanics + key
  // constraints, loaded live from its base-prompt source) and gates the skill
  // catalog by its `skillIds`. Defaulting to the built-in seed keeps the
  // no-profile path byte-identical to the ER-16 module. The catalog is scanned
  // from the built-in root plus the optional user root (CP-4); the two API
  // references (rules DSL + visual bridge) load alongside so all asset I/O fans
  // out together.
  const profile = input.profile ?? await resolveBuiltinCopilotProfile();
  const [allSkills, rulesReference, visualReference] = await Promise.all([
    resolveExperienceCopilotSkillCatalog(input.skillUserRoot),
    loadPromptAsset("interactive-rules.md"),
    loadPromptAsset("interactive-visual.md"),
  ]);
  // The profile's skillIds GATE the catalog — only enabled skills are listed
  // and only their roots are exposed to `read_skill_file`. The built-in seed
  // enables ["experience-authoring"], so its catalog is unchanged.
  const skillCatalog = allSkills.entries.filter((e) => profile.skillIds.includes(e.id));
  const basePrompt = profile.basePrompt;
  const skillCatalogBlock = renderExperienceCopilotSkillCatalog(skillCatalog);
  // Derive the skill roots from the catalog entries' skill dirs so
  // `read_skill_file` (built in the stream from this result) resolves paths
  // against the same root the catalog was built from. Empty when no skills are
  // available (reads then reject; the other tools work fully).
  const skillRoots = [...new Set(skillCatalog.map((e) => dirname(e.skillDir)))];

  // ── Build the context-package section ──────────────────────────────────────
  const contextPackage = renderContextPackage(
    input.rules,
    input.visual,
    input.boundVisuals,
    contract,
    input.testFeedback ?? null,
    input.step,
  );

  // ── Assemble the system message ────────────────────────────────────────────
  const sections: string[] = [basePrompt];
  if (skillCatalogBlock) {
    sections.push("", skillCatalogBlock);
  }
  sections.push(
    "",
    contextPackage,
    "",
    "# Experience rules API reference (the `context.experience.register({...})` DSL — reference material; use the tools above to propose edits, do NOT output raw code in chat)",
    "",
    rulesReference,
    "",
    "# Experience visual API reference (the host↔visual `VibeExperience` bridge — reference material for the `visual` buffer; use `write_buffer`/`edit_buffer` to propose, do NOT output raw code in chat)",
    "",
    visualReference,
  );
  const systemMessage = sections.join("\n");

  // ── Window to HISTORY_LIMIT (tool-pair-safe) ───────────────────────────────
  const fullHistory = [...input.history];
  const windowedFrom = fullHistory.length > HISTORY_LIMIT
    ? findSafeCompactionBoundary(fullHistory, HISTORY_LIMIT)
    : 0;
  const windowed = fullHistory.slice(windowedFrom);

  // ── Budget-based compaction within the window ──────────────────────────────
  const nonHistoryTokens = estimateTokens(systemMessage);
  const plan = planHistoryCompaction({
    messages: windowed,
    nonHistoryTokens,
    contextBudget: input.contextBudget,
    responseReserve: input.responseReserve,
    countHistoryTokens: estimateHistoryTokens,
  });
  const recentMessages = plan ? plan.messages : windowed;

  const recentHistoryTokens = estimateHistoryTokens(recentMessages);
  const totalTokenEstimate = nonHistoryTokens + recentHistoryTokens;

  // ── Compaction summary ─────────────────────────────────────────────────────
  let compactionSummary: string | undefined;
  if (windowedFrom > 0 || plan) {
    const parts: string[] = [];
    if (windowedFrom > 0) {
      parts.push(
        `windowed from ${fullHistory.length} to ${windowed.length} (HISTORY_LIMIT=${HISTORY_LIMIT})`,
      );
    }
    if (plan) {
      parts.push(
        `budget-trimmed to ${recentMessages.length} (~${plan.preservedHistoryTokens} tokens, budget=${input.contextBudget}, reserve=${plan.responseReserve})`,
      );
    }
    compactionSummary = `Kept ${recentMessages.length} of ${fullHistory.length} recent messages (${parts.join("; ")}).`;
  }

  // ── Final messages (system + compacted history) ────────────────────────────
  const messages: ExperienceCopilotPromptMessage[] = [
    { role: "system", content: systemMessage },
    ...recentMessages,
  ];

  return {
    systemMessage,
    messages,
    tokenAccounting: {
      total: totalTokenEstimate,
      recentHistory: recentMessages.length,
    },
    ...(compactionSummary !== undefined ? { compactionSummary } : {}),
    skillRoots,
  };
}
