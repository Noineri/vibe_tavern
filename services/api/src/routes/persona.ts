import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createPersonaRoutes(runtime: RuntimeApi) {
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
    .get("/api/personas/:personaId/personal-lorebook", async (c) => {
      return c.json(await runtime.getPersonalLorebookStatus(c.req.param("personaId")));
    })
    .put("/api/personas/:personaId/personal-lorebook", zValidator("json", schemas.setPersonalLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      const enabled = body.enabled === true;
      return c.json(await runtime.setPersonalLorebookEnabled(c.req.param("personaId"), enabled));
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
