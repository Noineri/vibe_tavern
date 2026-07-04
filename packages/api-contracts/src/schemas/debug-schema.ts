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
