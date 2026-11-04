import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { diagnosticsPreviewRequestSchema, diagnosticsZipRequestSchema } from "@vibe-tavern/api-contracts";
import type { DiagnosticsRuntimeApi, DiagnosticsZipInput } from "../contract/diagnostics-api.js";
import { validation } from "../../shared/errors.js";

export function createDiagnosticsRoutes(runtime: DiagnosticsRuntimeApi) {
  return new Hono()
    // The item list shown BEFORE the user downloads anything.
    .get("/api/diagnostics", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await runtime.diagnosticsManifest());
    })
    // SM-9a: inspect ONE selected generation's redacted capture locally —
    // this informs the consent decision; the preview is never persisted or
    // transmitted anywhere by this endpoint.
    .post("/api/diagnostics/preview", zValidator("json", diagnosticsPreviewRequestSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await runtime.diagnosticsGenerationPreview(c.req.valid("json").selection));
    })
    // The zip itself. POST (side effect: a download the user confirmed), no-store.
    // No body / no `attach` = the SM-7 technical-only default; a body that IS
    // present must parse and validate — malformed input is a named rejection,
    // never silently treated as technical-only-with-a-mangled attachment.
    // The wrapping constructor pins Uint8Array<ArrayBuffer> for Hono's BodyInit
    // (same idiom as the TTS audio route).
    .post("/api/diagnostics", async (c) => {
      let input: DiagnosticsZipInput = {};
      const raw = await c.req.text().catch(() => "");
      if (raw.trim() !== "") {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw validation("Diagnostics zip request body must be JSON.");
        }
        const parsed = diagnosticsZipRequestSchema.safeParse(json);
        if (!parsed.success) throw validation("Invalid diagnostics zip request.", { issues: parsed.error.issues });
        input = parsed.data;
      }
      const zip = await runtime.diagnosticsZip(input);
      c.header("Cache-Control", "no-store");
      return c.body(new Uint8Array(zip), 200, { "Content-Type": "application/zip" });
    });
}
