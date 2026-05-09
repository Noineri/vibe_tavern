import type { Character, CharacterVersion } from "@rp-platform/domain";

export type CharacterRecord = {
  id: string;
  name: string;
  description: string;
  scenario: string;
  systemPrompt: string;
  personality: string | null;
  personalitySummary: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  tags: string[];
  subtitle: string;
};

export type PersonaRecord = {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
};

export function toCharacterRecord(
  character: Character,
  version: CharacterVersion | null,
): CharacterRecord {
  const definition = version?.definition ?? {};
  const data =
    definition && typeof definition.data === "object" && definition.data !== null
      ? (definition.data as Record<string, unknown>)
      : definition;
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const subtitleCandidate =
    (typeof data.character_version === "string" && data.character_version.trim()) ||
    tags[0] ||
    version?.title ||
    "Imported character";

  return {
    id: character.id,
    name: character.name,
    description: character.description,
    scenario: character.defaultScenario ?? "",
    systemPrompt: character.systemPrompt ?? ((data.system_prompt as string) || ""),
    personality: character.personalitySummary ?? ((data.personality as string) || null),
    personalitySummary: character.personalitySummary ?? ((data.personality as string) || null),
    firstMessage: character.firstMessage,
    mesExample: character.mesExample,
    alternateGreetings: character.alternateGreetings,
    postHistoryInstructions: character.postHistoryInstructions,
    creatorNotes: character.creatorNotes,
    characterBook: character.characterBook,
    depthPrompt: character.depthPrompt,
    depthPromptDepth: character.depthPromptDepth,
    depthPromptRole: character.depthPromptRole,
    extensions: character.extensions,
    tags: character.tags,
    subtitle: subtitleCandidate,
  };
}

export function applyCharacterEditsToDefinition(
  definition: Record<string, unknown>,
  input: {
    name: string;
    description: string;
    personalitySummary: string | null;
    scenario: string;
    systemPrompt: string;
    firstMessage: string | null;
    mesExample: string | null;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
    characterBook: Record<string, unknown> | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    extensions: Record<string, unknown>;
    tags: string[];
  },
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
  const nestedData = cloned.data;
  const target =
    typeof nestedData === "object" && nestedData !== null && !Array.isArray(nestedData)
      ? (nestedData as Record<string, unknown>)
      : cloned;

  cloned.name = input.name;
  cloned.description = input.description;
  cloned.personality = input.personalitySummary;
  cloned.scenario = input.scenario;
  cloned.system_prompt = input.systemPrompt;
  cloned.first_mes = input.firstMessage;
  cloned.mes_example = input.mesExample;
  cloned.alternate_greetings = input.alternateGreetings;
  cloned.post_history_instructions = input.postHistoryInstructions;
  cloned.creator_notes = input.creatorNotes;
  cloned.character_book = input.characterBook;
  cloned.depth_prompt = input.depthPrompt;
  cloned.depth_prompt_depth = input.depthPromptDepth;
  cloned.depth_prompt_role = input.depthPromptRole;
  cloned.extensions = input.extensions;
  cloned.tags = input.tags;
  target.name = input.name;
  target.description = input.description;
  target.personality = input.personalitySummary;
  target.scenario = input.scenario;
  target.system_prompt = input.systemPrompt;
  target.first_mes = input.firstMessage;
  target.mes_example = input.mesExample;
  target.alternate_greetings = input.alternateGreetings;
  target.post_history_instructions = input.postHistoryInstructions;
  target.creator_notes = input.creatorNotes;
  target.character_book = input.characterBook;
  target.depth_prompt = input.depthPrompt;
  target.depth_prompt_depth = input.depthPromptDepth;
  target.depth_prompt_role = input.depthPromptRole;
  target.extensions = input.extensions;
  target.tags = input.tags;
  return cloned;
}
