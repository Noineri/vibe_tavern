import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { MAX_USER_THEME_BYTES, uploadUserThemeSchema } from "@vibe-tavern/api-contracts";
import type { UserThemeRuntimeApi } from "../contract/user-theme-api.js";

export function createUserThemeRoutes(runtime: UserThemeRuntimeApi) {
  return new Hono()
    // JSON can escape each source character into six bytes. The library
    // separately enforces the decoded CSS's 1 MiB UTF-8/storage limit.
    .use("/api/user-themes", bodyLimit({ maxSize: MAX_USER_THEME_BYTES * 6 + 2048 }))
    .get("/api/user-themes", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await runtime.listUserThemes());
    })
    .post("/api/user-themes", zValidator("json", uploadUserThemeSchema), async (c) => {
      return c.json(await runtime.uploadUserTheme(c.req.valid("json")), 201);
    })
    .get("/api/user-themes/:themeId", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await runtime.readUserTheme(c.req.param("themeId")));
    })
    .delete("/api/user-themes/:themeId", async (c) => {
      await runtime.deleteUserTheme(c.req.param("themeId"));
      return c.json({ ok: true });
    });
}
