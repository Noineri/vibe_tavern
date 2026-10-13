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
 * AS-2b SPLIT: the GENERIC half of this module (history message shapes, digest
 * boundary, echo stubs, digest-section rendering, token estimation) lives in
 * `domain/agent/agent-prompt.ts` and is re-exported below under the old names
 * for compatibility (AS-10 removes the shims). This file keeps the EXPERIENCE
 * half: the experience input/result types, contract derivation, the recency
 * anchor + RU-voice label map (experience-flavored copy), and the assembler
 * itself. The per-turn CONTEXT PACKAGE is no longer rendered here — the kind
 * descriptor owns it (`kinds/experience-kind.ts`, `renderContextPackage`) and
 * the assembler calls it through the registry (`getAgentKindOf`), proving the
 * descriptor path end-to-end inside one kind.
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
 * History compaction: budget-only ({@link planHistoryCompaction} with the
 * copilot's fixed 300k budget — copilot-limits.ts), preserving tool-call/
 * tool-result pairs (the prompt-pipeline compaction invariant — never split a
 * tool call from its result). A count-based window cap once lived here too;
 * it silently dropped affordable context and was removed (2026-08-19) — the
 * live path always passes a positive constant budget, so it guarded nothing.
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
import { runExperienceTest } from "../experience-tester.js";
import { renderAgentPlanSection } from "../../agent-plan/agent-plan-prompt.js";
import type {
  ExperienceCopilotRealtimeDigest,
  ExperienceCopilotRunSimulateDigest,
  ExperienceCopilotRunTestDigest,
} from "./experience-copilot-tools.js";
import {
  resolveBuiltinCopilotProfile,
  resolveExperienceCopilotSkillCatalog,
  renderExperienceCopilotSkillCatalog,
} from "./experience-copilot-module.js";
// Generic agent primitives (AS-2b) — the moved half of this module. The
// aliased type imports keep this file's body reading the old names.
import {
  renderDigestSection,
  estimateHistoryTokens,
  stubHistoricalToolEchoes,
  type AgentFlowMessage as ExperienceCopilotFlowMessage,
  type AgentHistoryMessage as ExperienceCopilotHistoryMessage,
} from "../../agent/agent-prompt.js";
import { getAgentKindOf } from "../../agent/agent-kind-registry.js";
import type { ExperienceAgentContext } from "../../agent/kinds/experience-kind.js";
// Side effect: registers the `experience` kind so the descriptor path below
// resolves in ANY process that assembles a prompt (tests included — they do
// not go through server-runtime).
import "../../agent/kinds/experience-kind.js";

// ─── Compat aliases (AS-2b) ─────────────────────────────────────────────────
//
// The generic primitives moved to domain/agent/agent-prompt.ts; these
// re-exports keep every existing importer (stream, compaction, tests)
// compiling untouched. AS-10 removes this block.

export {
  resolveDigestBoundary,
  renderDigestSection,
  estimateHistoryTokens,
  stubBufferToolCallInput,
  stubBufferToolResultOutput,
  stubHistoricalToolEchoes,
  BUFFER_ECHO_STUB,
  SKILL_READ_STUB,
  AGENT_DIGEST_ANCHOR_FIELD as COPILOT_DIGEST_ANCHOR_FIELD,
} from "../../agent/agent-prompt.js";
export type {
  DigestBoundaryMessage,
  EchoStubOptions,
  AgentHistoryMessage as ExperienceCopilotHistoryMessage,
  AgentFlowMessage as ExperienceCopilotFlowMessage,
  AgentDigestBoundary as CopilotDigestBoundary,
} from "../../agent/agent-prompt.js";
// AS-2c: the recency-anchor VALUE moved to the kind descriptor
// (kinds/experience-kind.ts, `recencyAnchorText`); this alias keeps the old
// export name for importers/tests, and the assembler below reads the text
// THROUGH THE DESCRIPTOR (same plugin path as the context package).
export {
  EXPERIENCE_RECENCY_ANCHOR_TEXT as COPILOT_RECENCY_ANCHOR_TEXT,
} from "../../agent/kinds/experience-kind.js";

// ─── Russian-voice UI labels ────────────────────────────────────────────────
//
// The system prompt is English, but the user may write (and run their UI) in
// Russian. When their own history carries Cyrillic, the assembly appends a
// compact RU↔EN label map so the model can name panels/buttons the way the
// user sees them. Deliberately NOT a lorebook engine: the single activation
// condition ("does the user speak Russian?") collapses to a cheap scan, so a
// conditional block IS the whole mechanism. Digest content is scanned too — a
// fully-compacted Russian thread still triggers. Tool parts are skipped: tool
// payloads are code/JSON whose stray Cyrillic (comments, flavor strings) says
// nothing about the user's voice.

const CYRILLIC_RE = /[\u0400-\u04FF]/;

function userSpeaksRussian(history: readonly ExperienceCopilotHistoryMessage[]): boolean {
  return history.some((m) => m.role !== "tool" && CYRILLIC_RE.test(m.content));
}

const RU_UI_LABELS_BLOCK = `# UI labels — Russian ↔ English

The user writes in Russian. When naming a UI element in chat, use the label the user sees — Russian when their UI is Russian (or the exact label they quoted). Mapping (Russian = English):

- Steps: «Правила» = Rules · «Внешний вид» = Appearance · «Попробовать» = Try it
- Rules check (Rules toolbar): «Проверить правила» = Validate rules
- Try-it → «Диагностика разработчика» (collapsed by default): «Проверить и создать» = Discover & create · «Автоходы скриптовых мест» = Auto-advance script seats · «Отправить результат помощнику» = Send result to assistant
- Playground (the inline Try-it tab): «Играть» = Play · «Сброс» = Reset · «Перезапустить (настройки те же)» = Restart (same settings) · «Отправить диагностику помощнику» = Send diagnostics to assistant
- Sessions: «Сессия N» = Session N · «Новая сессия» = New session · «В архиве» = Archived · «Переименовать сессию» = Rename session
- Diff review: «Принять» = Accept · «Принять все» = Accept all
- Saving: «Сохранить» = Save (rules) · «Сохранить представление» = Save visual
- Live run (in chat): «Мини-приложение» = Mini-app · «Начать» = Start`;

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
  | ExperienceCopilotRunSimulateDigest
  | ExperienceCopilotRealtimeDigest;

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
  /** SS-4B (decision 13): false while the script is imported and never
   *  enabled — deriveContract is then skipped (no sandbox run) and the
   *  contract section renders an honest skip note. Default true. */
  readonly rulesTrusted?: boolean;
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
  /** CX-3: the rendered pinned-context block (`renderAttachedContext` output).
   *  Injected as TWO transient user-role messages — the block itself, then the
   *  recency anchor — immediately before the final user message. Omitted/empty
   *  → byte-identical assembly to the pre-CX-3 shape (pinned by test). Never
   *  persisted and never compacted: it is injected AFTER compaction, at the
   *  bottom of the prompt (recency), where the model weighs it most. */
  readonly attachedContextBlock?: string;
  /** The script-owned durable plan for this thread. Rendered as a system-message
   *  context section only when non-empty (byte-identical assembly otherwise).
   *  It counts toward systemTokens, so it survives history compaction. */
  readonly plan?: AgentPlan | null;
  /** Optional DB handle — when present, reference prompts resolve via the active service-prompt profile. */
  readonly db?: AppDb;
}

/** One message in the final assembled prompt (system + compacted history). */
export type ExperienceCopilotPromptMessage =
  | { role: "system"; content: string }
  | ExperienceCopilotFlowMessage;

export interface ExperienceCopilotAssembleResult {
  /** The full system message (module base prompt + skill catalog + context package + SDK API references). */
  readonly systemMessage: string;
  /** Messages to pass to the AI SDK `streamText`/`generateText`:
   *  `[systemMessage, ...compactedHistory]`. */
  readonly messages: ReadonlyArray<ExperienceCopilotPromptMessage>;
  /** Segmented token accounting for the context meter (CM-3): `system` (the
   *  system message without the digest section), `digest` (the digest section,
   *  0 when none), `history` (the compacted history), `attached` (the pinned-
   *  context block + recency anchor, CX-3 — 0 when nothing is pinned), and
   *  `total` (their sum). */
  readonly tokenAccounting: {
    readonly system: number;
    readonly digest: number;
    readonly history: number;
    readonly attached: number;
    readonly total: number;
  };
  /** Compaction summary when history was budget-trimmed; undefined
   *  when no history was dropped. */
  readonly compactionSummary?: string;
  /** Skill roots derived from the resolved skill catalog (ER-16) — the stream
   *  passes these to {@link buildExperienceCopilotTools} so the reused
   *  `read_skill_file` tool resolves paths against the same root the catalog was
   *  built from. Empty when no skills are available (reads then reject). */
  readonly skillRoots: readonly string[];
}

// ─── Contract derivation ─────────────────────────────────────────────────────

/** Derive a compact contract summary from the current rules source via a
 *  create-only test (pure); on failure (broken/empty rules) returns null so
 *  the model writes rules fresh. SS-4B: skipped (null, NO test run) while
 *  the script is untrusted — imported code never executes in assembly. */
function deriveContract(rules: string, trusted: boolean): ExperienceCopilotContract | null {
  if (!trusted || !rules.trim()) return null;
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

// ─── System-message sections ─────────────────────────────────────────────────

// The role framing + tool mechanics + key constraints live in the profile's
// base prompt — the built-in seed loads `experience-copilot/base.md` live each
// turn (ER-16/CP-4), the same live-edit-on-disk property Co-Author modules
// have; an assigned profile supplies its own inline text. The skill catalog
// (the on-demand `read_skill_file` channel) is rendered by
// `renderExperienceCopilotSkillCatalog`. The per-turn CONTEXT PACKAGE is
// rendered by the KIND DESCRIPTOR (kinds/experience-kind.ts) — see the
// assembler below.

// ─── Assembler ───────────────────────────────────────────────────────────────

/**
 * Assemble the experience-copilot prompt. Pure — all state comes in through
 * {@link ExperienceCopilotAssembleInput}; no store access. Returns the system
 * message + compacted history ready for the AI SDK `streamText`/`generateText`,
 * plus the skill roots the stream forwards to the tool builder.
 *
 * Compaction is budget-only: {@link planHistoryCompaction} trims the history
 * to the context budget, preserving tool-call/tool-result pairs.
 */
export async function assembleExperienceCopilotPrompt(
  input: ExperienceCopilotAssembleInput,
): Promise<ExperienceCopilotAssembleResult> {
  if (input.model !== undefined) setModelHint(input.model);

  // ── Derive contract from current rules (SS-4B: skipped while untrusted) ──
  const contract = deriveContract(input.rules, input.rulesTrusted !== false);

  // ── Resolve profile + skill catalog + the canonical API refs ────────────────
  // The profile supplies the base prompt ONLY (role + tool mechanics + key
  // constraints, loaded live from its base-prompt source). The skill catalog is
  // UNGATED (PM-8, owner ruling 2026-10-12): everything the scan finds is
  // listed and every scanned root is readable by `read_skill_file` — the
  // catalog carries only id + one-line description (progressive disclosure),
  // so listing all skills is free, and a user-imported skill is usable with
  // the built-in seed profile active (the Co-Author parity the owner ruled).
  // Defaulting to the built-in seed keeps the no-profile path byte-identical
  // to the ER-16 module. The catalog is scanned from the built-in root plus
  // the optional user root (CP-4); the two API references (rules DSL + visual
  // bridge) load alongside so all asset I/O fans out together.
  const profile = input.profile ?? await resolveBuiltinCopilotProfile("experience", input.db);
  const resolveRef = (field: "interactive_rules" | "interactive_visual" | "copilot_user_flow", assetFile: string) =>
    input.db
      ? resolveServicePromptText(input.db, field)
      : loadPromptAsset(assetFile);
  const [allSkills, rulesReference, visualReference, userFlow] = await Promise.all([
    resolveExperienceCopilotSkillCatalog(input.skillUserRoot),
    resolveRef("interactive_rules", "interactive-rules.md"),
    resolveRef("interactive_visual", "interactive-visual.md"),
    // The human-side authoring/testing flow (stepper, diff review, sandbox
    // settings, live run, guiding protocol) — app-universal knowledge, so it
    // loads in the ASSEMBLY (not the profile's base prompt, which user-created
    // profiles snapshot away from base.md).
    resolveRef("copilot_user_flow", "experience-copilot/user-flow.md"),
  ]);
  // The skill catalog is UNGATED (PM-8, owner ruling 2026-10-12): it lists
  // everything the scan found as-is (user > built-in shadowing was already
  // applied by buildSkillCatalog), and every scanned root is exposed to
  // `read_skill_file`. The profile no longer carries `skillIds`.
  const skillCatalog = allSkills.entries;
  const basePrompt = profile.basePrompt;
  const skillCatalogBlock = renderExperienceCopilotSkillCatalog(skillCatalog);
  // Derive the skill roots from the catalog entries' skill dirs so
  // `read_skill_file` (built in the stream from this result) resolves paths
  // against the same root the catalog was built from. Empty when no skills are
  // available (reads then reject; the other tools work fully).
  const skillRoots = [...new Set(allSkills.entries.map((e) => dirname(e.skillDir)))];

  // ── Build the context-package section (THROUGH THE KIND DESCRIPTOR) ───────
  // AS-2b: the context package is kind-owned prose — the assembler passes the
  // same seven values the old local renderContextPackage took, and the
  // descriptor (kinds/experience-kind.ts) renders them. Same data flow as
  // before: the contract is computed HERE (deriveContract stays experience
  // side) and handed in with the buffers/feedback/step.
  const contextPackage = getAgentKindOf<ExperienceAgentContext>("experience").renderContextPackage({
    rules: input.rules,
    visual: input.visual,
    boundVisuals: input.boundVisuals,
    contract,
    rulesTrusted: input.rulesTrusted !== false,
    testFeedback: input.testFeedback,
    step: input.step,
  });
  // AS-2c: the recency anchor reads THROUGH THE KIND DESCRIPTOR (same plugin
  // path as the context package above) — the wording is kind-owned copy.
  const recencyAnchorText = getAgentKindOf<ExperienceAgentContext>("experience").recencyAnchorText;
  const planSection = renderAgentPlanSection(input.plan ?? null);

  // ── Lift digest messages out of the history flow (CM-3) ───────────────────
  // A `digest` message is a compaction summary, not a chat turn. The LAST digest
  // becomes a system-level JSON context section (after the context package); any
  // older digests are dropped entirely (the latest digest already folds their
  // content). The non-digest messages form the history flow for windowing/budget.
  const digestMessages = input.history.filter((m) => m.role === "digest");
  const lastDigest = digestMessages.length > 0 ? digestMessages[digestMessages.length - 1] : null;
  const digestText = lastDigest !== null && lastDigest.role === "digest" ? lastDigest.content : null;
  const historyFlow: ExperienceCopilotFlowMessage[] = input.history.filter(
    (m): m is ExperienceCopilotFlowMessage => m.role !== "digest",
  );
  const digestSectionText = digestText !== null ? renderDigestSection(digestText) : "";

  // ── Assemble the system message (cache-friendly order, #16) ──────────────
  // STABLE prefix first (base prompt + skill catalog + RU label map + user-flow
  // + both API references — all change rarely or never): providers with prefix
  // caching (Anthropic/OpenAI/Gemini/DeepSeek) hit cache on the whole stable
  // block every turn and each tool-loop step. VOLATILE sections go last,
  // rarest-changing first (digest → plan → context package), so the most-
  // mutable content sits at the system message's tail — also maximum recency
  // for the working buffers, which used to sit mid-message and broke the cache
  // on every buffer edit.
  const stableSections: string[] = [basePrompt];
  if (skillCatalogBlock) {
    stableSections.push("", skillCatalogBlock);
  }
  // RU-voice label map (see the Russian-voice section above): part of the
  // STABLE block — it flips at most once per thread (first Cyrillic message).
  if (userSpeaksRussian(input.history)) {
    stableSections.push("", RU_UI_LABELS_BLOCK);
  }
  stableSections.push(
    "",
    userFlow,
    "",
    "# Experience rules API reference (the `context.experience.register({...})` DSL — reference material; use the tools above to propose edits, do NOT output raw code in chat)",
    "",
    rulesReference,
    "",
    "# Experience visual API reference (the host↔visual `VibeExperience` bridge — reference material for the `visual` buffer; use `write_buffer`/`edit_buffer` to propose, do NOT output raw code in chat)",
    "",
    visualReference,
  );
  // Volatile tail: digest (changes only at compaction) → plan (changes when the
  // model updates it) → context package (changes every turn).
  const volatileNoDigest: string[] = [];
  if (planSection) {
    volatileNoDigest.push("", planSection);
  }
  volatileNoDigest.push("", contextPackage);
  const systemWithoutDigest = [...stableSections, ...volatileNoDigest].join("\n");
  const systemMessage = digestSectionText
    ? [...stableSections, "", digestSectionText, ...volatileNoDigest].join("\n")
    : systemWithoutDigest;

  // Segmented token accounting: `system` = the system message WITHOUT the digest
  // section; `digest` = the digest section alone (0 when none). Digest tokens
  // count toward `nonHistoryTokens` for the budget trim (the digest is part of
  // the system message, so the model pays for it against the history budget).
  const systemTokens = estimateTokens(systemWithoutDigest);
  const digestTokens = digestSectionText ? estimateTokens(digestSectionText) : 0;

  // CX-3: the attached block (if any) is also non-history overhead — it is paid
  // every turn regardless of the history window, so the budget trim must see
  // it exactly like system+digest. The anchor's tokens fold into `attached`
  // (it exists only to frame the block — separating them would misattribute).
  const attachedTokens = input.attachedContextBlock
    ? estimateTokens(input.attachedContextBlock) + estimateTokens(recencyAnchorText)
    : 0;

  // ── Budget-based compaction (the only windowing - tool-pair-safe) ────────────────
  // #16: stub superseded tool echoes FIRST — the budget trim and the accounting
  // then see the same history the model window will actually contain.
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

  // ── Compaction summary ─────────────────────────────────────────────────────
  let compactionSummary: string | undefined;
  if (plan) {
    compactionSummary =
      `Kept ${recentMessages.length} of ${fullHistory.length} recent messages ` +
      `(budget-trimmed to ~${plan.preservedHistoryTokens} tokens, budget=${input.contextBudget}, reserve=${plan.responseReserve}).`;
  }

  // ── Final messages (system + compacted history) ────────────────────────────
  // CX-3: when an attached-context block is present, splice TWO transient
  // user-role messages — the block, then the recency anchor — immediately
  // BEFORE the final message when it is user-role (the production shape: the
  // stream appends the trigger message last), else at the tail. Bottom-of-
  // prompt placement = maximum recency for the model's attention. These are
  // NEVER persisted (the stream only stores the real trigger) and are injected
  // AFTER windowing/budget-trim, so they cannot be compacted away.
  const messages: ExperienceCopilotPromptMessage[] = [{ role: "system", content: systemMessage }, ...recentMessages];
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
