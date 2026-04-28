import type {
  Chat,
  ChatBranch,
  Character,
  CharacterVersion,
  LoreEntry,
  Message,
  MessageVariant,
  PromptPreset,
  PromptPresetId,
  PromptTrace,
  SummaryMemorySnapshot,
} from "@rp-platform/domain";
import type { SqliteRow } from "./sqlite-adapter.js";

export type ChatRow = SqliteRow & {
  id: string;
  character_id: string;
  persona_id: string;
  title: string;
  status: string;
  active_branch_id: string;
  prompt_preset_id: string;
  tool_profile_id: string;
  created_at: string;
  updated_at: string;
};

export type ChatBranchRow = SqliteRow & {
  id: string;
  chat_id: string;
  parent_branch_id: string | null;
  forked_from_message_id: string | null;
  label: string;
  created_at: string;
};

export type MessageRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  role: string;
  author_type: string;
  position: number;
  content: string;
  state: string;
  created_at: string;
  updated_at: string;
};

export type SummaryRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  kind: string;
  summary: string;
  covers_through_message_id: string;
  created_at: string;
};

export type MessageVariantRow = SqliteRow & {
  id: string;
  message_id: string;
  variant_index: number;
  content: string;
  is_selected: number;
  finish_reason: string | null;
  created_at: string;
};

export type PersonaRow = SqliteRow & {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatar_asset_id: string | null;
  default_for_new_chats: number;
  created_at: string;
  updated_at: string;
};

export type PromptTraceRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  message_id: string;
  model: string;
  preset_name: string;
  assembled_layers_json: string;
  token_accounting_json: string;
  activated_lore_entries_json: string;
  retrieved_memories_json: string;
  final_payload_json: string;
  latency_ms: number;
  created_at: string;
};

export type PositionRow = SqliteRow & {
  max_position: number | null;
};

export type CharacterRow = SqliteRow & {
  id: string;
  slug: string;
  name: string;
  description: string;
  personality_summary: string | null;
  default_scenario: string | null;
  first_message: string | null;
  mes_example: string | null;
  alternate_greetings_json: string;
  post_history_instructions: string | null;
  creator_notes: string | null;
  character_book_json: string | null;
  depth_prompt: string | null;
  depth_prompt_depth: number | null;
  depth_prompt_role: string | null;
  extensions_json: string;
  system_prompt: string | null;
  tags_json: string;
  avatar_asset_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type CharacterVersionRow = SqliteRow & {
  id: string;
  character_id: string;
  version_number: number;
  title: string;
  card_format: string;
  definition_json: string;
  is_active: number;
  created_at: string;
};

export type LoreEntryRow = SqliteRow & {
  id: string;
  lorebook_id: string;
  title: string;
  content: string;
  keys_json: string;
  secondary_keys_json: string;
  logic: string;
  position: string;
  depth: number;
  priority: number;
  sticky_window: number;
  cooldown_window: number;
  delay_window: number;
  enabled: number;
  metadata_json: string;
};

export type PromptPresetRow = SqliteRow & {
  id: string;
  name: string;
  bind_model: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  created_at: string;
  updated_at: string;
};

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function mapChat(row: ChatRow): Chat {
  return {
    id: row.id,
    characterId: row.character_id,
    personaId: row.persona_id,
    title: row.title,
    status: row.status as Chat["status"],
    activeBranchId: row.active_branch_id,
    promptPresetId: row.prompt_preset_id,
    toolProfileId: row.tool_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    personalitySummary: row.personality_summary,
    defaultScenario: row.default_scenario,
    firstMessage: row.first_message,
    mesExample: row.mes_example,
    alternateGreetings: parseJson<string[]>(row.alternate_greetings_json),
    postHistoryInstructions: row.post_history_instructions,
    creatorNotes: row.creator_notes,
    characterBook: row.character_book_json ? parseJson<Record<string, unknown>>(row.character_book_json) : null,
    depthPrompt: row.depth_prompt,
    depthPromptDepth: row.depth_prompt_depth,
    depthPromptRole: row.depth_prompt_role,
    extensions: parseJson<Record<string, unknown>>(row.extensions_json),
    systemPrompt: row.system_prompt,
    tags: parseJson<string[]>(row.tags_json),
    avatarAssetId: row.avatar_asset_id,
    status: row.status as Character["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCharacterVersion(row: CharacterVersionRow): CharacterVersion {
  return {
    id: row.id,
    characterId: row.character_id,
    versionNumber: row.version_number,
    title: row.title,
    cardFormat: row.card_format as CharacterVersion["cardFormat"],
    definition: parseJson<Record<string, unknown>>(row.definition_json),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

export function mapLoreEntry(row: LoreEntryRow): LoreEntry {
  return {
    id: row.id,
    lorebookId: row.lorebook_id,
    title: row.title,
    content: row.content,
    keys: parseJson<string[]>(row.keys_json),
    secondaryKeys: parseJson<string[]>(row.secondary_keys_json),
    logic: row.logic as LoreEntry["logic"],
    position: row.position as LoreEntry["position"],
    depth: row.depth,
    priority: row.priority,
    stickyWindow: row.sticky_window,
    cooldownWindow: row.cooldown_window,
    delayWindow: row.delay_window,
    enabled: row.enabled === 1,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
  };
}

export function mapBranch(row: ChatBranchRow): ChatBranch {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentBranchId: row.parent_branch_id,
    forkedFromMessageId: row.forked_from_message_id,
    label: row.label,
    createdAt: row.created_at,
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    role: row.role as Message["role"],
    authorType: row.author_type as Message["authorType"],
    position: row.position,
    content: row.content,
    state: row.state as Message["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMessageVariant(row: MessageVariantRow): MessageVariant {
  return {
    id: row.id,
    messageId: row.message_id,
    variantIndex: row.variant_index,
    content: row.content,
    isSelected: row.is_selected === 1,
    finishReason: row.finish_reason,
    createdAt: row.created_at,
  };
}

export function mapSummary(row: SummaryRow): SummaryMemorySnapshot {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    kind: row.kind as SummaryMemorySnapshot["kind"],
    summary: row.summary,
    coversThroughMessageId: row.covers_through_message_id,
    createdAt: row.created_at,
  };
}

export function mapPromptTrace(row: PromptTraceRow): PromptTrace {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    messageId: row.message_id,
    model: row.model,
    presetName: row.preset_name,
    assembledLayers: parseJson<PromptTrace["assembledLayers"]>(row.assembled_layers_json),
    tokenAccounting: parseJson<Record<string, number>>(row.token_accounting_json),
    activatedLoreEntries: parseJson<string[]>(row.activated_lore_entries_json),
    retrievedMemories: parseJson<Array<Record<string, unknown>>>(row.retrieved_memories_json),
    finalPayload: parseJson<Record<string, unknown>>(row.final_payload_json),
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export function mapPromptPreset(row: PromptPresetRow): PromptPreset {
  return {
    id: row.id as PromptPresetId,
    name: row.name,
    bindModel: row.bind_model,
    system: row.system,
    jailbreak: row.jailbreak,
    summary: row.summary,
    tools: row.tools,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
