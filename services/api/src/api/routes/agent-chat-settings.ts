import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import { mapAgentKindError } from "./agent-kind-error-map.js";

/**
 * Per-(chat, agent-kind) profile-choice routes (SIDECHAT_PLAN SC-0f):
 *
 *   GET   /api/agent/chats/:chatId/:kind/settings
 *   PATCH /api/agent/chats/:chatId/:kind/settings
 *
 * The chat's OWN copilot-profile choice for that kind's threads in that chat
 * ("use here", SC-0g) — the FIRST step of the stream's chat-owned profile
 * chain (chat row → the kind's `default_profile_id` → the kind's built-in; a
 * dangling id falls through, never errors). These are CHAT-OWNER routes: the
 * `:kind` segment is validated through the registry exactly like the SC-0b
 * lifecycle routes — an unregistered kind is a 400 `UNKNOWN_AGENT_KIND`, a
 * registered but script-owned kind a 400 `AGENT_KIND_NOT_CHAT_OWNED` (both
 * mapped by the shared {@link mapAgentKindError}); a missing chat is a 404
 * (the adapter throws the `NotFound` DomainError the app-level handler maps).
 * The GET response on a pair with no row yet is `profileId: null` /
 * `updatedAt: null` (a chat row has no legacy fallback). The PATCH body is
 * `.strict()`: unknown keys are rejected, absent fields keep their stored
 * value, `null` clears the choice.
 */
export function createAgentChatSettingsRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .get("/api/agent/chats/:chatId/:kind/settings", async (c) => {
      const { chatId, kind } = c.req.param();
      try {
        return c.json(await runtime.agentChatGetSettings(chatId, kind));
      } catch (err) {
        const mapped = mapAgentKindError(c, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    })
    .patch(
      "/api/agent/chats/:chatId/:kind/settings",
      zValidator("json", schemas.agentChatSettingsPatchSchema),
      async (c) => {
        const { chatId, kind } = c.req.param();
        const body = c.req.valid("json");
        try {
          return c.json(await runtime.agentChatPatchSettings(chatId, kind, body));
        } catch (err) {
          const mapped = mapAgentKindError(c, err);
          if (mapped !== null) return mapped;
          throw err;
        }
      },
    );
}
