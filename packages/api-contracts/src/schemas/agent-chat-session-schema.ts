import { z } from "zod";

/**
 * Body for `POST /api/agent/chats/:chatId/branches/:branchId/:kind/session`
 * (SIDECHAT_PLAN SC-0b): start a fresh session for the (chat, branch, kind)
 * triple. The optional `title` mirrors the script-owner twin
 * (`POST /api/experience-copilot/script/:scriptId/session`); the route wraps
 * the whole body in `.optional()` so a body-less POST is valid, exactly like
 * the script one. `.strict()` rejects unknown keys (the api-contracts norm).
 */
export const agentChatSessionCreateSchema = z
  .object({
    title: z.string().optional(),
  })
  .strict();
export type AgentChatSessionCreateRequest = z.infer<typeof agentChatSessionCreateSchema>;
