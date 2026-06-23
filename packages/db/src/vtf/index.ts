/**
 * Vibe Tavern Format — folder facade.
 *
 * Orchestrates the four VTF codecs ({@link module:profile-md},
 * {@link module:instructions}, {@link module:greetings},
 * {@link module:extensions}) to serialize/parse a whole character as a folder
 * of virtual files:
 *
 * ```
 * data/characters/{id}/
 *   profile.md          frontmatter + prose body (PERSONALITY/SCENARIO/EXAMPLES)
 *   instructions.json   functional instruction fields (system/post_history/depth_prompt)
 *   extensions.json     lossless unknown fields (creator / character_version stripped)
 *   greetings/
 *     _index.yaml       ordered manifest
 *     g_0000.md         primary greeting (former firstMessage)
 *     g_0001.md         alternate (former alternateGreetings[0])
 * ```
 *
 * The facade operates on the CONTENT fields of a character (prose, prompts,
 * greetings, tags, extensions). It does NOT touch media/avatar/status/slug —
 * those stay on the character root and are managed by the store (VTF-5).
 *
 * Round-trip invariants (pinned by `folder.test.ts`):
 *  - `Character → folder → Character` preserves every content field.
 *  - `folder → Character → folder` is byte-identical after canonicalization.
 */

import {
  serializeProfileMd,
  parseProfileMd,
  DEFAULT_MES_EXAMPLE_MODE,
  DEFAULT_DEPTH,
  type VtfProfile,
} from "./profile-md.js";
import {
  writeInstructions,
  readInstructions,
  type VtfInstructions,
} from "./instructions.js";
import {
  greetingsFromCharacter,
  characterFromGreetings,
  writeGreetingsFolder,
  readGreetingsFolder,
  defaultGreetingName,
  type VtfGreeting,
} from "./greetings.js";
import {
  writeExtensions,
  readExtensions,
  stashPersonalitySummary,
  unstashPersonalitySummary,
  PERSONALITY_SUMMARY_STASH_KEY,
} from "./extensions.js";

// Exchange codec (monolith `.md` for import/export/sharing). Re-exported here
// for the facade's consumers; the codec lives in its own module so it can
// import the storage codecs (profile-md/greetings/extensions) without a
// runtime cycle back into this facade.
export { packMonolith, unpackMonolith } from "./monolith.js";

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

/**
 * The content subset of a {@link Character} that lives inside the VTF folder.
 * Media/avatar/status/slug/timestamps are intentionally absent — they live on
 * the character root and are merged by the store.
 */
export interface VtfCharacterContent {
  name: string;
  description: string;
  /** VTF-native cards put everything in `description`; this is preserved losslessly via extensions if non-null. */
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  systemPrompt: string | null;
  tags: string[];
  /** The full extensions blob (may include creator / character_version duplicates; they are stripped on write). */
  extensions: Record<string, unknown>;
}

/** A virtual file entry produced/consumed by the facade. The store writes these via `ContentStore`. */
export interface FolderFileEntry {
  /** Path relative to the character folder, e.g. `profile.md` or `greetings/g_0001.md`. */
  path: string;
  content: string;
}

const PROFILE_FILE = "profile.md";
const INSTRUCTIONS_FILE = "instructions.json";
const EXTENSIONS_FILE = "extensions.json";

// ───────────────────────────────────────────────────────────────────────────
// Serialize: Character content → folder entries
// ───────────────────────────────────────────────────────────────────────────

/**
 * Serialize a character's content fields into the canonical VTF folder entries.
 * `personalitySummary` (when non-null) is preserved losslessly by stashing it
 * into `extensions` under a reserved key, so it survives the round-trip even
 * though VTF-native cards put everything in `# PERSONALITY` → `description`.
 */
export function serializeCharacterFolder(character: VtfCharacterContent): FolderFileEntry[] {
  const profile = profileFromCharacter(character);
  const instructions = instructionsFromCharacter(character);
  const greetings = greetingsFromCharacter(character.firstMessage, character.alternateGreetings);
  const extensionsWithLegacy = stashPersonalitySummary(character.extensions, character.personalitySummary);

  const entries: FolderFileEntry[] = [];
  entries.push({ path: PROFILE_FILE, content: serializeProfileMd({ profile }) });
  entries.push({ path: INSTRUCTIONS_FILE, content: writeInstructions(instructions) });
  entries.push({ path: EXTENSIONS_FILE, content: writeExtensions(extensionsWithLegacy) });
  entries.push(...writeGreetingsFolder(greetings));
  return entries;
}

// ───────────────────────────────────────────────────────────────────────────
// Parse: folder entries → Character content
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse VTF folder entries back into character content fields. Missing files
 * degrade gracefully (an absent `profile.md` yields defaults; an absent
 * `greetings/` yields an empty firstMessage). Never throws.
 */
export function parseCharacterFolder(entries: FolderFileEntry[]): VtfCharacterContent {
  const byPath = new Map(entries.map((e) => [normalizePath(e.path), e.content]));
  const profileMd = byPath.get(PROFILE_FILE) ?? "";
  const extensionsJson = byPath.get(EXTENSIONS_FILE) ?? "{}\n";
  const greetingEntries: FolderFileEntry[] = entries
    .filter((e) => normalizePath(e.path).startsWith("greetings/"))
    .map((e) => ({ path: normalizePath(e.path), content: e.content }));

  const parsed = parseProfileMd(profileMd);
  const profile = parsed.profile;
  const instructionsJson = byPath.get(INSTRUCTIONS_FILE) ?? "{}\n";
  const instructions = readInstructions(instructionsJson);
  const greetings = readGreetingsFolder(greetingEntries);
  const { firstMessage, alternateGreetings } = characterFromGreetings(greetings);
  const extensions = readExtensions(extensionsJson, {
    creator: profile.creator,
    characterVersion: profile.characterVersion,
  });
  const personalitySummary = unstashPersonalitySummary(extensions);

  return {
    name: profile.name,
    description: profile.description,
    personalitySummary,
    defaultScenario: profile.scenario,
    firstMessage,
    mesExample: profile.mesExample,
    mesExampleMode: profile.mesExampleMode,
    mesExampleDepth: profile.mesExampleDepth,
    alternateGreetings,
    postHistoryInstructions: instructions.postHistoryInstructions,
    creatorNotes: profile.creatorNotes,
    depthPrompt: instructions.depthPrompt,
    depthPromptDepth: instructions.depthPromptDepth,
    depthPromptRole: instructions.depthPromptRole,
    systemPrompt: instructions.systemPrompt,
    tags: profile.tags,
    extensions,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: greeting inspection (used by the store for stable id lookups)
// ───────────────────────────────────────────────────────────────────────────

/** Read just the greeting list from folder entries (without parsing the whole character). */
export function readGreetingsFromFolder(entries: FolderFileEntry[]): VtfGreeting[] {
  const greetingEntries = entries
    .filter((e) => normalizePath(e.path).startsWith("greetings/"))
    .map((e) => ({ path: normalizePath(e.path), content: e.content }));
  return readGreetingsFolder(greetingEntries);
}

/** Re-export stable-name helper for stores that render greeting lists. */
export { defaultGreetingName };

// ───────────────────────────────────────────────────────────────────────────
// Internals: Character ↔ VtfProfile
// ───────────────────────────────────────────────────────────────────────────

/** Build a {@link VtfProfile} from a character's content fields. */
function profileFromCharacter(character: VtfCharacterContent): VtfProfile {
  return {
    name: character.name,
    tags: character.tags,
    creator: optionalString(character.extensions.creator),
    characterVersion: optionalString(character.extensions.character_version),
    creatorNotes: character.creatorNotes,
    mesExampleMode: character.mesExampleMode || DEFAULT_MES_EXAMPLE_MODE,
    mesExampleDepth: Number.isFinite(character.mesExampleDepth) ? character.mesExampleDepth : DEFAULT_DEPTH,
    description: character.description,
    scenario: character.defaultScenario,
    mesExample: character.mesExample,
  };
}

/** Build a {@link VtfInstructions} from a character's functional instruction fields. */
function instructionsFromCharacter(character: VtfCharacterContent): VtfInstructions {
  return {
    systemPrompt: character.systemPrompt,
    postHistoryInstructions: character.postHistoryInstructions,
    depthPrompt: character.depthPrompt,
    depthPromptDepth: character.depthPromptDepth,
    depthPromptRole: character.depthPromptRole,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals: personalitySummary stash (lossless legacy preservation)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reserved key under which a legacy non-null `personalitySummary` is stashed
 * inside `extensions.json`. VTF-native cards put the whole personality in
 * `# PERSONALITY` → `description`; but a card IMPORTED from V3 may have both,
 * and we must not silently drop the legacy field.
 */
// `PERSONALITY_SUMMARY_STASH_KEY` + `stashPersonalitySummary` /
// `unstashPersonalitySummary` are imported from `./extensions.js` (leaf) and
// re-exported here for existing consumers (e.g. `folder.test.ts`).
export { PERSONALITY_SUMMARY_STASH_KEY };

// ───────────────────────────────────────────────────────────────────────────
// Internals: path normalization
// ───────────────────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
