import { Hono } from "hono";
import type { PersonaRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createPersonaRoutes(runtime: PersonaRuntimeApi) {
  return new Hono()
    .get("/api/personas", async (c) => {
      return c.json(await runtime.listPersonas());
    })
    // Bulk export MUST be registered before any /:personaId route so the static
    // path is not swallowed by the param. Returns one JSON (ST backup or VT array).
    .get("/api/personas/export", async (c) => {
      const format = (c.req.query("format") === "vt" ? "vt" : "st") as "st" | "vt";
      const { body, filename, contentType } = await runtime.exportAllPersonas(format);
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      c.header("Content-Type", contentType);
      return c.json(body);
    })
    // Import/restore (POST, no param clash but kept with the export group).
    .post("/api/personas/import", async (c) => {
      const body = await c.req.json();
      return c.json(await runtime.importPersonas(body), 201);
    })
    .post("/api/personas", zValidator("json", schemas.createPersonaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createPersona(body), 201);
    })
    .patch("/api/personas/:personaId", zValidator("json", schemas.updatePersonaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updatePersona(c.req.param("personaId"), body),
      );
    })
    .delete("/api/personas/:personaId", async (c) => {
      runtime.deletePersona(c.req.param("personaId"));
      return c.body(null, 204);
    })
    .post("/api/personas/:personaId/duplicate", async (c) => {
      return c.json(await runtime.duplicatePersona(c.req.param("personaId")), 201);
    })
    .post("/api/personas/:personaId/set-default", async (c) => {
      await runtime.setDefaultPersona(c.req.param("personaId"));
      return c.body(null, 204);
    })
    .post("/api/personas/:personaId/avatar", async (c) => {
      const body = await c.req.parseBody();
      const crop = body["crop"] instanceof File ? body["crop"] : (body["file"] instanceof File ? body["file"] : null);
      const full = body["full"] instanceof File ? body["full"] : null;
      if (!crop) {
        return c.json({ error: "No file provided. Use 'crop' (and optional 'full') in multipart form." }, 400);
      }
      try {
        const result = await runtime.uploadPersonaAvatar(c.req.param("personaId"), crop, full ?? undefined);
        return c.json(result, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("too large")) return c.json({ error: message }, 413);
        if (message.includes("Unsupported")) return c.json({ error: message }, 415);
        return c.json({ error: message }, 400);
      }
    })
    .get("/api/personas/:personaId/avatar", async (c) => {
      const result = await runtime.servePersonaAvatar(c.req.param("personaId"));
      if (!result) return c.json({ error: "Avatar not found" }, 404);
      return result;
    })
    .get("/api/personas/:personaId/avatar/full", async (c) => {
      const result = await runtime.servePersonaAvatarFull(c.req.param("personaId"));
      if (!result) return c.json({ error: "Avatar not found" }, 404);
      return result;
    })
    .post("/api/personas/:personaId/avatar/describe", async (c) => {
      return c.json(await runtime.describePersonaAvatar(c.req.param("personaId")));
    })
    // Bound resources (PR-12) — reverse-direction reads backing the
    // persona-editor binding field. Lorebooks = M:N links; scripts = FK-owned.
    .get("/api/personas/:personaId/lorebooks", async (c) => {
      return c.json(await runtime.listPersonaLorebooks(c.req.param("personaId")));
    })
    .get("/api/personas/:personaId/scripts", async (c) => {
      return c.json(await runtime.listPersonaScripts(c.req.param("personaId")));
    })
    // Single export (after the avatar/describe param routes — no clash with bulk
    // since bulk is registered first above).
    .get("/api/personas/:personaId/export", async (c) => {
      const format = (c.req.query("format") === "vt" ? "vt" : "st") as "st" | "vt";
      const { body, filename, contentType } = await runtime.exportPersona(c.req.param("personaId"), format);
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      c.header("Content-Type", contentType);
      return c.json(body);
    })
  ;
}
