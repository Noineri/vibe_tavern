import type { ChatId } from "@vibe-tavern/domain";
import type { CharacterTab } from "../components/layout/app-shell-types.js";

export function buildCharacterTabs(
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarCropJson: string | null }>,
  chats: Array<{ id: ChatId; characterId: string }>,
): CharacterTab[] {
  const chatByCharId = new Map<string, ChatId>();
  for (const chat of chats) {
    if (!chatByCharId.has(chat.characterId)) {
      chatByCharId.set(chat.characterId, chat.id);
    }
  }

  return allCharacters.map((char) => ({
    id: char.id,
    name: char.name,
    subtitle: char.subtitle,
    chatId: chatByCharId.get(char.id) ?? null,
    avatarAssetId: char.avatarAssetId,
    avatarCropJson: char.avatarCropJson,
  }));
}
