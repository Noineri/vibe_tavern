/**
 * The agent-kind DESCRIPTOR — the general, experience-agnostic contract a
 * copilot-like authoring agent registers into the agent-kind registry
 * (AGENT_SHELL_PLAN, Wave 1 / AS-2a). A "kind" is a whole agent species
 * (today: the experience copilot; later: the script agent, AS-7), NOT a
 * per-instance profile: the descriptor carries only species-level facts.
 * Buffers / tool builders / prompt rendering arrive as FUNCTIONS in AS-2b/2c
 * and are deliberately absent here — a field is added only when a second kind
 * can already be expressed through it (no "generic" field that secretly
 * carries experience semantics).
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
 * One agent species. All fields are species-level; per-experience (or
 * per-script) variation lives in the copilot profiles, not here.
 */
export interface AgentKind {
  /** Stable kind id used as the registry key. */
  readonly id: AgentKindId;
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
   * Which skills root feeds this kind's skill catalog — the subdirectory name
   * under the data dir (`<dataDir>/<skillRootId>/skills`) and the matching
   * assets root. Known values are suggested, others stay assignable so a
   * future kind registers without touching this file.
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
}
