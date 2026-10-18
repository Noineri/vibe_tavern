import { z } from "zod";

/**
 * Per-(chat, agent-kind) settings wire contracts (SIDECHAT_PLAN SC-0f) — the
 * `GET/PATCH /api/agent/chats/:chatId/:kind/settings` routes: the chat's OWN
 * copilot-profile choice for that kind's threads in that chat ("use here",
 * SC-0g), overriding the kind-wide `default_profile_id` (SC-0d) in the
 * stream's profile chain.
 *
 * `profileId` follows the ui_settings dangling-id policy: nullable, no FK —
 * a dangling id resolves with a fallback at the consumer (the stream chain),
 * never a blocked delete. No invented limits (the kind id and profile id are
 * opaque registry/store keys).
 */

/** One (chat, kind) pair's settings — the GET/PATCH response body. Nullable
 *  fields are `null`, never `undefined`; `updatedAt: null` marks a pair with
 *  no row yet (a chat row has no legacy source to fall back to). */
export const agentChatSettingsSchema = z
  .object({
    chatId: z.string(),
    agentKind: z.string(),
    profileId: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type AgentChatSettingsWire = z.infer<typeof agentChatSettingsSchema>;

/** Body for `PATCH /api/agent/chats/:chatId/:kind/settings`: only the fields
 *  present are written (absent keeps the stored value, `null` clears it).
 *  `.strict()` rejects unknown keys (the api-contracts norm). */
export const agentChatSettingsPatchSchema = z
  .object({
    profileId: z.string().nullable().optional(),
  })
  .strict();
export type AgentChatSettingsPatchRequest = z.infer<typeof agentChatSettingsPatchSchema>;
