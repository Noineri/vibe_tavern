import { Hono } from "hono";
import type { CharacterRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createCharacterRoutes(runtime: CharacterRuntimeApi) {
  return new Hono()
    .post("/api/characters", zValidator("json", schemas.createCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      const name = body.name;
      if (!name || !name.trim()) {
        return c.json({ error: "name is required" }, 400);
      }
      return c.json(await runtime.createCharacterFromScratch({
        name: name.trim(),
        description: body.description ?? undefined,
        firstMessage: body.firstMessage ?? undefined,
        scenario: body.scenario ?? undefined,
        personalitySummary: body.personalitySummary ?? undefined,
        mesExample: body.mesExample ?? undefined,
        mesExampleMode: body.mesExampleMode ?? undefined,
        mesExampleDepth: body.mesExampleDepth ?? undefined,
        alternateGreetings: body.alternateGreetings ?? undefined,
        postHistoryInstructions: body.postHistoryInstructions ?? undefined,
        creatorNotes: body.creatorNotes ?? undefined,
        systemPrompt: body.systemPrompt ?? undefined,
        depthPrompt: body.depthPrompt ?? undefined,
        depthPromptDepth: body.depthPromptDepth ?? undefined,
        depthPromptRole: body.depthPromptRole ?? undefined,
        tags: body.tags ?? undefined,
      }), 201);
    })
    .get("/api/characters/:characterId/export", async (c) => {
      return c.json(await runtime.exportCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId/archive", async (c) => {
      return c.json(await runtime.archiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId/unarchive", async (c) => {
      return c.json(await runtime.unarchiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId", zValidator("json", schemas.updateCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateCharacter(c.req.param("characterId"), body),
      );
    })
    .delete("/api/characters/:characterId", async (c) => {
      runtime.deleteCharacter(c.req.param("characterId"));
      return c.body(null, 204);
    })
    .post("/api/characters/:characterId/duplicate", async (c) => {
      return c.json(await runtime.duplicateCharacter(c.req.param("characterId")), 201);
    })
    .post("/api/characters/:characterId/avatar", async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      try {
        const result = await runtime.uploadCharacterAvatar(c.req.param("characterId"), file);
        return c.json(result, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("too large")) return c.json({ error: message }, 413);
        if (message.includes("Unsupported")) return c.json({ error: message }, 415);
        return c.json({ error: message }, 400);
      }
    })
    .get("/api/characters/:characterId/avatar", async (c) => {
      const result = await runtime.serveCharacterAvatar(c.req.param("characterId"));
      if (!result) return c.json({ error: "Avatar not found" }, 404);
      return result;
    })
  ;
}
