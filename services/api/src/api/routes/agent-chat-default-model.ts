import { Hono } from "hono";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";

/**
 * The chat's RP default-model route (SIDECHAT_PLAN SC-7):
 *
 *   GET /api/agent/chats/:chatId/default-model
 *
 * Returns the RP chat's active provider profile + its selected model — the
 * pair the RP send itself resolves (read-only; the adapter reads the same
 * `providers.getActive()` store seam `resolveActiveProviderProfile` wraps)
 * — for the sidechat host's `defaultModelBinding` (SC-13) to consume as the
 * sidechat agent's first default. Nulls, never an error, when nothing is
 * active or the active profile has no default model: a picker default, not
 * a send.
 *
 * The chat-scoped twin of the SC-0f settings family: no `:kind` segment
 * (every kind's sidechat in the chat shares the same RP pair, so there is no
 * registry validation and no `mapAgentKindError` mapping here), and no
 * `:branchId` segment (nothing branch-scoped is read — hence no
 * chat-branch-ownership pair check). A missing chat is a 404: the adapter
 * throws the `NotFound` DomainError the app-level handler maps, exactly like
 * the sibling chat-scoped routes.
 */
export function createAgentChatDefaultModelRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono().get("/api/agent/chats/:chatId/default-model", async (c) => {
    const { chatId } = c.req.param();
    return c.json(await runtime.agentChatGetDefaultModel(chatId));
  });
}
