/**
 * Script-agent module definition + skill-catalog + trust wiring
 * (AGENT_SHELL_PLAN, Wave 3 / AS-7).
 *
 * The `script` agent kind's species-level machinery, mirroring the experience
 * copilot's `experience-copilot-module.ts` shape: a fixed authoring mode
 * definition (base prompt asset + declarative tool set), an OWN skill root
 * (`assets/agent-script/skills/` — intentionally an empty catalog today, so
 * the root is located through a README locator instead of a bundled SKILL.md),
 * the builtin profile seed (projected through the wire-contract tool keys),
 * and the SINGLE derivation of the script-trust flag the kind's assembly and
 * tools both consume (see {@link isScriptAuthoringTrusted}).
 *
 * The kind DESCRIPTOR itself (registry registration + the context package)
 * lives in `domain/agent/kinds/script-kind.ts`; the prompt assembly in
 * `script-agent-prompt.ts`; the tools in `script-agent-tools.ts` — the same
 * file split the experience species has.
 */

import { dirname, resolve } from "node:path";
import type { ScriptOrigin } from "@vibe-tavern/db";
import { loadPromptAsset, resolvePromptAssetPath } from "../../../shared/prompt-asset-loader.js";
import type { AppDb } from "@vibe-tavern/db";
import { resolveServicePrompt } from "../../service-prompts/service-prompt-resolver.js";
import { buildSkillCatalog, type ScanRoot, type SkillCatalogEntry } from "../../coauthor/skills/skill-scanner.js";
import {
  SCRIPT_AGENT_TOOL_KEYS,
  type CopilotProfile,
  type ScriptAgentToolSet,
} from "@vibe-tavern/api-contracts";

// ─── Module definition (metadata only — the prompt text loads lazily) ───────

/**
 * The fixed script-authoring mode. Mirrors `ExperienceCopilotModuleDef` minus
 * the experience-specific fields: one base prompt asset, a declarative tool set
 * (`read_skill_file` rides on top always-on, mirroring the Co-Author/copilot
 * convention), no `todo` (the script kind wires no thread-session checklist).
 * `scriptKind`-specific API knowledge is NOT here — the assembly resolves the
 * `script` / `dice_script` service prompts per thread so user overrides apply.
 */
export interface ScriptAgentModuleDef {
  /** Stable id ("script-authoring"). */
  readonly id: string;
  /** Human-readable mode name (admin/introspection only). */
  readonly name: string;
  readonly description: string;
  /** Asset path (relative to the prompt-asset root) holding the base prompt. */
  readonly basePromptFile: string;
  /** Tools enabled by default (`read_skill_file` always rides on top). */
  readonly toolSet: Record<string, boolean>;
}

export const SCRIPT_AGENT_MODULE: ScriptAgentModuleDef = {
  id: "script-authoring",
  name: "Script Authoring",
  description:
    "The agent mode for authoring and fixing Vibe Tavern prompt and dice scripts. Proposes code edits via the single `code` buffer, runs the script's own test, and never pastes whole files into chat.",
  basePromptFile: "agent-script/base.md",
  toolSet: {
    write_buffer: true,
    edit_buffer: true,
    run_script_test: true,
    plan: true,
    read_plan: true,
    ask_user: true,
  },
};

// ─── Skill catalog (own root, isolated from every other agent's skills) ──────

/**
 * The manifest used to LOCATE the script-agent skills root. The catalog is
 * intentionally EMPTY today (the plan rules an empty catalog valid), so the
 * locator is the root's README stub rather than a bundled SKILL.md — it rides
 * the same candidate ladder {@link resolvePromptAssetPath} uses for every
 * prompt asset (source assets → exe-adjacent → out), keeping a single source
 * of truth for asset location.
 */
const SCRIPT_AGENT_SKILLS_LOCATOR = "agent-script/skills/README.md";

/** Resolve the built-in script-agent skills root (…/assets/agent-script/skills). */
export async function resolveScriptAgentSkillsRoot(): Promise<string> {
  const locator = await resolvePromptAssetPath(SCRIPT_AGENT_SKILLS_LOCATOR);
  // locator = <root>/README.md → climb once to the skills directory itself.
  return dirname(locator);
}

/**
 * Resolve the script-agent user (writable) skills root from a data directory:
 * `<dataDir>/agent-script/skills` — named after the built-in asset root, the
 * same relation `resolveCopilotUserSkillsRoot` has to `experience-copilot`.
 * The directory is NOT created here; a missing root scans as empty.
 */
export function resolveScriptAgentUserSkillsRoot(dataDir: string): string {
  return resolve(dataDir, "agent-script/skills");
}

/**
 * Scan the script-agent skill roots and return the merged catalog (built-in
 * root always; the optional user root with user > built-in precedence — the
 * same scanner + merge every other agent kind uses).
 */
export async function resolveScriptAgentSkillCatalog(
  userRoot?: string,
): Promise<{ readonly entries: readonly SkillCatalogEntry[] }> {
  const root = await resolveScriptAgentSkillsRoot();
  const roots: ScanRoot[] = [{ path: root, source: "builtin" }];
  if (userRoot !== undefined) roots.push({ path: userRoot, source: "user" });
  const { entries } = await buildSkillCatalog(roots);
  return { entries };
}

// ─── Script trust (SCRIPT_SAFETY_PLAN decisions 2/8/10/13) ─────────────────

/**
 * The single derivation of the script-trust flag for agent code execution:
 * a script is TRUSTED unless it was IMPORTED and has never been enabled
 * (`origin === "imported" && firstEnabledAt === null`) — the first explicit
 * enable through the import-warning flow is the trust moment, and an in-app
 * script is trusted from creation.
 *
 * Consumers today: the script agent's assembly (context package honesty note)
 * and its tools (`run_script_test` fail-closed refusal). The same expression
 * is inlined in the script adapter (route-level test gate + reviewed-source
 * gate) and the experience copilot stream — migrating THOSE onto this helper
 * is an AS-10 cleanup candidate (surfaced per the third-derivation rule; this
 * helper is the single source for every NEW consumer).
 */
export function isScriptAuthoringTrusted(script: {
  readonly origin: ScriptOrigin;
  readonly firstEnabledAt: string | null;
}): boolean {
  return script.origin !== "imported" || script.firstEnabledAt !== null;
}

// ─── Built-in profile seed (AS-7; see resolveBuiltinCopilotProfile) ──────────

/**
 * Project {@link SCRIPT_AGENT_MODULE} + its loaded `base.md` into the
 * read-only built-in `script` profile seed — the exact shape of the experience
 * seed (`resolveBuiltinCopilotProfile("experience")`): stable `"builtin"` id,
 * `isBuiltIn: true`, tool set projected through {@link SCRIPT_AGENT_TOOL_KEYS}
 * so the wire contract stays the single source of truth for toggleable-tool
 * names, `agentKind: "script"`. SP-5 parity: the global service-prompt
 * profile's `script_agent_base` override replaces the base ONLY on this
 * builtin path (explicit per-script profiles never consult it).
 *
 * Reached through `resolveBuiltinCopilotProfile("script", db)` in
 * experience-copilot-module.ts (the seed dispatch point AS-3 stubbed for this
 * kind); kept HERE so the script species owns its seed the way the experience
 * module owns its own.
 */
export async function resolveBuiltinScriptAgentProfile(db?: AppDb): Promise<CopilotProfile> {
  const basePrompt = db
    ? (await resolveServicePrompt(db, "script_agent_base")).text
    : await loadPromptAsset(SCRIPT_AGENT_MODULE.basePromptFile);
  const toolSet: ScriptAgentToolSet = {};
  for (const key of SCRIPT_AGENT_TOOL_KEYS) {
    if (SCRIPT_AGENT_MODULE.toolSet[key] === true) toolSet[key] = true;
  }
  return {
    id: "builtin",
    name: SCRIPT_AGENT_MODULE.name,
    isBuiltIn: true,
    basePrompt,
    toolSet,
    agentKind: "script",
  };
}
