import { Hono } from "hono";
import type { LorebookRuntimeApi } from "../api/contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createLorebookRoutes(runtime: LorebookRuntimeApi) {
  return new Hono()
    .get("/api/lorebooks/all", async (c) => {
      return c.json(await runtime.listAllLorebooks());
    })
    .get("/api/lorebooks", async (c) => {
      const scopeType = c.req.query("scopeType") ?? "character";
      const ownerId = c.req.query("ownerId") ?? undefined;
      return c.json(await runtime.listLorebooks(scopeType, ownerId));
    })
    .post("/api/lorebooks", zValidator("json", schemas.createLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createLorebook(body), 201);
    })
    .patch("/api/lorebooks/:lorebookId", zValidator("json", schemas.updateLorebookMetaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateLorebookMeta(c.req.param("lorebookId"), body),
      );
    })
    .delete("/api/lorebooks/:lorebookId", async (c) => {
      await runtime.deleteLorebook(c.req.param("lorebookId"));
      return c.json({ ok: true });
    })
    .post("/api/lorebooks/:lorebookId/test-activation", zValidator("json", schemas.testActivationSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.testLoreActivation(c.req.param("lorebookId"), body),
      );
    })
    .get("/api/lorebooks/:lorebookId/entries", async (c) => {
      return c.json(await runtime.listLoreEntries(c.req.param("lorebookId")));
    })
    .post("/api/lorebooks/:lorebookId/entries", zValidator("json", schemas.createLoreEntrySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createLoreEntry(c.req.param("lorebookId"), body));
    })
    .patch("/api/lorebooks/:lorebookId/entries/reorder", zValidator("json", schemas.reorderLoreEntriesSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.reorderLoreEntries(c.req.param("lorebookId"), body.updates));
    })
    .patch("/api/lorebooks/:lorebookId/entries/:entryId", zValidator("json", schemas.updateLoreEntrySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"), body));
    })
    .delete("/api/lorebooks/:lorebookId/entries/:entryId", async (c) => {
      await runtime.deleteLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"));
      return c.json({ ok: true });
    })
    .post("/api/lorebooks/:lorebookId/import", zValidator("json", schemas.importLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      const lorebookIdParam = c.req.param("lorebookId");
      const lorebookId = lorebookIdParam === "new" ? null : lorebookIdParam;
      return c.json(await runtime.importLorebook(lorebookId, { format: body.format, data: body.data, mode: body.mode, scopeType: body.scopeType, characterId: body.characterId, personaId: body.personaId, chatId: body.chatId, fallbackName: body.fallbackName }), 201);
    })
    // ── Links ───────────────────────────────────────────────────────────
    .get("/api/lorebooks/:lorebookId/links", async (c) => {
      return c.json(await runtime.getLorebookLinks(c.req.param("lorebookId")));
    })
    .put("/api/lorebooks/:lorebookId/links", zValidator("json", schemas.setLorebookLinksSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setLorebookLinks(c.req.param("lorebookId"), body.links));
    })
    // ── Duplicate & export ──────────────────────────────────────────────
    .post("/api/lorebooks/:lorebookId/duplicate", zValidator("json", schemas.duplicateLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.duplicateLorebook(c.req.param("lorebookId"), body), 201);
    })
    .get("/api/lorebooks/:lorebookId/export", async (c) => {
      const data = await runtime.exportLorebook(c.req.param("lorebookId"));
      const name = (data as Record<string, unknown>).name ?? "lorebook";
      return c.json(data, 200, {
        "Content-Disposition": `attachment; filename="${String(name).replace(/[^a-zA-Z0-9_-]/g, '_')}.json"`,
      });
    })
  ;
}
