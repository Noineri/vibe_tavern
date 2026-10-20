import { z } from "zod";

/**
 * The chat's RP default-model wire contract (SIDECHAT_PLAN SC-7) — the
 * `GET /api/agent/chats/:chatId/default-model` response.
 *
 * The RP pair exactly as the RP send resolves it (the active provider profile
 * + its selected/default model — the same store read
 * `ProviderProfileService.resolveActiveProviderProfile` wraps), READ-ONLY:
 * the sidechat host's `defaultModelBinding` (SC-13) consumes it as the
 * sidechat agent's first default, the way a kind's saved pair would be read.
 * Nullables, never `undefined`: `null` when no profile is active or the
 * active profile has no default model picked — a DEFAULT for a picker, not
 * an error (the send path keeps its own honest configuration errors). No
 * invented limits (ids are opaque store keys).
 */
export const agentChatDefaultModelSchema = z
  .object({
    providerProfileId: z.string().nullable(),
    modelName: z.string().nullable(),
  })
  .strict();
export type AgentChatDefaultModelWire = z.infer<typeof agentChatDefaultModelSchema>;
