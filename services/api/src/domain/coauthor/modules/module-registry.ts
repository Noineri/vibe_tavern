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
    name: "Character Workshop",
    description: "The default collaborative mode. Develops a premise conversationally — gathers requirements, contributes alternatives, and discusses trade-offs before drafting.",
    basePromptFile: "coauthor/modules/default.md",
    openingMessage:
      "Let's develop {{char}} together. Tell me the premise — even a few lines is enough — and I'll help shape it: the core fantasy, your role, the tone. We'll settle a direction before I draft anything.",
    skillIds: ["character-workshop"],
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
      // Wave 4: proposal-only lore authoring (CTX-L1/L2) — create books/entries,
      // delegate content/keys to the AI-assistant, and set activation.
      create_lorebook: true,
      create_lore_entry: true,
      set_lore_activation: true,
      ai_write_lore_entry: true,
      ai_generate_lore_keys: true,
      // CE-D2: indexed two-step context search.
      search_context: true,
      read_context_item: true,
    },
    maxSteps: 20,
  },
  {
    id: "quick-draft",
    name: "Quick Draft",
    description: "Turns a sparse brief into a complete, reviewable card fast. Reads its card-building skill and template, fills reasonable gaps, and asks only blocking questions.",
    basePromptFile: "coauthor/modules/quick-draft.md",
    openingMessage:
      "Give me a brief for {{char}} — a trope, a vibe, a few lines — and I'll read my card template and draft a complete first pass for you to review. I'll only ask when something blocks coherence.",
    skillIds: ["quick-draft"],
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
      // Wave 4: proposal-only lore authoring (CTX-L1/L2).
      create_lorebook: true,
      create_lore_entry: true,
      set_lore_activation: true,
      ai_write_lore_entry: true,
      ai_generate_lore_keys: true,
      // CE-D2: indexed two-step context search.
      search_context: true,
      read_context_item: true,
    },
    maxSteps: 20,
  },
  {
    id: "profile-editor",
    name: "Revision Workshop",
    description: "Revises an existing card. Audits what's weak, agrees scope and preservation constraints, then applies only the selected revisions.",
    basePromptFile: "coauthor/modules/profile-editor.md",
    openingMessage:
      "Let's tighten {{char}} up. I'll audit the personality and scenario first — name the highest-impact issues and what's already working — and we'll agree on what to change before I touch anything.",
    skillIds: ["revision-workshop"],
    toolSet: {
      write_profile: true,
      edit_personality: true,
      edit_scenario: true,
      write_personality: true,
      write_scenario: true,
      // CE-D2: indexed two-step context search.
      search_context: true,
      read_context_item: true,
    },
    maxSteps: 20,
  },
  {
    id: "dialogue-writer",
    name: "Dialogue Studio",
    description: "Voice, greetings, and example dialogue. Brainstorms opener directions and variants before writing, and stays conversational throughout.",
    basePromptFile: "coauthor/modules/dialogue-writer.md",
    openingMessage:
      "Let's find {{char}}'s voice. I can brainstorm opener directions and alternates before we write anything, or go straight to drafting greetings and example dialogue. What are we after?",
    skillIds: ["dialogue-studio"],
    toolSet: {
      edit_examples: true,
      write_examples: true,
      edit_greeting: true,
      add_alt_greeting: true,
      edit_alt_greeting: true,
      // CE-D2: indexed two-step context search.
      search_context: true,
      read_context_item: true,
    },
    maxSteps: 20,
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
