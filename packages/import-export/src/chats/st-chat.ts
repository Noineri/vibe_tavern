import type { MessageRole } from "@rp-platform/domain";

export interface ImportedVariant {
  content: string;
  isSelected: boolean;
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
            variants.push({
              content: swipeContent,
              isSelected: j === selectedIndex,
            });
          }
        }
      }

      // If there are no swipes but there is a message, create a single variant
      if (variants.length === 0 && content) {
        variants.push({
          content: content,
          isSelected: true,
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
