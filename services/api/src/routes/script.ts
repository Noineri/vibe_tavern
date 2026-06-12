import { Hono } from "hono";
import type { ScriptRuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createScriptRoutes(runtime: ScriptRuntimeApi) {
  return new Hono()
    .get("/api/scripts", async (c) => {
      const scopeType = c.req.query("scopeType") ?? "character";
      const ownerId = c.req.query("ownerId") ?? undefined;
      return c.json(await runtime.listScripts(scopeType, ownerId));
    })
    .get("/api/scripts/:scriptId", async (c) => {
      const script = await runtime.getScript(c.req.param("scriptId"));
      if (!script) return c.json({ error: "Script not found" }, 404);
      return c.json(script);
    })
    .post("/api/scripts", zValidator("json", schemas.createScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createScript(body), 201);
    })
    .patch("/api/scripts/:scriptId", zValidator("json", schemas.updateScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateScript(c.req.param("scriptId"), body));
    })
    .delete("/api/scripts/:scriptId", async (c) => {
      await runtime.deleteScript(c.req.param("scriptId"));
      return c.json({ ok: true });
    })
    .post("/api/scripts/:scriptId/test", zValidator("json", schemas.testScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.testScript(c.req.param("scriptId"), body));
    })
    .post("/api/scripts/import", zValidator("json", schemas.importScriptSchema), async (c) => {
      const body = c.req.valid("json");
      const format = body.format;
      const payload = format === "js"
        ? { format, code: body.code, name: body.name, scopeType: body.scopeType, characterId: body.characterId, personaId: body.personaId, chatId: body.chatId }
        : { format, jsonText: body.jsonText, scopeType: body.scopeType, characterId: body.characterId, personaId: body.personaId, chatId: body.chatId };
      return c.json(await runtime.importScript(payload), 201);
    })
  ;
}
