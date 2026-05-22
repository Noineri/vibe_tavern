import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";

export function createAssetRoutes(runtime: RuntimeApi) {
  return new Hono()
    .post("/api/assets/upload", async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      const result = await runtime.uploadAsset(file);
      return c.json(result, 201);
    })
    .get("/api/assets/:assetId", async (c) => {
      const assetId = c.req.param("assetId");
      const result = await runtime.serveAsset(assetId);
      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }
      return c.body(new ReadableStream({ start(controller) { controller.enqueue(result.body); controller.close(); } }), 200, { "Content-Type": result.contentType, "Cache-Control": "public, max-age=31536000" });
    })
  ;
}
