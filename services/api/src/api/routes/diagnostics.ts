import { Hono } from "hono";
import type { DiagnosticsRuntimeApi } from "../contract/diagnostics-api.js";

export function createDiagnosticsRoutes(runtime: DiagnosticsRuntimeApi) {
  return new Hono()
    // The item list shown BEFORE the user downloads anything.
    .get("/api/diagnostics", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await runtime.diagnosticsManifest());
    })
    // The zip itself. POST (side effect: a download the user confirmed), no-store.
    // The wrapping constructor pins Uint8Array<ArrayBuffer> for Hono's BodyInit
    // (same idiom as the TTS audio route).
    .post("/api/diagnostics", async (c) => {
      const zip = await runtime.diagnosticsZip();
      c.header("Cache-Control", "no-store");
      return c.body(new Uint8Array(zip), 200, { "Content-Type": "application/zip" });
    });
}
