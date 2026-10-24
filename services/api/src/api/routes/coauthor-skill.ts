import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { CoauthorSkillsRuntimeApi } from "../contract/runtime-api.js";
import type { SkillImportFile } from "../../domain/coauthor/skills/skill-library.js";
import { SkillImportError } from "../../domain/coauthor/skills/skill-library.js";

/**
 * Co-Author skill library routes (CTX-S2 + CTX-S3).
 *
 *  - `GET  /api/coauthor/skills`        — metadata-only catalog: built-in + user
 *    skills merged with user precedence. No file bodies; no absolute paths.
 *  - `GET  /api/coauthor/skills/:id`     — one catalog entry by id (404 if absent).
 *  - `GET  /api/coauthor/skills/:id/content` — full content view (AP-21): the
 *    raw manifest via the sandboxed `readSkillFile` (user shadow first), the
 *    frontmatter-stripped `body`, and the folder's relative file `files`
 *    (manifest excluded). Same shape on the copilot skill routes — the ONE
 *    domain derivation (`SkillLibraryService.readSkillContent`) serves both.
 *  - `POST /api/coauthor/skills` — save a NEW user skill (AP-23a): body
 *    `{ name, description, body }`; the folder id is derived from the name
 *    (transliterated, lowercased, hyphenated, de-duplicated). 201 + the fresh
 *    catalog entry DTO.
 *  - `PUT  /api/coauthor/skills/:id` — save an EXISTING user skill (AP-23a):
 *    same body; rewrites only that skill's SKILL.md (frontmatter rebuilt,
 *    every key kept). A built-in id is a 409 (built-ins are read-only); a
 *    missing id is a 404; an invalid manifest is a 400 that writes nothing.
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
    .get("/api/coauthor/skills/:id/content", async (c) => {
      const id = c.req.param("id");
      // `null` covers both a missing skill and an unreadable manifest — the
      // metadata route's 404 convention (no route-level fs access; the whole
      // read lives in the sandboxed domain derivation).
      const content = await runtime.readSkillContent(id);
      if (!content) return c.json({ error: `skill '${id}' does not exist` }, 404);
      return c.json(content);
    })
    .post("/api/coauthor/skills", zValidator("json", schemas.skillSaveSchema), async (c) => {
      // Save (create): the id derivation, minimal manifest, parse-before-write,
      // and atomic write all live in the ONE domain operation. A DomainError
      // (invalid manifest → 400) propagates to the app error handler.
      const saved = await runtime.saveSkill(c.req.valid("json"));
      return c.json(saved, 201);
    })
    .put("/api/coauthor/skills/:id", zValidator("json", schemas.skillSaveSchema), async (c) => {
      // Save (update): built-in id → DomainError conflict (409), missing id →
      // notFound (404), both mapped by the app error handler. An unsafe id
      // throws the same SkillImportError delete uses (client error → 400).
      try {
        const saved = await runtime.saveSkill({ id: c.req.param("id"), ...c.req.valid("json") });
        return c.json(saved);
      } catch (err) {
        if (err instanceof SkillImportError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
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
