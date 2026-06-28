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
    // ─── Character versions (VTF Phase 3 folder-snapshot branching) ──────
    .get("/api/characters/:characterId/versions", async (c) => {
      return c.json(await runtime.listCharacterVersions(c.req.param("characterId")));
    })
    // Bound resources — reverse read backing the character-editor lorebook
    // binding field. Lorebooks = M:N links (mirrors /api/personas/:id/lorebooks).
    .get("/api/characters/:characterId/lorebooks", async (c) => {
      return c.json(await runtime.listCharacterLorebooks(c.req.param("characterId")));
    })
    .post("/api/characters/:characterId/versions", zValidator("json", schemas.createVersionSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createCharacterVersion(c.req.param("characterId"), body.title), 201);
    })
    .post("/api/characters/:characterId/versions/:versionId/activate", async (c) => {
      try {
        return c.json(await runtime.activateCharacterVersion(c.req.param("characterId"), c.req.param("versionId")));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("not found") ? 404 : message.includes("does not belong") ? 400 : 500;
        return c.json({ error: message }, status);
      }
    })
    .patch("/api/characters/:characterId/versions/:versionId", zValidator("json", schemas.renameVersionSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(await runtime.renameCharacterVersion(c.req.param("characterId"), c.req.param("versionId"), body.title));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, message.includes("not found") ? 404 : 400);
      }
    })
    .delete("/api/characters/:characterId/versions/:versionId", async (c) => {
      try {
        await runtime.deleteCharacterVersion(c.req.param("characterId"), c.req.param("versionId"));
        return c.body(null, 204);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, message.includes("active") ? 409 : 400);
      }
    })
    .post("/api/characters/:characterId/avatar", async (c) => {
      const body = await c.req.parseBody();
      // `crop` (required) is the thumbnail avatar.{ext}; `full` (optional) is
      // the uncropped original avatar-full.{ext}. Back-compat: a `file` field
      // is accepted as the crop for single-image uploads (ST import / clients
      // that don't distinguish crop vs full).
      const crop = body["crop"] instanceof File ? body["crop"] : (body["file"] instanceof File ? body["file"] : null);
      const full = body["full"] instanceof File ? body["full"] : null;
      if (!crop) {
        return c.json({ error: "No file provided. Use 'crop' (and optional 'full') in multipart form." }, 400);
      }
      try {
        const result = await runtime.uploadCharacterAvatar(c.req.param("characterId"), crop, full ?? undefined);
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
    .get("/api/characters/:characterId/avatar/full", async (c) => {
      // Uncropped original for large display slots (top-bar preview, editor).
      // Falls back to the thumbnail avatar when no separate full is stored.
      const result = await runtime.serveCharacterAvatarFull(c.req.param("characterId"));
      if (!result) return c.json({ error: "Avatar not found" }, 404);
      return result;
    })
    .post("/api/characters/:characterId/avatar/describe", async (c) => {
      try {
        return c.json(await runtime.describeCharacterAvatar(c.req.param("characterId"), c.req.raw.signal));
      } catch (err) {
        // Client cancelled via AbortController — return an empty result instead
        // of surfacing the AbortError as a 500. The frontend tracks cancellation
        // by its own signal, so the response body is just a no-op.
        if (err instanceof Error && (err.name === "AbortError" || c.req.raw.signal?.aborted)) {
          return c.json({ description: "" });
        }
        throw err;
      }
    })
    // D8: set a gallery image as the character's avatar. Salvages the current
    // avatar into the gallery (full + crop metadata) before overwriting, so the
    // prior avatar is preserved and restorable. Multipart: `sourceAssetId`
    // (field) + `crop` (File, the cropped thumbnail) + `cropJson` (field, the
    // crop geometry percentages JSON).
    .post("/api/characters/:characterId/avatar/from-gallery", async (c) => {
      const body = await c.req.parseBody();
      const sourceAssetId = typeof body["sourceAssetId"] === "string" ? body["sourceAssetId"] : null;
      const crop = body["crop"] instanceof File ? body["crop"] : null;
      const cropJson = typeof body["cropJson"] === "string" ? body["cropJson"] : "";
      if (!sourceAssetId || !crop) {
        return c.json({ error: "Required: 'sourceAssetId' field + 'crop' File in multipart form." }, 400);
      }
      try {
        const result = await runtime.setAvatarFromGallery(c.req.param("characterId"), sourceAssetId, crop, cropJson);
        return c.json(result, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("too large")) return c.json({ error: message }, 413);
        if (message.includes("Unsupported")) return c.json({ error: message }, 415);
        return c.json({ error: message }, 400);
      }
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
    .post("/api/characters/:characterId/assets/describe", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { assetRowIds?: unknown };
      const assetRowIds = Array.isArray(body.assetRowIds) && body.assetRowIds.every((v) => typeof v === "string")
        ? (body.assetRowIds as string[])
        : undefined;
        try {
        return c.json(await runtime.describeCharacterAssets(c.req.param("characterId"), assetRowIds, c.req.raw.signal));
      } catch (err) {
        // Client cancelled mid-batch — whatever was already persisted stays.
        // Return an empty result (200) rather than surfacing AbortError as 500.
        if (err instanceof Error && (err.name === "AbortError" || c.req.raw.signal?.aborted)) {
          return c.json({ updated: [], failed: [] });
        }
        throw err;
      }
    })
    .patch("/api/characters/:characterId/assets/:assetRowId", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const patch: { caption?: string; description?: string | null; includeInPrompt?: boolean } = {};
      if (typeof body.caption === "string") patch.caption = body.caption;
      if (body.description === null || typeof body.description === "string") patch.description = body.description;
      if (typeof body.includeInPrompt === "boolean") patch.includeInPrompt = body.includeInPrompt;
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
    // D1/R5: promote a gallery image into the general asset store (server-side
    // copy) so it can be attached to a chat draft without a client re-upload.
    // Placed AFTER the generic `:assetRowId` routes so it matches before them.
    .post("/api/characters/:characterId/assets/:assetRowId/promote-to-attachment", async (c) => {
      try {
        const result = await runtime.promoteGalleryAssetToAttachment(c.req.param("characterId"), c.req.param("assetRowId"));
        return c.json(result, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("not found") ? 404 : message.includes("too large") ? 413 : message.includes("Unsupported") ? 415 : 400;
        return c.json({ error: message }, status);
      }
    })
  ;
}
