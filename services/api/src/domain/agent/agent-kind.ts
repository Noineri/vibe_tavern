/**
 * The agent-kind DESCRIPTOR — the general, experience-agnostic contract a
 * copilot-like authoring agent registers into the agent-kind registry
 * (AGENT_SHELL_PLAN, Wave 1 / AS-2a). A "kind" is a whole agent species
 * (today: the experience copilot; later: the script agent, AS-7), NOT a
 * per-instance profile: the descriptor carries only species-level facts.
 * Buffers / tool builders arrive as FUNCTIONS in AS-2c and are deliberately
 * absent here — a field is added only when a second kind can already be
 * expressed through it (no "generic" field that secretly carries experience
 * semantics). The ONE function carried today is `renderContextPackage`
 * (AS-2b): the per-turn context package is kind-owned prose, so the generic
 * assembly delegates to the descriptor instead of rendering it itself.
 *
 * Registry contract (this file is pure types — see agent-kind-registry.ts):
 * a kind module builds one descriptor and self-registers it at module init;
 * routes resolve kind-by-script-kind through the registry and never hold a
 * kind map of their own.
 */

import type { ZodType } from "zod";
import type { ScriptKind } from "@vibe-tavern/domain";

/**
 * Stable kind id ("experience" today; "script" registers in AS-7). Plain
 * string for now — branding happens when the plan's ID pass requires it.
 */
export type AgentKindId = string;

/**
 * Who owns a kind's threads (SIDECHAT_PLAN SC-0b): `"script"` — threads are
 * born from a script row and the kind is DERIVED from it
 * (`resolveKindForScript`); `"chat"` — threads are owned by a chat branch and
 * the kind is stored on the thread row itself (there is nothing to derive it
 * from). Decides which lifecycle routes serve the kind: the script-owner
 * routes reject a chat-owned kind (`AGENT_KIND_NOT_CHAT_OWNED`) and the
 * chat-owner routes reject a script-owned one, so a kind never serves both
 * lifecycles by accident.
 */
export type AgentKindOwner = "script" | "chat";

/**
 * One agent species. Generic over the kind's OWN context-package input
 * `CTX` — OPAQUE to the core (the registry stores `AgentKind<unknown>`;
 * callers narrow via `getAgentKindOf<CTX>`). No shared `AgentKindContext`
 * shape exists yet: it arrives with AS-2c's request/deps carve, and
 * speculative empty shapes are banned (AS-2a design note). All fields are
 * species-level; per-experience (or per-script) variation lives in the
 * copilot profiles, not here.
 */
export interface AgentKind<CTX = unknown> {
  /** Stable kind id used as the registry key. */
  readonly id: AgentKindId;
  /**
   * Which owner this kind's threads belong to (SC-0b) — see
   * {@link AgentKindOwner}. Species-level like every other field here: the
   * chat-owner lifecycle routes read it through the registry to reject a
   * kind that is not chat-owned.
   */
  readonly owner: AgentKindOwner;
  /**
   * Whether a kind with NO settings row of its own inherits the legacy
   * `ui_settings` copilot provider/model pair (SC-7, owner decision 2
   * corrected 2026-10-19): ONLY the two kinds that existed before per-kind
   * settings split off (`experience`, `script`) keep that read-time fallback
   * and the first-insert seed — their users chose a model before kinds
   * existed. Every later kind reads nulls when it has no row, so its host's
   * `defaultModelBinding` is actually consulted. This field is the ONE
   * source of the fact; `packages/db` cannot import it (dependency graph),
   * so the store takes it as a per-call option the services/api callers
   * populate from the descriptor.
   */
  readonly inheritsLegacyCopilotPair: boolean;
  /**
   * Which script kinds this species serves — the DATA behind
   * `resolveKindForScript()`: the registry returns the first REGISTERED kind
   * whose `servesScriptKinds` contains the requested script kind, so the
   * script-kind → agent-kind mapping is declared by kinds, not hardcoded in
   * a switch anywhere.
   */
  readonly servesScriptKinds: readonly ScriptKind[];
  /**
   * Service-prompt key whose global override replaces this kind's built-in
   * base prompt on the builtin-profile path (see service-prompt-resolver;
   * "copilot_base" for experience).
   */
  readonly basePromptServiceKey: string;
  /**
   * A descriptor LABEL for the kind's skill roots — nothing reads it yet. The
   * live roots are resolved per kind in the kind's own module (the script
   * kind's in script-agent-module.ts: assets/agent-script/skills +
   * <dataDir>/agent-script/skills — NOT `<dataDir>/script/skills`). Known
   * values are suggested, others stay assignable so a future kind registers
   * without touching this file.
   */
  readonly skillRootId: "experience" | "script" | (string & {});
  /**
   * Validates a persisted/incoming tool set for this kind. `.strict()` object
   * schemas (the house pattern, cf. copilotToolSetSchema) so an unknown tool
   * key is rejected rather than silently stripped. Typed over a partial
   * boolean record: tool sets store only enabled keys.
   */
  readonly toolSetSchema: ZodType<Record<string, boolean | undefined>>;
  /**
   * The kind's default tool set: exactly the keys the species enables by
   * default, projected through the kind's own wire-contract tool keys.
   */
  readonly defaultToolSet: Readonly<Record<string, boolean>>;
  /**
   * The kind's recency-anchor text (CX-3 pattern): a SHORT user-role reminder
   * injected immediately after the kind's attached-context block, before the
   * final user message — it keeps pinned reference data from being read as
   * instructions. The WORDING is kind-owned copy (the anchor's whole value is
   * its phrasing); the generic assembly reads it from here, and kinds that pin
   * no context simply never have it injected.
   */
  readonly recencyAnchorText: string;
  /**
   * Render the kind's per-turn context package — the volatile system-message
   * section that mirrors the author's CURRENT working state (buffers,
   * discovered contract, test feedback, authoring step). The `ctx` shape is
   * KIND-OWNED and opaque here; the experience assembly (AS-2b) calls it via
   * `getAgentKindOf<CTX>("…").renderContextPackage(ctx)` instead of rendering
   * the context itself — proving the plugin path works end-to-end inside one
   * kind before a second kind registers.
   */
  renderContextPackage(ctx: CTX): string;
}
