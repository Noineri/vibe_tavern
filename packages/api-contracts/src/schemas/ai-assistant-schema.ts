import { z } from "zod";

/** Universal AI assistant modes; mirrors `AiAssistantMode` in @vibe-tavern/prompt-pipeline. */
export const aiAssistantModeSchema = z.enum([
  "script",
  "dice_script",
  "lore_entry",
  "lore_keys",
  "chat_impersonate",
  "md_import",
  "vision_describe",
  "scene_schema",
  "scene_rules",
  "message_edit",
  "message_merge",
  "message_tts_annotate",
  "regex",
]);

/** Body of POST /api/ai-assistant and POST /api/ai-assistant/tokens. */
export const aiAssistantRequestSchema = z.object({
  mode: aiAssistantModeSchema,
  /** User's instruction / prompt text. */
  instruction: z.string(),
  /** Current field content being edited/refined. */
  existingContent: z.string().optional(),
  providerProfileId: z.string(),
  /** Model override; the profile default is used when omitted. */
  model: z.string().optional(),
  /** Context layers the user toggled on. */
  enabledLayers: z.array(z.string()),
  characterIds: z.array(z.string()).optional(),
  personaIds: z.array(z.string()).optional(),
  loreEntryIds: z.array(z.string()).optional(),
  /** Whole lorebooks; the backend expands their enabled entries. */
  lorebookIds: z.array(z.string()).optional(),
  /** chat_impersonate: chat whose history is used. */
  chatId: z.string().optional(),
  /** chat_impersonate: how many recent messages to include (server default 20). */
  recentMessageCount: z.number().optional(),
  /** message_edit/message_merge: canonical target message in the chat's active branch. */
  targetMessageId: z.string().optional(),
  /** message_edit/message_merge: immutable variant ids selected as editor sources. */
  sourceVariantIds: z.array(z.string()).optional(),
  /** lore_keys: existing primary keys (for de-duplication). */
  existingKeys: z.array(z.string()).optional(),
  existingSecondaryKeys: z.array(z.string()).optional(),
  /** lore_keys: the entry's activation logic mode. */
  logic: z.string().optional(),
  /** lore_keys: which key set to generate (server default "both"). */
  keyTarget: z.enum(["primary", "secondary", "both"]).optional(),
  /** md_import: max output tokens for structured generation (server default 10000). */
  maxOutputTokens: z.number().optional(),
  /** Temperature override; per-mode defaults apply when omitted. */
  temperature: z.number().optional(),
  /** scene_schema: selects the format-aware default prompt (json/xml). */
  promptFormat: z.enum(["json", "xml"]).optional(),
});
export type AiAssistantRequest = z.infer<typeof aiAssistantRequestSchema>;

/** One SSE `data:` payload of POST /api/ai-assistant. */
export interface AiAssistantStreamChunk {
  type: "text" | "reasoning" | "partial_json" | "error" | "done";
  text?: string;
  json?: Record<string, unknown>;
  error?: string;
  /** Present only on the `done` chunk of message editor completions (merge provenance). */
  modelId?: string;
  promptPresetId?: string | null;
  finishReason?: string;
}

/** Response of POST /api/ai-assistant/tokens. */
export interface AiAssistantTokenCount {
  tokens: number;
  model: string;
  layerCount: number;
  messageCount: number;
  activatedLoreCount: number;
}
