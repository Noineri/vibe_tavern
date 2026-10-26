/**
 * Per-(chat, agent-kind) settings client (SIDECHAT_PLAN SC-0g) — the typed
 * twin of the SC-0e kind-settings client (`agent-kind-settings-api.ts`),
 * against the SC-0f routes:
 *
 *   GET   /api/agent/chats/:chatId/:kind/settings
 *   PATCH /api/agent/chats/:chatId/:kind/settings
 *
 * The chat's OWN copilot-profile choice for that kind's threads in that chat
 * ("use here", SC-0g), overriding the kind-wide `default_profile_id` (SC-0d)
 * in the stream's profile chain. A chat-owned kind on a chat route is
 * validated by the server; the client just sends what the host descriptor
 * targets. `profileId: null` clears the choice (falls through to the kind
 * default, then the built-in seed).
 */
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import type {
  AgentChatSettingsPatchRequest,
  AgentChatSettingsWire,
} from "@vibe-tavern/api-contracts";

/** One (chat, kind) pair's settings — the chat row's profile choice, or
 *  `profileId: null` / `updatedAt: null` when the pair has no row yet (a
 *  chat row has no legacy fallback). */
export async function getAgentChatSettings(
  chatId: string,
  kind: string,
): Promise<AgentChatSettingsWire> {
  const response = await client.api.agent.chats[":chatId"][":kind"].settings.$get({
    param: { chatId, kind },
  });
  return unwrapRpc(response);
}

/** Upsert one (chat, kind) pair's settings: only the fields present are
 *  written (absent keeps the stored value, `null` clears it). Returns the
 *  updated row. */
export async function patchAgentChatSettings(
  chatId: string,
  kind: string,
  patch: AgentChatSettingsPatchRequest,
): Promise<AgentChatSettingsWire> {
  const response = await client.api.agent.chats[":chatId"][":kind"].settings.$patch({
    param: { chatId, kind },
    json: patch,
  });
  return unwrapRpc(response);
}
