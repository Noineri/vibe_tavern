import { Hono } from "hono";
import type { MobileAccessRuntimeApi } from "../contract/runtime-api.js";

export function createMobileAccessRoutes(mobileAccess: MobileAccessRuntimeApi) {
  return new Hono()
    .get("/api/settings/mobile-access", async (c) => {
      const info = await mobileAccess.getMobileAccessInfo();
      return c.json(info);
    })
    .post("/api/settings/mobile-access/regenerate", async (c) => {
      const result = await mobileAccess.regenerateMobileAccessToken();
      return c.json(result);
    })
    .delete("/api/settings/mobile-access", async (c) => {
      const result = await mobileAccess.revokeMobileAccess();
      return c.json(result);
    });
}
