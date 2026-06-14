import { Hono } from "hono";
import type { SettingsRuntimeApi, MobileAccessRuntimeApi } from "../api/contract/runtime-api.js";

export function createSettingsRoutes(runtime: SettingsRuntimeApi & MobileAccessRuntimeApi) {
  return new Hono()
    .get("/api/settings/ui", async (c) => {
      const settings = await runtime.getUiSettings();
      return c.json(settings);
    })
    .patch("/api/settings/ui", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const settings = await runtime.updateUiSettings(body);
      return c.json(settings);
    })
    .get("/api/settings/mobile-access", async (c) => {
      const info = await runtime.getMobileAccessInfo();
      return c.json(info);
    })
    .post("/api/settings/mobile-access/regenerate", async (c) => {
      const result = await runtime.regenerateMobileAccessToken();
      return c.json(result);
    })
    .delete("/api/settings/mobile-access", async (c) => {
      const result = await runtime.revokeMobileAccess();
      return c.json(result);
    });
}
