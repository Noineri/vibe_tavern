import { Hono } from "hono";
import type { RegexRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

export function createRegexRoutes(runtime: RegexRuntimeApi) {
  return new Hono()
    .get("/api/regex/presets/all", async (c) => {
      return c.json(await runtime.listAllRegexPresets());
    })
    .get("/api/regex/presets/:id", async (c) => {
      const preset = await runtime.getRegexPreset(c.req.param("id"));
      if (!preset) return c.json({ error: "Regex preset not found" }, 404);
      return c.json(preset);
    })
    .post("/api/regex/presets", zValidator("json", schemas.createRegexPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createRegexPreset(body), 201);
    })
    .patch("/api/regex/presets/:id", zValidator("json", schemas.updateRegexPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateRegexPreset(c.req.param("id"), body));
    })
    .delete("/api/regex/presets/:id", async (c) => {
      await runtime.deleteRegexPreset(c.req.param("id"));
      return c.json({ ok: true });
    })
    // ── Links ───────────────────────────────────────────────────────────
    .get("/api/regex/presets/:id/links", async (c) => {
      return c.json(await runtime.getRegexLinks(c.req.param("id")));
    })
    .put("/api/regex/presets/:id/links", zValidator("json", schemas.setRegexLinksSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setRegexLinks(c.req.param("id"), body.links));
    })

    // ── Resolution (pipeline entry point) ───────────────────────────────
    .get("/api/regex/resolve-active", zValidator("query", schemas.resolveActiveRegexQuerySchema), async (c) => {
      const query = c.req.valid("query");
      return c.json(await runtime.resolveActiveRegex(query));
    })
  ;
}
