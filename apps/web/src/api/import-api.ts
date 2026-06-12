import type { ImportJsonResponse } from "./types.js";
import type { ChatId } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";

export async function importJson(input: {
  fileName: string;
  jsonText: string;
  chatId?: ChatId;
  skipExisting?: boolean;
}): Promise<ImportJsonResponse> {
  const response = await client.api.import.json.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return { ...data, snapshot: normalizeSnapshot(data.snapshot) };
}
