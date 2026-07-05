import { z } from "zod";

export const debugSendLogSchema = z.any();

export const importJsonSchema = z.object({
  fileName: z.string(),
  jsonText: z.string(),
  chatId: z.string().optional(),
  skipExisting: z.boolean().optional(),
  // When true, the server skips the O(N²) getSnapshot rebuild and returns only
  // { activeChatId, characterId, imported } — the mass-import path reads nothing
  // else. Single-card import (no flag) keeps the full snapshot, byte-identical.
  lean: z.boolean().optional(),
});

// Mass-import batch: the frontend chunks parsed cards into batches (default 50)
// and sends them here so the server processes them in one request instead of N.
// The server loops the existing importJson per item with per-item try/catch —
// a failed item is collected into results[].error rather than aborting the
// batch. No cross-store transaction (each store owns its own connection; the
// server is already ~8ms/card per bench #4, so sequential per-item is fine).
// Capped at 200 items so a single request body stays bounded.
export const importJsonBatchSchema = z.object({
  items: z.array(importJsonSchema.omit({ lean: true })).max(200),
  lean: z.boolean().optional(),
});
