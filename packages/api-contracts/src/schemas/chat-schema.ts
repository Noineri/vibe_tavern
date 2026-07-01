import { z } from "zod";

export const createChatSchema = z.object({
  characterId: z.string(),
  /** Chat mode. Omit for the default 'rp'. Allowed values mirror CHAT_MODE. */
  mode: z.enum(["rp", "coauthor", "novel", "group"]).optional(),
});

export const cloneChatSchema = z.object({});

export const attachmentSchema = z.object({
  /** Stable attachment id — correlates vision descriptions back to specific attachments. */
  id: z.string().min(1),
  assetId: z.string().min(1),
  type: z.enum(["image", "file", "video"]),
  name: z.string().max(255),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive().max(50_000_000),
});

export const sendMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(attachmentSchema).max(5).optional(),
});

export const editMessageSchema = z.object({
  content: z.string().optional().default(""),
});

export const renameChatSchema = z.object({
  title: z.string(),
});

export const setGreetingIndexSchema = z.object({
  greetingIndex: z.number().int().min(0),
});

export const renameBranchSchema = z.object({
  label: z.string().min(1),
});
