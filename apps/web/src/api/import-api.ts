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
  lean?: boolean;
}): Promise<ImportJsonResponse> {
  const response = await client.api.import.json.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  // Snapshot is absent on the lean mass-import path — only normalize when present.
  return data.snapshot ? { ...data, snapshot: normalizeSnapshot(data.snapshot) } : data;
}

export interface BatchImportItemResult {
  fileName: string;
  characterId?: string;
  activeChatId?: ChatId;
  error?: string;
}

/**
 * Mass-import batch: sends up to N parsed cards in one request (POST
 * /api/import/batch) instead of N roundtrips. Server processes per-item with
 * try/catch, so one bad card lands in results[].error rather than failing the
 * whole batch. Defaults to lean (no getSnapshot). See import-api batch client +
 * ImportModals Phase 1.
 */
export async function importJsonBatch(input: {
  items: Array<{ fileName: string; jsonText: string; chatId?: ChatId; skipExisting?: boolean }>;
  lean?: boolean;
}): Promise<{ results: BatchImportItemResult[] }> {
  const response = await client.api.import.batch.$post({ json: input });
  return unwrapRpc<{ results: BatchImportItemResult[] }>(response);
}
