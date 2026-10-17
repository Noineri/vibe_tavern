import { Hono } from "hono";
import type { CopilotSkillsByKindRuntimeApi } from "../contract/runtime-api.js";
import type { SkillImportFile } from "../../domain/coauthor/skills/skill-library.js";
import { SkillImportError } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Copilot skill library routes (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-5;
 * per-kind roots AS-8d1).
 *
 * Mirrors `coauthor-skill` routes against the per-kind copilot user root:
 * `?kind=` selects the kind (default `'experience'`); an unknown kind is a
 * 400 carrying `UNKNOWN_AGENT_KIND`.
 *
 *  - `GET    /api/copilot/skills`       — metadata-only catalog: built-in + user
 *    skills merged with user precedence. No file bodies; no absolute paths.
 *  - `GET    /api/copilot/skills/:id`   — one catalog entry by id (404 if absent).
 *  - `POST   /api/copilot/skills/import` — multipart upload where each file
 *    part's FIELD NAME is its relative path (e.g. `my-skill/SKILL.md`).
 *  - `DELETE /api/copilot/skills/:id`   — remove one user skill directory. A
 *    user shadow of a built-in is deletable; a pure built-in is rejected.
 */
export function createCopilotSkillRoutes(runtime: CopilotSkillsByKindRuntimeApi) {
  return new Hono()
    .get("/api/copilot/skills", async (c) => {
      const skills = runtime.copilotSkillsForKind(c.req.query("kind") ?? "experience");
      const catalog = await skills.listSkills();
      return c.json(catalog);
    })
    .get("/api/copilot/skills/:id", async (c) => {
      const skills = runtime.copilotSkillsForKind(c.req.query("kind") ?? "experience");
      const id = c.req.param("id");
      const entry = await skills.readSkill(id);
      if (!entry) return c.json({ error: `skill '${id}' does not exist` }, 404);
      return c.json(entry);
    })
    .post("/api/copilot/skills/import", async (c) => {
      const skills = runtime.copilotSkillsForKind(c.req.query("kind") ?? "experience");
      let body: Record<string, unknown>;
      try {
        body = (await c.req.parseBody()) as Record<string, unknown>;
      } catch {
        return c.json({ error: "Invalid multipart body." }, 400);
      }

      const files: SkillImportFile[] = [];
      for (const [relativePath, value] of Object.entries(body)) {
        if (!(value instanceof File)) continue;
        if (typeof relativePath !== "string" || relativePath.length === 0) {
          return c.json({ error: "A file part is missing a relative-path field name." }, 400);
        }
        const bytes = new Uint8Array(await value.arrayBuffer());
        files.push({ relativePath, bytes });
      }

      if (files.length === 0) {
        return c.json({ error: "No files provided. Upload file parts named by their relative path (e.g. 'my-skill/SKILL.md')." }, 400);
      }

      try {
        const result = await skills.importSkills(files);
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof SkillImportError) {
          return c.json({ error: err.message }, 400);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    })
    .delete("/api/copilot/skills/:id", async (c) => {
      const skills = runtime.copilotSkillsForKind(c.req.query("kind") ?? "experience");
      const id = c.req.param("id");
      try {
        const result = await skills.deleteSkill(id);
        return c.json(result);
      } catch (err) {
        if (err instanceof SkillImportError) {
          return c.json({ error: err.message }, 400);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    })
  ;
}
