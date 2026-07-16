import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { loadPromptAsset } from "../../../shared/prompt-asset-loader.js";

/**
 * Seed (built-in) module DEFINITIONS — metadata only, no inline basePrompt.
 * The `.md` asset is loaded lazily on first resolution (cached by
 * `loadPromptAsset`) and materialized into `basePrompt` so the contract has a
 * single inline-text field for both built-in and user modules (CS-24).
 *
 * `openingMessage` is seeded as the chat's first assistant turn on chat birth
 * for co-author mode (CS-29). English, matching the seed prompt files;
 * `{{char}}` stays literal in co-author per CS-26.
 *
 * Sync + pure (no I/O): these defs never read disk. The I/O happens in
 * {@link getCoauthorModules}, which is async by design.
 */
interface SeedModuleDef {
  id: string;
  name: string;
  description: string;
  basePromptFile: string;
  openingMessage: string;
  skillIds: string[];
  toolSet: CoauthorModule["toolSet"];
  maxSteps: number;
}

const SEED_MODULE_DEFS: readonly SeedModuleDef[] = [
  {
    id: "default",
    name: "Default Co-Author",
    description: "A balanced co-author module for general roleplay, scene continuation, and editing.",
    basePromptFile: "coauthor/modules/default.md",
    openingMessage:
      "I'm ready to help you build {{char}} — I can revise the profile, personality, scenario, greetings, and example dialogue. What would you like to work on?",
    skillIds: ["general-writing"],
    toolSet: {
      write_profile: true,
      edit_personality: true,
      edit_scenario: true,
      edit_examples: true,
      write_personality: true,
      write_scenario: true,
      write_examples: true,
      edit_greeting: true,
      add_alt_greeting: true,
      edit_alt_greeting: true,
    },
    maxSteps: 5,
  },
  {
    id: "profile-editor",
    name: "Profile Editor",
    description: "Focuses entirely on refining character profiles, personalities, and scenarios.",
    basePromptFile: "coauthor/modules/profile-editor.md",
    openingMessage:
      "I'll focus on {{char}}'s profile — personality, scenario, and description. Tell me what feels flat or underdeveloped and I'll propose targeted edits.",
    skillIds: ["profile-analysis"],
    toolSet: {
      write_profile: true,
      edit_personality: true,
      edit_scenario: true,
      write_personality: true,
      write_scenario: true,
    },
    maxSteps: 3,
  },
  {
    id: "dialogue-writer",
    name: "Dialogue Writer",
    description: "Specializes in writing character greetings and example dialogue.",
    basePromptFile: "coauthor/modules/dialogue-writer.md",
    openingMessage:
      "I'll help you write and refine {{char}}'s greetings and example dialogue. Want fresh opening lines, alternates, or a rewrite of what's there?",
    skillIds: ["dialogue-generation"],
    toolSet: {
      edit_examples: true,
      write_examples: true,
      edit_greeting: true,
      add_alt_greeting: true,
      edit_alt_greeting: true,
    },
    maxSteps: 3,
  },
];

const SEED_MODULE_IDS = new Set(SEED_MODULE_DEFS.map((m) => m.id));

/**
 * The built-in default module id (the fallback when a chat's module id is null,
 * unknown, or points at a deleted user module). Exposed for tests and for
 * callers that need the fallback id without resolving text.
 */
export const DEFAULT_COAUTHOR_MODULE_ID = SEED_MODULE_DEFS[0].id;

/** Test/admin introspection: the seed defs without resolving prompt text. */
export function getSeedModuleDefs(): readonly SeedModuleDef[] {
  return SEED_MODULE_DEFS;
}

/** Whether a module id refers to a built-in (read-only) seed module. */
export function isSeedModule(id: string | null | undefined): boolean {
  return !!id && SEED_MODULE_IDS.has(id);
}

/**
 * Resolve seed defs into full modules by loading each `.md` into `basePrompt`.
 * `loadPromptAsset` caches per filename, so repeated calls are O(defs) Map
 * lookups — cheap to call on every prompt assembly turn.
 */
async function resolveSeedModules(): Promise<CoauthorModule[]> {
  return Promise.all(
    SEED_MODULE_DEFS.map(async (def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      basePrompt: await loadPromptAsset(def.basePromptFile),
      openingMessage: def.openingMessage,
      skillIds: def.skillIds,
      toolSet: def.toolSet,
      maxSteps: def.maxSteps,
      isBuiltIn: true,
    })),
  );
}

/**
 * Map a stored user-module row to the API `CoauthorModule` shape (drops the
 * DB-only `createdAt`/`updatedAt`, stamps `isBuiltIn: false`). Accepts the
 * `CoauthorModuleRow` shape from the store so the registry stays decoupled from
 * the `@vibe-tavern/db` package (no import cycle: db → api-contracts, registry
 * → api-contracts; the row is passed in structurally).
 */
type UserModuleLike = Omit<CoauthorModule, "isBuiltIn"> & { createdAt?: string; updatedAt?: string };

function toUserModule(row: UserModuleLike): CoauthorModule {
  const { isBuiltIn: _drop, createdAt: _c, updatedAt: _u, ...rest } = row as CoauthorModule & {
    createdAt?: string;
    updatedAt?: string;
  };
  return { ...rest, isBuiltIn: false };
}

/**
 * Merge seed (built-in, read-only) + user (DB-stored, editable) modules into the
 * full resolved list. Seed modules come first (stable ordering), user modules
 * appended in store order. `userModules` defaults to `[]` so callers that only
 * need a seed lookup pay no DB cost.
 */
export async function getCoauthorModules(
  userModules: readonly UserModuleLike[] = [],
): Promise<CoauthorModule[]> {
  const seeds = await resolveSeedModules();
  return [...seeds, ...userModules.map(toUserModule)];
}

/**
 * Resolve a single module by id, seed-first. If `id` is a seed id (the common
 * case), this avoids needing any user-module rows at all — callers in the hot
 * prompt-assembly path can pass `userModules: []` when `isSeedModule(id)` holds.
 * Falls back to the default seed module when the id is null/unknown/deleted.
 */
export async function getCoauthorModule(
  id: string | null | undefined,
  userModules: readonly UserModuleLike[] = [],
): Promise<CoauthorModule> {
  const seed = SEED_MODULE_DEFS.find((m) => m.id === id);
  if (seed) {
    return {
      id: seed.id,
      name: seed.name,
      description: seed.description,
      basePrompt: await loadPromptAsset(seed.basePromptFile),
      openingMessage: seed.openingMessage,
      skillIds: seed.skillIds,
      toolSet: seed.toolSet,
      maxSteps: seed.maxSteps,
      isBuiltIn: true,
    };
  }
  const user = userModules.find((m) => m.id === id);
  if (user) return toUserModule(user);

  // Fallback: the default seed module. Resolve its text rather than recursing,
  // to keep this tail-branch free of the userModules dependency.
  const defaultDef = SEED_MODULE_DEFS[0];
  return {
    id: defaultDef.id,
    name: defaultDef.name,
    description: defaultDef.description,
    basePrompt: await loadPromptAsset(defaultDef.basePromptFile),
    openingMessage: defaultDef.openingMessage,
    skillIds: defaultDef.skillIds,
    toolSet: defaultDef.toolSet,
    maxSteps: defaultDef.maxSteps,
    isBuiltIn: true,
  };
}
