import type { Character, CharacterId, CharacterVersion, CharacterVersionId } from "@vibe-tavern/domain";
import { brandId, ENTITY_ID_NAMESPACE } from "@vibe-tavern/domain";

import {
  asOptionalString,
  asString,
  asStringArray,
  isRecord,
  makeDeterministicId,
  normalizeTimestamp,
  parseJsonInput,
  sanitizeRecord,
  slugify,
  stableJson,
} from "../shared.js";
import { extractCardRegexScripts, type RegexScriptImportDraft } from "./regex-scripts.js";

export interface CharacterCardV3Normalized {
  spec: "chara_card_v3";
  specVersion: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleMessages: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  tags: string[];
  creator: string | null;
  characterVersion: string | null;
  alternateGreetings: string[];
  groupOnlyGreetings: string[];
  extensions: Record<string, unknown>;
  createdAt: string | null;
}

export interface ImportedCharacterCardBundle {
  format: "chara_card_v3_json";
  normalized: CharacterCardV3Normalized;
  character: Character;
  version: CharacterVersion;
  warnings: string[];
  /** Regex scripts embedded under `extensions.regex_scripts`, extracted into
   *  importable drafts (REGEX_EXTENSION_PLAN RX-15). Always `disabled: true` —
   *  the review-before-trust gate for shared-card content. Additive only:
   *  `normalized.extensions` keeps carrying the raw array (lossless export). */
  regexScripts: RegexScriptImportDraft[];
}

export interface ImportCharacterCardOptions {
  now?: string;
  characterStatus?: Character["status"];
}

/**
 * V2-era ("v1CharData") content fields SillyTavern keeps at the top level
 * alongside the V3 `data` block, for backward compat with V2-only parsers.
 * Strict V2 parsers (janitor.ai and similar) read name / description /
 * first_mes etc. from the TOP level — without these duplicates the card reads
 * as empty even though `data` is fully populated.
 *
 * Each entry maps a V3 `data` key → the V2 top-level key name. Note the one
 * rename: V3 `creator_notes` is exposed as V2 `creatorcomment`. Source of
 * truth: the `v1CharData` typedef in SillyTavern/public/scripts/char-data.js.
 *
 * NOTE: apps/web/src/lib/png-writer.ts keeps a self-contained copy of this
 * mapping because apps/web cannot import this package (dep graph). Keep both
 * in sync when editing.
 */
export const V2_TOPLEVEL_FIELDS: ReadonlyArray<readonly [dataKey: string, v2Key: string]> = [
  ["name", "name"],
  ["description", "description"],
  ["personality", "personality"],
  ["scenario", "scenario"],
  ["first_mes", "first_mes"],
  ["mes_example", "mes_example"],
  ["tags", "tags"],
  ["creator_notes", "creatorcomment"],
];

/**
 * Return a hybrid V2+V3 character card: the canonical V3 block stays under
 * `data`, and the V2-era field set is flattened to the top level (mirroring
 * SillyTavern's export shape) so strict V2 parsers can find the character
 * data. Also stamps ST meta fields (fav, avatar, talkativeness, create_date)
 * at the top level when absent.
 *
 * The `data` block is the source of truth — top-level copies are always
 * re-synced from it, so a re-export of an already-hybrid card is stable and
 * never drifts. Pure: returns a new object, does not mutate the input.
 */
export function flattenV2CompatFields(input: Record<string, unknown>): Record<string, unknown> {
  const card: Record<string, unknown> = { ...input };
  card.spec = "chara_card_v3";
  card.spec_version = "3.0";

  const data = card.data;
  if (isRecord(data)) {
    for (const [dataKey, v2Key] of V2_TOPLEVEL_FIELDS) {
      if (dataKey in data) card[v2Key] = data[dataKey];
    }
  }

  // ST stamps these v1CharData meta fields at the top level on every export.
  // Only set when absent so a re-export of an already-ST-shaped card is stable.
  // talkativeness also lives under data.extensions in ST; prefer that if present.
  const ext = isRecord(data) ? data.extensions : undefined;
  const extTalkativeness = isRecord(ext) ? ext.talkativeness : undefined;
  if (card.create_date == null) card.create_date = new Date().toISOString();
  if (card.fav == null) card.fav = false;
  if (card.creatorcomment == null) card.creatorcomment = "";
  if (card.avatar == null) card.avatar = "none";
  if (card.talkativeness == null) card.talkativeness = extTalkativeness ?? "0.5";

  return card;
}

function getCardData(root: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(root.data)) {
    return root.data;
  }

  return root;
}

export function importCharacterCardV3Json(
  input: string | Record<string, unknown>,
  options: ImportCharacterCardOptions = {},
): ImportedCharacterCardBundle {
  const root = parseJsonInput(input);
  const spec = asString(root.spec);

  // Accept v3 and v2, or treat any JSON with a `name` field as a legacy card
  if (spec && spec !== "chara_card_v3" && spec !== "chara_card_v2") {
    throw new Error(`Unsupported character card spec: ${spec || "unknown"}`);
  }

  const data = getCardData(root);
  const fallbackNow = options.now ?? new Date().toISOString();
  const importedAt = normalizeTimestamp(root.create_date, fallbackNow);
  const name = asString(data.name).trim();

  if (!name) {
    throw new Error("Character card is missing `name`.");
  }

  const warnings: string[] = [];
  const normalized: CharacterCardV3Normalized = {
    spec: "chara_card_v3",
    specVersion: asString(root.spec_version) || "3.0",
    name,
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    firstMessage: asString(data.first_mes),
    exampleMessages: asString(data.mes_example),
    creatorNotes: asString(data.creator_notes) || asString(root.creatorcomment),
    systemPrompt: asString(data.system_prompt),
    postHistoryInstructions: asString(data.post_history_instructions),
    characterBook: isRecord(data.character_book) ? data.character_book : null,
    depthPrompt: asString(data.depth_prompt),
    depthPromptDepth: typeof data.depth_prompt_depth === "number" ? data.depth_prompt_depth : null,
    depthPromptRole: asOptionalString(data.depth_prompt_role),
    tags: asStringArray(data.tags),
    creator: asOptionalString(data.creator),
    characterVersion: asOptionalString(data.character_version),
    alternateGreetings: asStringArray(data.alternate_greetings),
    groupOnlyGreetings: asStringArray(data.group_only_greetings),
    extensions: isRecord(data.extensions) ? sanitizeRecord(data.extensions) : {},
    createdAt: typeof root.create_date === "string" ? importedAt : null,
  };

  if (!normalized.firstMessage) {
    warnings.push("Character card has no first message.");
  }

  if (!normalized.scenario) {
    warnings.push("Character card has no scenario.");
  }

  // Strip control characters from all string fields
  const ctrlRe = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
  const cleaned = {
    ...normalized,
    name: normalized.name.replace(ctrlRe, ""),
    description: normalized.description.replace(ctrlRe, ""),
    personality: normalized.personality.replace(ctrlRe, ""),
    scenario: normalized.scenario.replace(ctrlRe, ""),
    firstMessage: normalized.firstMessage.replace(ctrlRe, ""),
    exampleMessages: normalized.exampleMessages.replace(ctrlRe, ""),
    systemPrompt: normalized.systemPrompt.replace(ctrlRe, ""),
    postHistoryInstructions: normalized.postHistoryInstructions.replace(ctrlRe, ""),
    depthPrompt: normalized.depthPrompt.replace(ctrlRe, ""),
    creatorNotes: normalized.creatorNotes.replace(ctrlRe, ""),
    alternateGreetings: normalized.alternateGreetings.map(g => g.replace(ctrlRe, "")),
    groupOnlyGreetings: normalized.groupOnlyGreetings.map(g => g.replace(ctrlRe, "")),
    tags: normalized.tags.map(t => t.replace(ctrlRe, "")),
  };

  const slug = slugify(cleaned.name);
  const characterId: CharacterId = brandId<CharacterId>(makeDeterministicId(
    ENTITY_ID_NAMESPACE.character,
    `${slug}:${stableJson(root)}`,
  ));
  const versionId: CharacterVersionId = brandId<CharacterVersionId>(makeDeterministicId(
    ENTITY_ID_NAMESPACE.characterVersion,
    `${characterId}:${stableJson(root)}`,
  ));

  const character: Character = {
    id: characterId,
    slug,
    name: cleaned.name,
    description: cleaned.description,
    personalitySummary: cleaned.personality || null,
    defaultScenario: cleaned.scenario || null,
    firstMessage: cleaned.firstMessage || null,
    mesExample: cleaned.exampleMessages || null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: cleaned.alternateGreetings,
    postHistoryInstructions: cleaned.postHistoryInstructions || null,
    creatorNotes: cleaned.creatorNotes || null,
    characterBook: cleaned.characterBook,
    depthPrompt: cleaned.depthPrompt || null,
    depthPromptDepth: cleaned.depthPromptDepth,
    depthPromptRole: cleaned.depthPromptRole,
    extensions: cleaned.extensions,
    systemPrompt: cleaned.systemPrompt || null,
    tags: cleaned.tags,
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    avatarSourceAssetId: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    status: options.characterStatus ?? "active",
    createdAt: importedAt,
    updatedAt: importedAt,
  };

  const version: CharacterVersion = {
    id: versionId,
    characterId,
    title: normalized.characterVersion ?? `${normalized.name} import`,
    isActive: true,
    createdAt: importedAt,
  };

  // Embedded ST regex scripts (RX-15). Prefer `data.extensions`; fall back to
  // a top-level `extensions` block (pure-V2 shape) when the data block carries
  // none. Extraction never throws and extensions stay untouched (lossless).
  const dataExtensions = isRecord(data.extensions) ? data.extensions : undefined;
  const rootExtensions = root !== data && isRecord(root.extensions) ? root.extensions : undefined;
  const hasScripts = (ext: Record<string, unknown> | undefined): ext is Record<string, unknown> =>
    ext != null && Array.isArray(ext.regex_scripts);
  const regexSource = hasScripts(dataExtensions)
    ? dataExtensions
    : hasScripts(rootExtensions)
      ? rootExtensions
      : dataExtensions ?? rootExtensions;

  return {
    format: "chara_card_v3_json",
    normalized,
    character,
    version,
    warnings,
    regexScripts: extractCardRegexScripts(regexSource),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// VTF monolith → ImportedCharacterCardBundle
// ───────────────────────────────────────────────────────────────────────────

/**
 * Structural input for {@link vtfContentToImportedBundle}. Mirrors the
 * `VtfCharacterContent` field set from `@vibe-tavern/db` field-for-field, but
 * is declared HERE (in the leaf `import-export` package) so this package never
 * takes a dependency on `@vibe-tavern/db` — the two are siblings that both
 * depend only on `@vibe-tavern/domain`. `VtfCharacterContent` satisfies this
 * interface structurally, so the caller (`services/api`) passes the result of
 * `unpackMonolith` straight through with no projection.
 */
export interface VtfMonolithImportInput {
  name: string;
  description: string;
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
  extensions: Record<string, unknown>;
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Strip ASCII control chars from a string (null-safe). */
function stripControlChars(value: string | null): string {
  return value === null ? "" : value.replace(CONTROL_CHAR_RE, "");
}

/**
 * Build an {@link ImportedCharacterCardBundle} from a parsed VTF monolith so the
 * native VTF import path reuses the SAME create/update/chat/seed tail as ST JSON
 * import (the consumer, `services/api`'s `importJson`, branches on the bundle
 * source but runs one shared tail).
 *
 * `character_book` handling mirrors {@link importCharacterCardV3Json}: the VTF
 * extensions fence may carry a nested `character_book` (the codec's lossless
 * channel for it — see `packages/db/src/vtf/extensions.ts`); here it is
 * PROMOTED to the dedicated `character.characterBook` / `normalized.characterBook`
 * field and STRIPPED from `extensions`, exactly as ST import pulls
 * `data.character_book` out of `data.extensions`. Without this split the
 * embedded lorebook would sit unknown inside `extensions` and never activate.
 *
 * The id is deterministic over the monolith TEXT (not the field object) so that
 * re-importing the same `.md` / `vtmd` chunk dedups via the existing
 * `skipExisting` path. A `vtf:1` tag namespaces the seed away from ST JSON ids.
 */
export function vtfContentToImportedBundle(
  content: VtfMonolithImportInput,
  monolithText: string,
  options: ImportCharacterCardOptions = {},
): ImportedCharacterCardBundle {
  const name = stripControlChars(content.name).trim();
  if (!name) {
    throw new Error("VTF monolith is missing a name.");
  }

  const rawExtensions = sanitizeRecord(content.extensions);
  const characterBook = isRecord(rawExtensions.character_book) ? rawExtensions.character_book : null;
  // Strip character_book from extensions so the in-memory Character matches the
  // ST-import shape (extensions has no character_book; it lives on its own field).
  const extensions: Record<string, unknown> = {};
  for (const key of Object.keys(rawExtensions)) {
    if (key !== "character_book") extensions[key] = rawExtensions[key];
  }

  const description = stripControlChars(content.description);
  const personality = stripControlChars(content.personalitySummary);
  const scenario = stripControlChars(content.defaultScenario);
  const firstMessage = stripControlChars(content.firstMessage);
  const exampleMessages = stripControlChars(content.mesExample);
  const systemPrompt = stripControlChars(content.systemPrompt);
  const postHistoryInstructions = stripControlChars(content.postHistoryInstructions);
  const depthPrompt = stripControlChars(content.depthPrompt);
  const creatorNotes = stripControlChars(content.creatorNotes);
  const alternateGreetings = content.alternateGreetings.map((g) => stripControlChars(g));
  const tags = content.tags.map((t) => stripControlChars(t));

  const importedAt = options.now ?? new Date().toISOString();

  const normalized: CharacterCardV3Normalized = {
    spec: "chara_card_v3",
    specVersion: "3.0",
    name,
    description,
    personality,
    scenario,
    firstMessage,
    exampleMessages,
    creatorNotes,
    systemPrompt,
    postHistoryInstructions,
    characterBook,
    depthPrompt,
    depthPromptDepth: content.depthPromptDepth,
    depthPromptRole: content.depthPromptRole,
    tags,
    creator: asOptionalString(rawExtensions.creator),
    characterVersion: asOptionalString(rawExtensions.character_version),
    alternateGreetings,
    groupOnlyGreetings: [],
    extensions,
    // The monolith carries no source `create_date`; createdAt stays null (the
    // Character row still gets `importedAt` as its real creation timestamp).
    createdAt: null,
  };

  const warnings: string[] = [];
  if (!firstMessage) warnings.push("Character card has no first message.");
  if (!scenario) warnings.push("Character card has no scenario.");

  const slug = slugify(name);
  const seed = stableJson({ vtf: 1, monolith: monolithText });
  const characterId: CharacterId = brandId<CharacterId>(
    makeDeterministicId(ENTITY_ID_NAMESPACE.character, `${slug}:${seed}`),
  );
  const versionId: CharacterVersionId = brandId<CharacterVersionId>(
    makeDeterministicId(ENTITY_ID_NAMESPACE.characterVersion, `${characterId}:${seed}`),
  );

  const characterVersionLabel =
    asOptionalString(rawExtensions.character_version) ?? `${name} import`;

  const character: Character = {
    id: characterId,
    slug,
    name,
    description,
    personalitySummary: personality || null,
    defaultScenario: scenario || null,
    firstMessage: firstMessage || null,
    mesExample: exampleMessages || null,
    // VTF-native cards carry mes-example mode/depth in the frontmatter (unlike
    // ST JSON, which has no such field and hardcodes always/4).
    mesExampleMode: content.mesExampleMode || "always",
    mesExampleDepth: Number.isFinite(content.mesExampleDepth) ? content.mesExampleDepth : 4,
    alternateGreetings,
    postHistoryInstructions: postHistoryInstructions || null,
    creatorNotes: creatorNotes || null,
    characterBook,
    depthPrompt: depthPrompt || null,
    depthPromptDepth: content.depthPromptDepth,
    depthPromptRole: content.depthPromptRole,
    extensions,
    systemPrompt: systemPrompt || null,
    tags,
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    avatarSourceAssetId: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    status: options.characterStatus ?? "active",
    createdAt: importedAt,
    updatedAt: importedAt,
  };

  const version: CharacterVersion = {
    id: versionId,
    characterId,
    title: characterVersionLabel,
    isActive: true,
    createdAt: importedAt,
  };

  return {
    format: "chara_card_v3_json",
    normalized,
    character,
    version,
    warnings,
    // VTF monoliths may carry regex_scripts in their extensions fence too.
    regexScripts: extractCardRegexScripts(rawExtensions),
  };
}
