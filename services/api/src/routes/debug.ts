import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import { logSendDebug } from "../send-debug-log.js";
import * as schemas from "@vibe-tavern/api-contracts";

export function createDebugRoutes(runtime: RuntimeApi) {
  return new Hono()
    .post("/api/debug/send-log", zValidator("json", schemas.debugSendLogSchema), async (c) => {
      const body = c.req.valid("json");
      logSendDebug("web.debug", typeof body === "object" && body ? body as Record<string, unknown> : { body });
      return c.json({ ok: true });
    })
    .get("/api/bootstrap", async (c) => {
      return c.json(await runtime.bootstrap());
    })
    .get("/api/defaults/script-ai-prompt", async (c) => {
      const { getDefaultScriptAiPrompt } = await import("../script-ai-assistant.js");
      return c.json({ prompt: await getDefaultScriptAiPrompt() });
    })
  ;
}
