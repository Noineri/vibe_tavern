import type { Character, CharacterId, CharacterVersion, CharacterVersionId } from "@rp-platform/domain";
import { brandId, ENTITY_ID_NAMESPACE } from "@rp-platform/domain";

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
}

export interface ImportCharacterCardOptions {
  now?: string;
  versionNumber?: number;
  characterStatus?: Character["status"];
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

  if (spec !== "chara_card_v3") {
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
    isSystem: false,
    description: cleaned.description,
    personalitySummary: cleaned.personality || null,
    defaultScenario: cleaned.scenario || null,
    firstMessage: cleaned.firstMessage || null,
    mesExample: cleaned.exampleMessages || null,
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
    status: options.characterStatus ?? "active",
    createdAt: importedAt,
    updatedAt: importedAt,
  };

  const version: CharacterVersion = {
    id: versionId,
    characterId,
    versionNumber: options.versionNumber ?? 1,
    title: normalized.characterVersion ?? `${normalized.name} import`,
    cardFormat: "st_v3",
    definition: root,
    isActive: true,
    createdAt: importedAt,
  };

  return {
    format: "chara_card_v3_json",
    normalized,
    character,
    version,
    warnings,
  };
}
