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

export const sendMessageSchema = z.object({
  content: z.string(),
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
