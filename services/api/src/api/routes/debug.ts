import { Hono } from "hono";
import type { BootstrapRuntimeApi } from "../contract/runtime-api.js";

export function createDebugRoutes(runtime: BootstrapRuntimeApi) {
  return new Hono()
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
