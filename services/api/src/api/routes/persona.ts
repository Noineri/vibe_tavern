import { Hono } from "hono";
import type { PersonaRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createPersonaRoutes(runtime: PersonaRuntimeApi) {
  return new Hono()
    .get("/api/personas", async (c) => {
      return c.json(await runtime.listPersonas());
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
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      try {
        const result = await runtime.uploadPersonaAvatar(c.req.param("personaId"), file);
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
  ;
}
