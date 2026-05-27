import type { MessageRole } from "@vibe-tavern/domain";

export interface ImportedVariant {
  content: string;
  isSelected: boolean;
  reasoning?: string;
}

export interface ImportedMessage {
  role: MessageRole;
  name: string | null;
  content: string;
  variants: ImportedVariant[];
  createdAt: number;
}

export interface ImportedChatMetadata {
  userName?: string;
  characterName?: string;
  chatMetadata?: Record<string, unknown>;
}

export interface ParseSillyTavernChatResult {
  metadata: ImportedChatMetadata;
  messages: ImportedMessage[];
}

export function parseSillyTavernChat(
  jsonlContent: string
): ParseSillyTavernChatResult {
  const lines = jsonlContent.split("\n");
  const messages: ImportedMessage[] = [];
  const metadata: ImportedChatMetadata = {};

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    try {
      const data = JSON.parse(trimmed);

      // Often the first line contains chat metadata in SillyTavern JSONL
      if (
        i === 0 &&
        (data.user_name || data.character_name || data.chat_metadata)
      ) {
        metadata.userName = data.user_name;
        metadata.characterName = data.character_name;
        metadata.chatMetadata = data.chat_metadata;

        // If this line doesn't have a message body, skip message processing
        if (!data.mes) {
          continue;
        }
      }

      // Skip lines that are purely system notes without text
      if (data.is_system && typeof data.mes !== "string") {
        continue;
      }

      // If it doesn't look like a message at all, skip
      if (typeof data.mes !== "string" && typeof data.name !== "string") {
        continue;
      }

      let role: MessageRole = "assistant";
      if (data.is_system) {
        role = "system";
      } else if (data.is_user) {
        role = "user";
      }

      const content = data.mes || "";
      const variants: ImportedVariant[] = [];

      // Extract swipes (variants)
      if (Array.isArray(data.swipes) && data.swipes.length > 0) {
        let selectedIndex = 0;
        if (
          typeof data.swipe_id === "number" &&
          data.swipe_id >= 0 &&
          data.swipe_id < data.swipes.length
        ) {
          selectedIndex = data.swipe_id;
        } else {
          // Fallback: match by content
          const matchIndex = data.swipes.findIndex((s: string) => s === content);
          if (matchIndex !== -1) {
            selectedIndex = matchIndex;
          }
        }

        for (let j = 0; j < data.swipes.length; j++) {
          const swipeContent = data.swipes[j];
          if (typeof swipeContent === "string") {
            const { mainContent, reasoning } = extractThinkingTags(swipeContent);
            variants.push({
              content: mainContent,
              isSelected: j === selectedIndex,
              reasoning: reasoning || undefined,
            });
          }
        }
      }

      // If there are no swipes but there is a message, create a single variant
      if (variants.length === 0 && content) {
        const { mainContent, reasoning } = extractThinkingTags(content);
        variants.push({
          content: mainContent,
          isSelected: true,
          reasoning: reasoning || undefined,
        });
      }

      let createdAt = Date.now();
      if (data.send_date) {
        const parsedDate = Number(data.send_date);
        if (!isNaN(parsedDate)) {
          createdAt = parsedDate; // some ST forks use ms timestamps
        } else {
          const date = new Date(data.send_date);
          if (!isNaN(date.getTime())) {
            createdAt = date.getTime();
          }
        }
      }

      messages.push({
        role,
        name: data.name || null,
        content,
        variants,
        createdAt,
      });
    } catch (err) {
      console.warn("Failed to parse line in SillyTavern chat import:", err);
    }
  }

  return { metadata, messages };
}

/**
 * Extracts `<thinking>...</thinking>` content from text.
 * Returns the main content (with thinking tags removed) and the reasoning text.
 * Handles both `<thinking>` and `<think</*>` tags (used by different models).
 */
function extractThinkingTags(text: string): { mainContent: string; reasoning: string | null } {
  const thinkingRegex = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
  const matches = text.match(thinkingRegex);
  if (!matches) return { mainContent: text, reasoning: null };

  const reasoning = matches
    .map((m) => {
      return m
        .replace(/^<think(?:ing)?>\s*/i, "")
        .replace(/\s*<\/think(?:ing)?>$/i, "")
        .trim();
    })
    .filter(Boolean)
    .join("\n\n");
  const mainContent = text.replace(thinkingRegex, "").trim();
  return { mainContent: mainContent || "", reasoning: reasoning || null };
}

export interface SerializeMessageInput {
  name: string;
  isUser: boolean;
  isSystem: boolean;
  content: string;
  sendDate: string;
  swipes?: string[];
  swipeId?: number;
}

export interface SerializeSillyTavernChatOptions {
  userName?: string;
  characterName?: string;
  chatMetadata?: Record<string, unknown>;
  messages: SerializeMessageInput[];
}

export function serializeSillyTavernChat(options: SerializeSillyTavernChatOptions): string {
  const lines: string[] = [];

  const metaLine: Record<string, unknown> = {};
  if (options.userName) metaLine.user_name = options.userName;
  if (options.characterName) metaLine.character_name = options.characterName;
  if (options.chatMetadata) metaLine.chat_metadata = options.chatMetadata;
  lines.push(JSON.stringify(metaLine));

  for (const msg of options.messages) {
    const line: Record<string, unknown> = {
      name: msg.name,
      is_user: msg.isUser,
      is_system: msg.isSystem,
      mes: msg.content,
      send_date: msg.sendDate,
    };

    if (msg.swipes && msg.swipes.length > 0) {
      line.swipes = msg.swipes;
      line.swipe_id = msg.swipeId ?? 0;
    }

    lines.push(JSON.stringify(line));
  }

  return lines.join("\n");
}
