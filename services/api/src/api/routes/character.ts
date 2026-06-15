import { Hono } from "hono";
import type { CharacterRuntimeApi, CharacterAssetRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createCharacterRoutes(runtime: CharacterRuntimeApi & CharacterAssetRuntimeApi) {
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
    // ─── Character media gallery ────────────────────────────────────────
    .get("/api/characters/:characterId/assets", async (c) => {
      const list = await runtime.listCharacterAssets(c.req.param("characterId"));
      return c.json(list);
    })
    .get("/api/characters/:characterId/assets/:assetRowId", async (c) => {
      const result = await runtime.serveCharacterAsset(c.req.param("characterId"), c.req.param("assetRowId"));
      if (!result) return c.json({ error: "Gallery image not found" }, 404);
      return result;
    })
    .post("/api/characters/:characterId/assets", async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      try {
        const asset = await runtime.uploadCharacterAsset(c.req.param("characterId"), file);
        return c.json(asset, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("too large")) return c.json({ error: message }, 413);
        if (message.includes("Unsupported")) return c.json({ error: message }, 415);
        return c.json({ error: message }, 400);
      }
    })
    .patch("/api/characters/:characterId/assets/:assetRowId", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const patch: { caption?: string; description?: string | null } = {};
      if (typeof body.caption === "string") patch.caption = body.caption;
      if (body.description === null || typeof body.description === "string") patch.description = body.description;
      try {
        const asset = await runtime.updateCharacterAsset(c.req.param("characterId"), c.req.param("assetRowId"), patch);
        return c.json(asset, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("not found") ? 404 : 400;
        return c.json({ error: message }, status);
      }
    })
    .put("/api/characters/:characterId/assets/reorder", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { orderedIds?: unknown };
      if (!Array.isArray(body.orderedIds) || !body.orderedIds.every((v) => typeof v === "string")) {
        return c.json({ error: "orderedIds must be a string array" }, 400);
      }
      await runtime.reorderCharacterAssets(c.req.param("characterId"), body.orderedIds as string[]);
      return c.body(null, 204);
    })
    .delete("/api/characters/:characterId/assets/:assetRowId", async (c) => {
      try {
        await runtime.deleteCharacterAsset(c.req.param("characterId"), c.req.param("assetRowId"));
        return c.body(null, 204);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("not found") ? 404 : 400;
        return c.json({ error: message }, status);
      }
    })
  ;
}
