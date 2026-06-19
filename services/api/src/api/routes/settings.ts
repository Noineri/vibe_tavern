import { Hono } from "hono";
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
    });
}
