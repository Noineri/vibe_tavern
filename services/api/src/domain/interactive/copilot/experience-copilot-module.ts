/**
 * Experience-Copilot module definition + skill-catalog wiring
 * (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 6 / ER-16).
 *
 * The copilot is SINGLE-MODE (one fixed authoring mode, no module modal or
 * switcher in the editor — unlike Co-Author's user-pickable modules). This file
 * is that one mode's DEFINITION, adapted from the Co-Author seed-module pattern
 * ({@link getCoauthorModule}): a base prompt loaded lazily from a `.md` asset +
 * a declarative tool set + the skill ids this mode bundles. "Module" here is a
 * declarative config object the prompt assembler + tool builder consult, NOT a
 * runtime-selectable entity.
 *
 * The skill system is REUSED wholesale from Co-Author (scanner + catalog +
 * `read_skill_file`), not reimplemented: the copilot simply has its OWN skill
 * root (`assets/experience-copilot/skills/`) so its catalog is isolated from the
 * Co-Author character skills. The single built-in skill today is
 * `experience-authoring` (craft guidance read on demand via `read_skill_file` —
 * progressive disclosure, keeping the system prompt lean).
 */

import { dirname, resolve } from "node:path";
import { resolvePromptAssetPath, loadPromptAsset } from "../../../shared/prompt-asset-loader.js";
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
  /** Skills this mode advertises in its catalog (scanned from its own root). */
  readonly skillIds: readonly string[];
  /** Authoring/diagnostic tools enabled for this mode (`read_skill_file` is
   *  always available on top, mirroring Co-Author — it is the universal
   *  read-only skill channel, NOT gated by `toolSet`). */
  readonly toolSet: Record<string, boolean>;
  /** Max tool-loop steps for the multi-step turn (mirrors Co-Author maxSteps). */
  readonly maxSteps: number;
}

export const EXPERIENCE_COPILOT_MODULE: ExperienceCopilotModuleDef = {
  id: "experience-authoring",
  name: "Experience Authoring",
  description:
    "The copilot mode for authoring an interactive experience's rules and visual source. Proposes buffer edits via tools, self-tests, and never binds.",
  basePromptFile: "experience-copilot/base.md",
  skillIds: ["experience-authoring"],
  toolSet: {
    write_buffer: true,
    edit_buffer: true,
    run_test: true,
    run_simulate: true,
    suggest_visual_binding: true,
  },
  maxSteps: 20,
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
 * Project the fixed {@link EXPERIENCE_COPILOT_MODULE} + its loaded `base.md`
 * into a `CopilotProfile`-shaped READ-ONLY seed (the default profile for any
 * experience with no profile assigned — zero behavior change vs. the ER-16
 * module). `isBuiltIn: true` + a stable `"builtin"` id mark it as the seed the
 * profile editor shows read-only and that users duplicate from (Wave 3). The
 * tool set is projected through {@link COPILOT_TOOL_KEYS} so the wire contract
 * stays the single source of truth for the toggleable-tool names.
 */
export async function resolveBuiltinCopilotProfile(): Promise<CopilotProfile> {
  const basePrompt = await loadPromptAsset(EXPERIENCE_COPILOT_MODULE.basePromptFile);
  const toolSet: CopilotToolSet = {};
  for (const key of COPILOT_TOOL_KEYS) {
    if (EXPERIENCE_COPILOT_MODULE.toolSet[key] === true) toolSet[key] = true;
  }
  return {
    id: "builtin",
    name: EXPERIENCE_COPILOT_MODULE.name,
    isBuiltIn: true,
    basePrompt,
    skillIds: [...EXPERIENCE_COPILOT_MODULE.skillIds],
    toolSet,
    maxSteps: EXPERIENCE_COPILOT_MODULE.maxSteps,
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
