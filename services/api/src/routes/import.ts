import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@rp-platform/api-contracts";

export function createImportRoutes(runtime: RuntimeApi) {
  return new Hono()
    .post("/api/import/json", zValidator("json", schemas.importJsonSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.importJson(body));
    })
    .post("/api/import/st-scan", async (c) => {
      const body = await c.req.json<{ path?: string }>();
      if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
      try {
        const result = await runtime.scanSillyTavernDirectory(body.path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/api/import/st-directory", async (c) => {
      const body = await c.req.json<{ path?: string }>();
      if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
      try {
        const result = await runtime.importSillyTavernDirectory(body.path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
  ;
}
