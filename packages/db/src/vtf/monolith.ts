/**
 * Vibe Tavern Format — monolith exchange codec.
 *
 * The monolith is a SINGLE `.md` document carrying EVERY content field of a
 * character — prose AND functional instructions AND greetings AND extensions —
 * for import/export/sharing (PNG-carrier `vtmd` chunk, cross-install copy). It
 * is the ONLY VTF representation in which the functional instruction sections
 * (`# SYSTEM`, `# POST-HISTORY`, `# DEPTH PROMPT`) appear as body headings; in
 * storage they live in `instructions.json`, and in the editor they never
 * appear as a monolith at all (the editor writes storage files).
 *
 * ```
 * ---
 * name: Silvius
 * tags: [modern, werewolf, fdom]
 * creator: anonymous
 * character_version: "1.0"
 * creator_notes: |
 *   Internal notes for the author.
 * vt:
 *   mes_example_mode: depth
 *   mes_example_depth: 4
 *   depth_prompt_depth: 4
 *   depth_prompt_role: system
 * ---
 *
 * # PERSONALITY
 * [Base: calm]
 * Silver-haired and watchful.
 *
 * # SCENARIO
 * A tavern at the forest's edge.
 *
 * # EXAMPLES
 * <START>
 * {{char}}: Welcome.
 *
 * # SYSTEM
 * Respond in second person.
 *
 * # POST-HISTORY
 * Keep it brief.
 *
 * # DEPTH PROMPT
 * Remember the silver scar.
 *
 * # GREETINGS
 * The door creaks open.
 *
 * === ALT 1 ===
 *
 * A second opener.
 *
 * ```vtf-extensions
 * {
 *   "fav": false,
 *   "talkativeness": "0.5"
 * }
 * ```
 * ```
 *
 * Architecture. The monolith deliberately reuses the storage codecs rather than
 * re-implementing the YAML dialect:
 *  - The frontmatter + prose body are produced by {@link serializeProfileMd} /
 *    {@link parseProfileMd} (profile-md.ts is the single source of truth for the
 *    hand-rolled YAML dialect). The functional sections ride as `unknownSections`
 *    and the depth config rides as `unknownVt` entries, which profile-md already
 *    preserves verbatim — so no dialect code is duplicated here.
 *  - Greetings ride in a `# GREETINGS` section whose body is the inline-marker
 *    blob from {@link compileGreetingsInline} / {@link splitGreetingsInline}.
 *  - Extensions ride in a fenced ```` ```vtf-extensions ```` block whose inner
 *    text is the canonical `extensions.json` (via {@link writeExtensions} /
 *    {@link readExtensions}); `creator` / `character_version` stay in the
 *    frontmatter (stripped from the block, re-merged on read), exactly as in
 *    storage. Arbitrary nested JSON (incl. `character_book`) lives here because
 *    it cannot be expressed in the hand-rolled frontmatter losslessly.
 *
 * Round-trip invariants (pinned by `monolith.test.ts`):
 *  - `storage → monolith → storage` is byte-identical (after canonicalization).
 *  - `monolith → storage → monolith` is textually identical.
 *
 * Lossiness note (matches the storage facade): the monolith operates on
 * {@link VtfCharacterContent}, which is a FIELD-level model. Document-level
 * unknowns that profile-md can carry (unknown frontmatter keys, unknown `vt:`
 * keys beyond the depth config, unknown body sections beyond the canonical
 * seven) are NOT preserved across the monolith — exactly as the storage facade
 * (`serializeCharacterFolder` / `parseCharacterFolder`) drops them. The
 * extensions blob is the lossless channel for unknown VALUES; document-level
 * structural unknowns are out of scope for both representations.
 */

import {
  serializeProfileMd,
  parseProfileMd,
  DEFAULT_MES_EXAMPLE_MODE,
  DEFAULT_DEPTH,
  type VtfProfile,
  type FrontmatterEntry,
} from "./profile-md.js";
import {
  compileGreetingsInline,
  splitGreetingsInline,
  greetingsFromCharacter,
  characterFromGreetings,
} from "./greetings.js";
import {
  writeExtensions,
  readExtensions,
  stashPersonalitySummary,
  unstashPersonalitySummary,
} from "./extensions.js";
// Type-only import: erased at compile time, so no runtime cycle with the facade
// (which re-exports this module's functions).
import type { VtfCharacterContent } from "./index.js";

// ───────────────────────────────────────────────────────────────────────────
// Canonical section headings (the ONLY place functional headings appear)
// ───────────────────────────────────────────────────────────────────────────

const HEADING_PERSONALITY = "PERSONALITY";
const HEADING_SCENARIO = "SCENARIO";
const HEADING_EXAMPLES = "EXAMPLES";
const HEADING_SYSTEM = "SYSTEM";
const HEADING_POST_HISTORY = "POST-HISTORY";
const HEADING_DEPTH_PROMPT = "DEPTH PROMPT";
const HEADING_GREETINGS = "GREETINGS";

/** Depth-config keys carried in the `vt:` frontmatter map of the monolith. */
const VT_DEPTH_PROMPT_DEPTH = "depth_prompt_depth";
const VT_DEPTH_PROMPT_ROLE = "depth_prompt_role";

/** Info string marking the fenced extensions JSON block. */
const EXTENSIONS_FENCE_INFO = "vtf-extensions";

/** Matches the fenced extensions block: opening info line, inner JSON, closing fence. */
const EXTENSIONS_FENCE_RE = /```vtf-extensions[^\n]*\n([\s\S]*?)\n```[ \t]*\n?/;

/** Empty canonical extensions JSON (used when the fence is absent). */
const EMPTY_EXTENSIONS_JSON = "{}\n";

// ───────────────────────────────────────────────────────────────────────────
// Pack: VtfCharacterContent → monolith `.md`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Serialize a character's content fields into the canonical monolith exchange
 * document. Optional sections are omitted when empty; the `vtf-extensions`
 * fence is omitted when the (creator/version-stripped) extensions blob is empty.
 */
export function packMonolith(character: VtfCharacterContent): string {
  const profile = profileFromCharacter(character);
  const depthConfig = depthConfigEntries(character);
  const profileMdText = serializeProfileMd({ profile, unknownVt: depthConfig });

  const parts: string[] = [profileMdText.replace(/\n+$/, "")];

  appendSection(parts, HEADING_SYSTEM, character.systemPrompt);
  appendSection(parts, HEADING_POST_HISTORY, character.postHistoryInstructions);
  appendSection(parts, HEADING_DEPTH_PROMPT, character.depthPrompt);

  const greetings = greetingsFromCharacter(character.firstMessage, character.alternateGreetings);
  if (greetings.some((g) => g.content.trim().length > 0)) {
    const inline = compileGreetingsInline(greetings).replace(/\n+$/, "");
    if (inline.length > 0) parts.push(`# ${HEADING_GREETINGS}\n${inline}`);
  }

  const extensionsForFence = stashPersonalitySummary(character.extensions, character.personalitySummary);
  const extensionsText = writeExtensions(extensionsForFence).replace(/\n+$/, "");
  if (extensionsText !== "{}") {
    parts.push("```" + EXTENSIONS_FENCE_INFO + "\n" + extensionsText + "\n```");
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trimEnd() + "\n";
}

// ───────────────────────────────────────────────────────────────────────────
// Unpack: monolith `.md` → VtfCharacterContent
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a monolith exchange document back into character content fields.
 * Tolerant of missing sections/fence (absent → null/empty, never throws).
 */
export function unpackMonolith(md: string): VtfCharacterContent {
  const { fenceInner, rest } = extractExtensionsFence(md);
  const parsed = parseProfileMd(rest);

  const sections = indexUnknownSections(parsed.unknownSections ?? []);
  const vtMap = new Map((parsed.unknownVt ?? []).map((e) => [e.key, e.value]));

  const profile = parsed.profile;
  const greetings = splitGreetingsInline(sections.get(HEADING_GREETINGS) ?? "");
  const { firstMessage, alternateGreetings } = characterFromGreetings(greetings);
  const extensions = readExtensions(
    fenceInner !== null && fenceInner.trim().length > 0 ? fenceInner : EMPTY_EXTENSIONS_JSON,
    { creator: profile.creator, characterVersion: profile.characterVersion },
  );
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
    postHistoryInstructions: bodyOrNull(sections.get(HEADING_POST_HISTORY)),
    creatorNotes: profile.creatorNotes,
    depthPrompt: bodyOrNull(sections.get(HEADING_DEPTH_PROMPT)),
    depthPromptDepth: depthFromVt(vtMap.get(VT_DEPTH_PROMPT_DEPTH)),
    depthPromptRole: roleFromVt(vtMap.get(VT_DEPTH_PROMPT_ROLE)),
    systemPrompt: bodyOrNull(sections.get(HEADING_SYSTEM)),
    tags: profile.tags,
    extensions,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Internals: Character ↔ VtfProfile (mirrors the storage facade)
// ───────────────────────────────────────────────────────────────────────────

/** Build a {@link VtfProfile} from a character's content fields (mirrors the facade's `profileFromCharacter`). */
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

/** Build the `vt:` depth-config entries (depth + role) for the monolith frontmatter. */
function depthConfigEntries(character: VtfCharacterContent): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  if (character.depthPromptDepth !== null) {
    entries.push({ key: VT_DEPTH_PROMPT_DEPTH, value: String(character.depthPromptDepth), block: false });
  }
  if (character.depthPromptRole !== null) {
    entries.push({ key: VT_DEPTH_PROMPT_ROLE, value: character.depthPromptRole, block: false });
  }
  return entries;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals: section emission
// ───────────────────────────────────────────────────────────────────────────

/** Push `# HEADING\n<body>` onto `parts` only when `body` is a non-empty trimmed string. */
function appendSection(parts: string[], heading: string, body: string | null): void {
  if (body === null) return;
  const trimmed = body.replace(/^\n+|\n+$/g, "");
  if (trimmed.length === 0) return;
  parts.push(`# ${heading}\n${trimmed}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Internals: section / vt extraction (parse-side)
// ───────────────────────────────────────────────────────────────────────────

/** Index unknown body sections by normalized heading (uppercase + trimmed); first occurrence wins. */
function indexUnknownSections(unknownSections: { heading: string; body: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of unknownSections) {
    const key = section.heading.trim().toUpperCase();
    if (!map.has(key)) map.set(key, section.body);
  }
  return map;
}

/** Return a section body only when it holds non-empty content, else null. */
function bodyOrNull(body: string | undefined): string | null {
  if (body === undefined) return null;
  const trimmed = body.replace(/^\n+|\n+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse a `depth_prompt_depth` vt value into a finite number or null. */
function depthFromVt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Read a `depth_prompt_role` vt value into a non-empty string or null. */
function roleFromVt(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals: extensions fence extraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Split the monolith into the extensions-fence inner JSON (or null when absent)
 * and the remaining document (frontmatter + body). The fence is extracted FIRST
 * so its lines are not absorbed into a body section by the prose parser.
 */
function extractExtensionsFence(md: string): { fenceInner: string | null; rest: string } {
  const match = EXTENSIONS_FENCE_RE.exec(md);
  if (!match) return { fenceInner: null, rest: md };
  const fenceInner = match[1] ?? "";
  const rest = (md.slice(0, match.index) + md.slice(match.index + match[0].length)).replace(/\n{3,}/g, "\n\n");
  return { fenceInner, rest };
}
