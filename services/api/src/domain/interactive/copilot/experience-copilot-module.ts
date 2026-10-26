/**
 * Experience-Copilot module definition + skill-catalog wiring
 * (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 6 / ER-16).
 *
 * The copilot is SINGLE-MODE (one fixed authoring mode, no module modal or
 * switcher in the editor — unlike Co-Author's user-pickable modules). This file
 * is that one mode's DEFINITION, adapted from the Co-Author seed-module pattern
 * ({@link getCoauthorModule}): a base prompt loaded lazily from a `.md` asset +
 * a declarative tool set. "Module" here is a declarative config object the
 * prompt assembler + tool builder consult, NOT a runtime-selectable entity.
 * The mode does NOT pick skills (PM-8, owner ruling 2026-10-12): the catalog is
 * UNGATED — every skill the scan finds is listed and readable, Co-Author-style.
 *
 * The skill system is REUSED wholesale from Co-Author (scanner + catalog +
 * `read_skill_file`), not reimplemented: the copilot simply has its OWN skill
 * root (`assets/experience-copilot/skills/`) so its catalog is isolated from the
 * Co-Author character skills. The two built-in skills today are
 * `experience-authoring` (craft guidance read on demand via `read_skill_file` —
 * progressive disclosure, keeping the system prompt lean) and `grill-me`
 * (adversarial design review of the current experience draft — TAG-11).
 */

import { dirname, resolve } from "node:path";
import { resolvePromptAssetPath, loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
import type { AppDb } from "@vibe-tavern/db";
import { resolveServicePrompt } from "../../service-prompts/service-prompt-resolver.js";
import {
  getAgentKind,
  listAgentKinds,
  UnknownAgentKindError,
} from "../../agent/agent-kind-registry.js";
import {
  buildSkillCatalog,
  type ScanRoot,
  type SkillCatalogEntry,
} from "../../coauthor/skills/skill-scanner.js";
import {
  COPILOT_TOOL_KEYS,
  type CopilotProfile,
  type CopilotToolSet,
} from "@vibe-tavern/api-contracts";
import { BUILTIN_PROFILE_ID, type AgentBuiltinProfileSeed } from "../../agent/agent-kind.js";
import {
  resolveBuiltinScriptAgentProfile,
  SCRIPT_AGENT_BUILTIN_SEEDS,
} from "../../agent/script-agent/script-agent-module.js";
import {
  resolveBuiltinSidechatOocProfile,
  SIDECHAT_OOC_BUILTIN_SEEDS,
} from "../../agent/kinds/sidechat-ooc-kind.js";

// ─── Module definition (metadata only — the prompt text is loaded lazily) ────

/**
 * The fixed copilot authoring mode. Mirrors a Co-Author `SeedModuleDef` minus
 * the multi-module fields the copilot does not use (no `openingMessage` — the
 * copilot shell shows its own placeholder; no user-modules — this is the only
 * mode). `basePromptFile` is resolved to text per turn via {@link loadPromptAsset}
 * (re-reads from disk, so an edit beside the executable is live on the next
 * turn — the same live-edit property Co-Author modules have).
 */
export interface ExperienceCopilotModuleDef {
  /** Stable id ("experience-authoring"). */
  readonly id: string;
  /** Human-readable mode name (admin/introspection only). */
  readonly name: string;
  readonly description: string;
  /** Asset path (relative to the prompt-asset root) holding the base prompt. */
  readonly basePromptFile: string;
  /** Authoring/diagnostic tools enabled for this mode (`read_skill_file` is
   *  always available on top, mirroring Co-Author — it is the universal
   *  read-only skill channel, NOT gated by `toolSet`). */
  readonly toolSet: Record<string, boolean>;
}

export const EXPERIENCE_COPILOT_MODULE: ExperienceCopilotModuleDef = {
  id: "experience-authoring",
  name: "Experience Authoring",
  description:
    "The copilot mode for authoring an interactive experience's rules and visual source. Proposes buffer edits via tools, self-tests, and never binds.",
  basePromptFile: "experience-copilot/base.md",
  toolSet: {
    write_buffer: true,
    edit_buffer: true,
    run_test: true,
    run_simulate: true,
    suggest_visual_binding: true,
    plan: true,
    read_plan: true,
    todo: true,
    ask_user: true,
  },
};

// ─── Module resolution (lazy prompt load) ────────────────────────────────────

/** The resolved module: the def plus the inline base-prompt text (loaded). */
export interface ResolvedExperienceCopilotModule extends ExperienceCopilotModuleDef {
  readonly basePrompt: string;
}

/**
 * Resolve the module's base prompt from disk. {@link loadPromptAsset} re-reads
 * on every call (no process cache), so an edit beside the executable is picked
 * up on the next prompt-assembly turn; the per-turn cost is one small read,
 * negligible next to an LLM call.
 */
export async function resolveExperienceCopilotModule(): Promise<ResolvedExperienceCopilotModule> {
  const basePrompt = await loadPromptAsset(EXPERIENCE_COPILOT_MODULE.basePromptFile);
  return { ...EXPERIENCE_COPILOT_MODULE, basePrompt };
}

// ─── Skill catalog (own root, isolated from Co-Author character skills) ──────

/**
 * The manifest used to LOCATE the copilot skills root. One built-in skill always
 * exists after ER-16, so its manifest is a safe anchor to climb from.
 */
const COPILOT_SKILLS_LOCATOR = "experience-copilot/skills/experience-authoring/SKILL.md";

/**
 * Resolve the copilot skills root via the SAME candidate ladder
 * {@link resolvePromptAssetPath} uses for every prompt asset, then climb from the
 * locator manifest up to its containing `experience-copilot/skills` directory.
 * Keeps a single source of truth for asset location rather than forking it.
 */
export async function resolveExperienceCopilotSkillsRoot(): Promise<string> {
  const locator = await resolvePromptAssetPath(COPILOT_SKILLS_LOCATOR);
  // locator = <root>/experience-authoring/SKILL.md → climb twice to <root>/.
  return dirname(dirname(locator));
}

/**
 * Resolve the copilot user (writable) skills root from a data directory:
 * `<dataDir>/experience-copilot/skills` — the copilot analog of the scanner's
 * `resolveUserSkillsRoot` (which points at `<dataDir>/coauthor/skills`). The
 * directory is NOT created here — creation belongs to import (CP-5); a missing
 * root simply scans as empty.
 */
export function resolveCopilotUserSkillsRoot(dataDir: string): string {
  return resolve(dataDir, "experience-copilot/skills");
}

/**
 * Scan the copilot skill roots and return the merged catalog. Built-in root is
 * always scanned; the optional user root (CP-4/CP-5 — imported user skills) is
 * scanned when provided, with user > built-in precedence via
 * {@link buildSkillCatalog} (the same scanner + precedence merge Co-Author uses).
 */
export async function resolveExperienceCopilotSkillCatalog(
  userRoot?: string,
): Promise<{
  readonly entries: readonly SkillCatalogEntry[];
}> {
  const root = await resolveExperienceCopilotSkillsRoot();
  const roots: ScanRoot[] = [{ path: root, source: "builtin" }];
  if (userRoot !== undefined) roots.push({ path: userRoot, source: "user" });
  const { entries } = await buildSkillCatalog(roots);
  return { entries };
}

// ─── Built-in profile seed (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-4) ─────────

/**
 * The experience kind's built-in seeds (DR-1) — one seed today; the first
 * entry keeps the id `"builtin"` (the stored sentinel). Declared here (the
 * experience seed's species home), read by the kind descriptor
 * (`kinds/experience-kind.ts`), the seed dispatch below and the seed-list
 * helpers — one declaration, one source.
 */
export const EXPERIENCE_BUILTIN_SEEDS: readonly AgentBuiltinProfileSeed[] = [
  { id: BUILTIN_PROFILE_ID, name: EXPERIENCE_COPILOT_MODULE.name },
];

/**
 * The kind's declared built-in seeds (DR-1). Registry-free for the three
 * kinds the dispatch below knows literally — the same property that keeps
 * every existing caller of `resolveBuiltinCopilotProfile` registry-free —
 * and through the registry for any other registered kind
 * (`UnknownAgentKindError` for an unknown one, the same error the dispatch's
 * generic branch throws).
 */
export function builtinCopilotSeeds(kind: string): readonly AgentBuiltinProfileSeed[] {
  if (kind === "experience") return EXPERIENCE_BUILTIN_SEEDS;
  if (kind === "script") return SCRIPT_AGENT_BUILTIN_SEEDS;
  if (kind === "sidechat-ooc") return SIDECHAT_OOC_BUILTIN_SEEDS;
  return getAgentKind(kind).builtinSeeds;
}

/**
 * Whether `profileId` is a built-in seed id OF THIS KIND (DR-1) — the
 * chat-owned resolver's acceptance test. A built-in id of ANOTHER kind is
 * `false` here, so it falls through the resolver chain exactly like a
 * dangling id. An UNKNOWN kind has no built-ins — `false`, not a throw — so
 * its stored ids keep resolving through the row paths exactly as before;
 * the chain's final seed hop still throws `UnknownAgentKindError` where it
 * always did.
 */
export function isBuiltinCopilotProfileOfKind(profileId: string, kind: string): boolean {
  try {
    return builtinCopilotSeeds(kind).some((seed) => seed.id === profileId);
  } catch (err) {
    if (err instanceof UnknownAgentKindError) return false;
    throw err;
  }
}

/**
 * Whether `profileId` names a built-in seed of ANY known kind (DR-1) — the
 * read-only guard the profile adapter's update/delete run, widened from the
 * single `"builtin"` sentinel to every declared seed id. Covers the three
 * literal kinds registry-free plus every registered kind's list.
 */
export function isBuiltinCopilotProfileId(profileId: string): boolean {
  return (
    isBuiltinCopilotProfileOfKind(profileId, "experience") ||
    isBuiltinCopilotProfileOfKind(profileId, "script") ||
    isBuiltinCopilotProfileOfKind(profileId, "sidechat-ooc") ||
    listAgentKinds().some((kind) => kind.builtinSeeds.some((seed) => seed.id === profileId))
  );
}

/** A caller asked a kind for a built-in seed id it does not declare — a
 *  programming error (every caller reads the id from the same list it is
 *  resolving against), so it fails loudly instead of silently resolving
 *  another seed. */
function undeclaredSeedError(kind: string, profileId: string): Error {
  return new Error(`No built-in profile "${profileId}" is declared for agent kind "${kind}".`);
}

/**
 * Project the fixed {@link EXPERIENCE_COPILOT_MODULE} + its loaded `base.md`
 * into a `CopilotProfile`-shaped READ-ONLY seed (the default profile for any
 * experience with no profile assigned — zero behavior change vs. the ER-16
 * module). `isBuiltIn: true` + a stable `"builtin"` id mark it as the seed the
 * profile editor shows read-only and that users duplicate from (Wave 3). The
 * tool set is projected through {@link COPILOT_TOOL_KEYS} so the wire contract
 * stays the single source of truth for the toggleable-tool names. No
 * `skillIds` — the catalog is ungated (PM-8).
 *
 * AS-3: the seed is per kind (`resolveBuiltinCopilotProfile(kind)`). A
 * non-`experience` kind is validated through the registry FIRST — an unknown
 * kind throws `UnknownAgentKindError` and NEVER falls back to the experience
 * seed (a silent cross-kind fallback would mask a miswired list). The
 * `experience` path is byte-identical to the pre-AS-3 behavior, plus
 * `agentKind`; the `script` kind (AS-7) delegates to its own seed in
 * `agent/script-agent/script-agent-module.ts`, and the `sidechat-ooc` kind
 * (SC-4a) to its own in `agent/kinds/sidechat-ooc-kind.ts`.
 *
 * DR-1 adds the seed dimension: a kind ships a LIST of built-in seeds
 * (`builtinCopilotSeeds` / the descriptor's `builtinSeeds`) and `profileId`
 * picks one (the stored sentinel `"builtin"` by default — the first seed,
 * the only one every kind has always had). An id the kind does not declare
 * throws instead of silently resolving another seed.
 */
export async function resolveBuiltinCopilotProfile(
  kind: string = "experience",
  db?: AppDb,
  profileId: string = BUILTIN_PROFILE_ID,
): Promise<CopilotProfile> {
  if (kind === "script") {
    // AS-7: the script kind's own seed — base prompt from the
    // `script_agent_base` service prompt (SP-5 override honored on this
    // builtin path) + tool set projected through SCRIPT_AGENT_TOOL_KEYS. The
    // species owns the seed (agent/script-agent/script-agent-module.ts)
    // exactly the way this module owns the experience one. One seed today —
    // `SCRIPT_AGENT_BUILTIN_SEEDS` declares it.
    const seed = SCRIPT_AGENT_BUILTIN_SEEDS.find((s) => s.id === profileId);
    if (seed === undefined) throw undeclaredSeedError(kind, profileId);
    return resolveBuiltinScriptAgentProfile(db);
  }
  if (kind === "sidechat-ooc") {
    // SC-4a: the sidechat kind's own seeds — base prompt from the
    // `sidechat_ooc_base` service prompt (SP-5 override honored on this
    // builtin path, the `script` seed's pattern) + a tool set projected
    // through SIDECHAT_OOC_TOOL_KEYS from the declarative
    // SIDECHAT_OOC_TOOL_SET. The species owns the seeds
    // (agent/kinds/sidechat-ooc-kind.ts); DR-1 adds the second one
    // (`builtin-director`, the Director shell whose own prompt and toggles
    // land with DR-4 — until then it shares the OOC base and tools).
    return resolveBuiltinSidechatOocProfile(db, profileId);
  }
  if (kind !== "experience") {
    // Validate FIRST — an unknown kind throws `UnknownAgentKindError` and
    // NEVER falls back to the experience seed (a silent cross-kind fallback
    // would mask a miswired list). The `experience` default path below stays
    // registry-free so every existing caller (which never registers kinds)
    // keeps byte-identical behavior.
    const descriptor = getAgentKind(kind);
    const seed = descriptor.builtinSeeds.find((s) => s.id === profileId);
    if (seed === undefined) throw undeclaredSeedError(kind, profileId);
    // Generic-kind seed (today only test fakes arrive here — AS-7's script
    // kind and SC-4a's sidechat kind bring their own base prompts + service
    // keys and branch ABOVE).
    // Deliberately NOT the experience prompt: serving another kind's content
    // here would be the silent cross-kind fallback AS-3 forbids. The empty
    // base prompt fails loudly (wire `min(1)`) if it ever reaches validation
    // instead of passing as a real prompt.
    return {
      id: seed.id,
      name: seed.name,
      isBuiltIn: true,
      basePrompt: "",
      toolSet: {},
      agentKind: descriptor.id,
    };
  }
  const experienceSeed = EXPERIENCE_BUILTIN_SEEDS.find((s) => s.id === profileId);
  if (experienceSeed === undefined) throw undeclaredSeedError(kind, profileId);
  // SP-5: the global service-prompt profile's `copilot_base` override replaces
  // the builtin base ONLY on this builtin path — explicit per-script copilot
  // profiles (basePrompt snapshots) never consult it (see copilot-profile-resolver).
  const basePrompt = db
    ? (await resolveServicePrompt(db, "copilot_base")).text
    : await loadPromptAsset(EXPERIENCE_COPILOT_MODULE.basePromptFile);
  const toolSet: CopilotToolSet = {};
  for (const key of COPILOT_TOOL_KEYS) {
    if (EXPERIENCE_COPILOT_MODULE.toolSet[key] === true) toolSet[key] = true;
  }
  return {
    id: experienceSeed.id,
    name: experienceSeed.name,
    isBuiltIn: true,
    basePrompt,
    toolSet,
    agentKind: "experience",
  };
}

/**
 * Render the skill-catalog block for the system message. Adapted from Co-Author's
 * `renderSkillCatalog` but copilot-local (the framing is the same progressive-
 * disclosure "Available skills" section; kept here so the copilot stays
 * standalone and its catalog wording can diverge if the mode evolves). Returns
 * an empty string when no skills are available so the section is omitted.
 */
export function renderExperienceCopilotSkillCatalog(
  entries: readonly SkillCatalogEntry[],
): string {
  if (entries.length === 0) return "";
  const lines = [
    "# Available skills (read on demand)",
    "Skills are loaded on demand. Pick the skill whose description matches the task, call `read_skill_file` with its manifest `path` to read its `SKILL.md`, obey that workflow, and read only the referenced files the task actually needs. Do NOT read a skill you do not need.",
    "",
    ...entries.map((e) => {
      const shadow = e.shadowsBuiltin ? " (user override of built-in)" : "";
      const desc = e.description.trim() || "(no description)";
      return `- **${e.id}**${shadow} — ${desc}  → read \`${e.rootRelativeManifestPath}\``;
    }),
  ];
  return lines.join("\n");
}
