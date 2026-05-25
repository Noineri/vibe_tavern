import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";

export function createSettingsRoutes(runtime: RuntimeApi) {
  return new Hono()
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
