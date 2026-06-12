import { Hono } from "hono";
import type { AssetRuntimeApi } from "./types.js";

export function createAssetRoutes(runtime: AssetRuntimeApi) {
  return new Hono()
    .post("/api/assets/upload", async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      try {
        const result = await runtime.uploadAsset(file);
        return c.json(result, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("too large")) {
          return c.json({ error: message }, 413);
        }
        if (message.includes("Unsupported")) {
          return c.json({ error: message }, 415);
        }
        return c.json({ error: message }, 400);
      }
    })
    .get("/api/assets/:assetId", async (c) => {
      const assetId = c.req.param("assetId");
      const result = await runtime.serveAsset(assetId);
      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }
      return result;
    })
  ;
}
