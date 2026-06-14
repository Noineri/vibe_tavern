import { Hono } from "hono";
import type { BootstrapRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import { logSendDebug } from "../../send-debug-log.js";
import * as schemas from "@vibe-tavern/api-contracts";

export function createDebugRoutes(runtime: BootstrapRuntimeApi) {
  return new Hono()
    .post("/api/debug/send-log", zValidator("json", schemas.debugSendLogSchema), async (c) => {
      const body = c.req.valid("json");
      logSendDebug("web.debug", typeof body === "object" && body ? body as Record<string, unknown> : { body });
      return c.json({ ok: true });
    })
    .get("/api/bootstrap", async (c) => {
      return c.json(await runtime.bootstrap());
    })
    .get("/api/defaults/ai-assistant-prompt", async (c) => {
      const { getDefaultPromptForMode } = await import("../../domain/ai-assistant/ai-assistant-prompts.js");
      const mode = c.req.query("mode") ?? "script";
      return c.json({ prompt: await getDefaultPromptForMode(mode as never) });
    })
  ;
}
