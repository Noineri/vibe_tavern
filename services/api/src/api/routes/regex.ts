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

    // ── Profiles (R-13) ──────────────────────────────────────────────────
    .get("/api/regex/profiles/all", async (c) => {
      return c.json(await runtime.listAllRegexProfiles());
    })
    .get("/api/regex/profiles/:id", async (c) => {
      const profile = await runtime.getRegexProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "Regex profile not found" }, 404);
      return c.json(profile);
    })
    .post("/api/regex/profiles", zValidator("json", schemas.createRegexProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createRegexProfile(body), 201);
    })
    .patch("/api/regex/profiles/:id", zValidator("json", schemas.updateRegexProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateRegexProfile(c.req.param("id"), body));
    })
    .delete("/api/regex/profiles/:id", zValidator("query", schemas.deleteRegexProfileQuerySchema), async (c) => {
      const mode = c.req.valid("query").mode;
      await runtime.deleteRegexProfile(c.req.param("id"), mode);
      return c.json({ ok: true });
    })
    .post("/api/regex/profiles/:id/attach", zValidator("json", schemas.attachRegexRuleSchema), async (c) => {
      const body = c.req.valid("json");
      const preset = await runtime.attachRegexRule(c.req.param("id"), body.ruleId);
      if (!preset) return c.json({ error: "Regex preset not found" }, 404);
      return c.json(preset);
    })
    .post("/api/regex/presets/:id/detach", async (c) => {
      const preset = await runtime.detachRegexRule(c.req.param("id"));
      if (!preset) return c.json({ error: "Regex preset not found" }, 404);
      return c.json(preset);
    })
    .get("/api/regex/profiles/:id/members", async (c) => {
      return c.json(await runtime.listRegexProfileMemberIds(c.req.param("id")));
    })
    // Profile links (R-13, fourth junction instance).
    .get("/api/regex/profiles/:id/links", async (c) => {
      return c.json(await runtime.getRegexProfileLinks(c.req.param("id")));
    })
    .put("/api/regex/profiles/:id/links", zValidator("json", schemas.setRegexProfileLinksSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setRegexProfileLinks(c.req.param("id"), body.links));
    })
  ;
}
