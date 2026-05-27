import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createPresetRoutes(runtime: RuntimeApi) {
  return new Hono()
    .get("/api/prompt-presets", async (c) => {
      return c.json(await runtime.listPromptPresets());
    })
    .post("/api/prompt-presets", zValidator("json", schemas.createPromptPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createPromptPreset(body), 201);
    })
    .patch("/api/prompt-presets/:presetId", zValidator("json", schemas.updatePromptPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updatePromptPreset(c.req.param("presetId"), body));
    })
    .delete("/api/prompt-presets/:presetId", async (c) => {
      await runtime.deletePromptPreset(c.req.param("presetId"));
      return c.body(null, 204);
    })
  ;
}
