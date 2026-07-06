import { Hono } from "hono";
import type { ImportExportRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
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
    // Streaming variant: emits one SSE message per ImportStreamEvent
    // (phase / progress / done / error) so the browser can render a live
    // progress bar. The blocking route above stays for any non-streaming
    // caller; the web UI switches to this one when a scanResult is present
    // (so the denominator per phase is known client-side).
    .post("/api/import/st-directory/stream", zValidator("json", schemas.stDirectoryPathSchema), async (c) => {
      const { path } = c.req.valid("json");
      const events = runtime.importSillyTavernDirectoryStream(path);
      return streamSSE(c, async (stream) => {
        try {
          for await (const event of events) {
            if (stream.aborted) break;
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          }
        } catch {
          // Client disconnected or write failed mid-stream. v1 has no
          // cooperative cancellation — the scanner finishes detached and
          // the DB writes complete regardless. Nothing to emit on a dead
          // connection.
        }
      });
    })
  ;
}
