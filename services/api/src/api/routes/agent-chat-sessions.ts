import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import { mapAgentKindError } from "./agent-kind-error-map.js";

/**
 * Chat-owner agent-session lifecycle routes (SIDECHAT_PLAN SC-0b) — the
 * chat-branch twin of the script lifecycle in experience-copilot.ts:
 *
 *   GET  /api/agent/chats/:chatId/branches/:branchId/:kind/active
 *   GET  /api/agent/chats/:chatId/branches/:branchId/:kind/sessions
 *   POST /api/agent/chats/:chatId/branches/:branchId/:kind/session  { title? }
 *
 * The members live on the same runtime slice (the ER-3 thread store serves
 * both owners) and validate the `:kind` segment through the agent-kind
 * registry: an unregistered kind is a 400 `UNKNOWN_AGENT_KIND`, a registered
 * kind that is not chat-owned a 400 `AGENT_KIND_NOT_CHAT_OWNED` — both mapped
 * to the same `{ error, code }` JSON shape the copilot stream/compact routes
 * use for registry errors. A missing chat, a missing branch, or a branch that
 * belongs to a different chat is a 404 (the adapter throws the `NotFound`
 * DomainError the app-level handler maps). The per-thread routes
 * (`/api/experience-copilot/:threadId/...`) are owner-agnostic and unchanged:
 * a chat-owned thread is served by them exactly like a script-owned one.
 *
 * The registry-error → 400 mapping is the shared {@link mapAgentKindError}
 * (agent-kind-error-map.ts, also used by the SC-0d kind-settings routes).
 */

export function createAgentChatSessionsRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .get("/api/agent/chats/:chatId/branches/:branchId/:kind/active", async (c) => {
      const { chatId, branchId, kind } = c.req.param();
      try {
        return c.json(await runtime.agentChatGetActive(chatId, branchId, kind));
      } catch (err) {
        const mapped = mapAgentKindError(c, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    })
    .get("/api/agent/chats/:chatId/branches/:branchId/:kind/sessions", async (c) => {
      const { chatId, branchId, kind } = c.req.param();
      try {
        return c.json(await runtime.agentChatListSessions(chatId, branchId, kind));
      } catch (err) {
        const mapped = mapAgentKindError(c, err);
        if (mapped !== null) return mapped;
        throw err;
      }
    })
    .post(
      "/api/agent/chats/:chatId/branches/:branchId/:kind/session",
      // The whole body is optional (a body-less POST starts an untitled
      // session) — the same validator shape as the script-owner twin.
      zValidator("json", schemas.agentChatSessionCreateSchema.optional()),
      async (c) => {
        const { chatId, branchId, kind } = c.req.param();
        const body = c.req.valid("json");
        try {
          return c.json(await runtime.agentChatStartNewSession(chatId, branchId, kind, body?.title));
        } catch (err) {
          const mapped = mapAgentKindError(c, err);
          if (mapped !== null) return mapped;
          throw err;
        }
      },
    );
}
