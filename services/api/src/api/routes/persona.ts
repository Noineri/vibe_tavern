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
  ;
}
