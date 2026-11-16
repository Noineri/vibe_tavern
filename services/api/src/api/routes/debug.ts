import { Hono } from "hono";
import type { BootstrapRuntimeApi } from "../contract/runtime-api.js";
import { aiAssistantModeSchema } from "@vibe-tavern/api-contracts";

export function createDebugRoutes(runtime: BootstrapRuntimeApi) {
  return new Hono()
    .get("/api/bootstrap", async (c) => {
      return c.json(await runtime.bootstrap());
    })
    .get("/api/defaults/ai-assistant-prompt", async (c) => {
      const { getDefaultPromptForMode } = await import("../../domain/ai-assistant/ai-assistant-prompts.js");
      // The query param is user input: validate against the contract's mode
      // enum (the same source the assistant route uses). Absent or unknown
      // mode falls back to the documented default ("lore_entry") instead of
      // the thrown "Unknown AI assistant mode" 500 the old `as never` cast
      // masked.
      const parsed = aiAssistantModeSchema.safeParse(c.req.query("mode") ?? "lore_entry");
      const mode = parsed.success ? parsed.data : "lore_entry";
      return c.json({ prompt: await getDefaultPromptForMode(mode) });
    })
  ;
}
