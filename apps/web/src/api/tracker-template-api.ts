import type { ChatId, TrackerTemplate } from "@vibe-tavern/domain";
import type { AppSnapshot } from "./types.js";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

/** Apply the active character's portable tracker setup to an RP chat. */
export async function applyCharacterTrackerTemplate(chatId: ChatId): Promise<AppSnapshot> {
  const response = await client.api.chats[":chatId"].insights["apply-character-template"].$post({ param: { chatId } });
  return unwrapRpc(response);
}

/** Save a chat's portable tracker setup as its character template. */
export async function saveAsCharacterTrackerTemplate(chatId: ChatId): Promise<TrackerTemplate> {
  const response = await client.api.chats[":chatId"].insights["save-as-character-template"].$post({ param: { chatId } });
  return (await unwrapRpc(response)).template;
}
