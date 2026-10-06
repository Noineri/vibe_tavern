import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { SettingsRuntimeApi } from "../contract/runtime-api.js";

export function createSettingsRoutes(settings: SettingsRuntimeApi) {
  return new Hono()
    .get("/api/settings/ui", async (c) => {
      const settings_value = await settings.getUiSettings();
      return c.json(settings_value);
    })
    .patch("/api/settings/ui", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const settings_value = await settings.updateUiSettings(body);
      return c.json(settings_value);
    })
    // Script-safety singleton (SCRIPT_SAFETY_PLAN decision 3, SS-4 wiring):
    // one server-stored "don't show again" flag for the imported-script
    // warning, shared across all devices. Shapes come from the SS-3 contract.
    .get("/api/settings/script-safety", async (c) => {
      return c.json(await settings.getScriptSafetySettings());
    })
    .put("/api/settings/script-safety", zValidator("json", schemas.updateScriptSafetySettingsSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await settings.updateScriptSafetySettings(body));
    });
}
