/**
 * fork #1 of api/routes/service-prompts.ts.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ImagePromptProfileRuntimeApi } from "../contract/runtime-api.js";
import { ImageGenValidationError } from "../adapters/image-gen-adapter.js";

/**
 * Image prompt profile routes (IF-1b — a fork of the service-prompt profile
 * routes; IMAGEGEN_FOLLOWUP_REPORT). REST surface:
 *
 *   GET    /api/image-gen/prompt-profiles            (list + active pointer)
 *   GET    /api/image-gen/prompt-profiles/:id        (detail + profile-scoped catalog)
 *   POST   /api/image-gen/prompt-profiles            (create)
 *   PATCH  /api/image-gen/prompt-profiles/:id        (rename / full overrides save)
 *   DELETE /api/image-gen/prompt-profiles/:id        (delete; refuses Default)
 *   PUT    /api/image-gen/prompt-profiles/active     (set the live profile)
 *   PATCH  /api/image-gen/prompt-profiles/reorder    (drag order)
 *
 * Whole-profile saves run the adapter's quality-layer authorship guard;
 * Free cells are ordinary per-family overrides. An ImageGenValidationError
 * maps a rejected cell to 400 naming its key.
 */
export function createImagePromptProfileRoutes(runtime: ImagePromptProfileRuntimeApi) {
  return new Hono()
    .patch("/api/image-gen/prompt-profiles/reorder", zValidator("json", schemas.reorderImagePromptProfilesSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.reorderImagePromptProfiles(body.updates));
    })
    .get("/api/image-gen/prompt-profiles", async (c) => {
      return c.json(await runtime.listImagePromptProfiles());
    })
    .get("/api/image-gen/prompt-profiles/:id", async (c) => {
      const detail = await runtime.getImagePromptProfile(c.req.param("id"));
      if (!detail) return c.json({ error: "Image prompt profile not found" }, 404);
      return c.json(detail);
    })
    .post("/api/image-gen/prompt-profiles", zValidator("json", schemas.createImagePromptProfileRequestSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(await runtime.createImagePromptProfile(body), 201);
      } catch (error) {
        if (error instanceof ImageGenValidationError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    })
    .patch(
      "/api/image-gen/prompt-profiles/:id",
      zValidator("json", schemas.updateImagePromptProfileRequestSchema),
      async (c) => {
        const id = c.req.param("id");
        const body = c.req.valid("json");
        try {
          const result = await runtime.updateImagePromptProfile(id, body);
          if (result.status === "not-found") return c.json({ error: "Image prompt profile not found" }, 404);
          if (result.status === "forbidden") return c.json({ error: "The Default image prompt profile is read-only" }, 403);
          return c.json(result.profile);
        } catch (error) {
          if (error instanceof ImageGenValidationError) {
            return c.json({ error: error.message }, 400);
          }
          throw error;
        }
      },
    )
    .delete("/api/image-gen/prompt-profiles/:id", async (c) => {
      const result = await runtime.deleteImagePromptProfile(c.req.param("id"));
      if (result.status === "not-found") return c.json({ error: "Image prompt profile not found" }, 404);
      if (result.status === "forbidden") return c.json({ error: "The Default image prompt profile cannot be deleted" }, 403);
      return c.json({ ok: true });
    })
    .put("/api/image-gen/prompt-profiles/active", zValidator("json", schemas.setActiveImagePromptProfileRequestSchema), async (c) => {
      const body = c.req.valid("json");
      const result = await runtime.setActiveImagePromptProfile(body.profileId);
      if (result.status === "not-found") return c.json({ error: "Image prompt profile not found" }, 404);
      return c.json({ ok: true });
    });
}
