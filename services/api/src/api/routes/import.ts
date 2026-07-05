import { Hono } from "hono";
import type { ImportExportRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createImportRoutes(runtime: ImportExportRuntimeApi) {
  return new Hono()
    .post("/api/import/json", zValidator("json", schemas.importJsonSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.importJson(body));
    })
    .post("/api/import/batch", zValidator("json", schemas.importJsonBatchSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.importJsonBatch(body));
    })
    .post("/api/import/st-scan", zValidator("json", schemas.stDirectoryPathSchema), async (c) => {
      const { path } = c.req.valid("json");
      try {
        const result = await runtime.scanSillyTavernDirectory(path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/api/import/st-directory", zValidator("json", schemas.stDirectoryPathSchema), async (c) => {
      const { path } = c.req.valid("json");
      try {
        const result = await runtime.importSillyTavernDirectory(path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
  ;
}
