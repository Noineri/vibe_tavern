import { Hono } from "hono";
import type { CoauthorSkillsRuntimeApi } from "../contract/runtime-api.js";
import type { SkillImportFile } from "../../domain/coauthor/skills/skill-library.js";
import { SkillImportError } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Co-Author skill library routes (CTX-S2 + CTX-S3).
 *
 *  - `GET  /api/coauthor/skills`        — metadata-only catalog: built-in + user
 *    skills merged with user precedence. No file bodies; no absolute paths.
 *  - `GET  /api/coauthor/skills/:id`     — one catalog entry by id (404 if absent).
 *  - `POST /api/coauthor/skills/import`  — multipart upload where each file
 *    part's FIELD NAME is its relative path (e.g. `my-skill/SKILL.md`,
 *    `my-skill/assets/template.md`). This is the natural shape a browser
 *    produces from a `webkitdirectory` input (`formData.append(file.webkitRelativePath, file)`),
 *    requires no companion path array, and is order-independent. The service
 *    validates the whole tree before writing anything.
 *  - `DELETE /api/coauthor/skills/:id`   — remove one user skill directory. A
 *    user shadow of a built-in is deletable; a pure built-in is rejected.
 */
export function createCoauthorSkillRoutes(runtime: CoauthorSkillsRuntimeApi) {
  return new Hono()
    .get("/api/coauthor/skills", async (c) => {
      const catalog = await runtime.listSkills();
      return c.json(catalog);
    })
    .get("/api/coauthor/skills/:id", async (c) => {
      const id = c.req.param("id");
      const entry = await runtime.readSkill(id);
      if (!entry) return c.json({ error: `skill '${id}' does not exist` }, 404);
      return c.json(entry);
    })
    .post("/api/coauthor/skills/import", async (c) => {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.parseBody()) as Record<string, unknown>;
      } catch {
        return c.json({ error: "Invalid multipart body." }, 400);
      }

      const files: SkillImportFile[] = [];
      for (const [relativePath, value] of Object.entries(body)) {
        // Each File part's field name IS its relative path. Non-File fields are ignored.
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
        const result = await runtime.importSkills(files);
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof SkillImportError) {
          return c.json({ error: err.message }, 400);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    })
    .delete("/api/coauthor/skills/:id", async (c) => {
      const id = c.req.param("id");
      try {
        const result = await runtime.deleteSkill(id);
        return c.json(result);
      } catch (err) {
        if (err instanceof SkillImportError) {
          // Built-in immutability / unsafe id / not-found are all client errors.
          return c.json({ error: err.message }, 400);
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    })
  ;
}
