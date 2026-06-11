import { z } from "zod";

export const createChatSchema = z.object({
  characterId: z.string().optional(),
});

export const cloneChatSchema = z.object({});

export const updateChatSettingsSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  scenario: z.string(),
  systemPrompt: z.string(),
});

export const attachmentSchema = z.object({
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
