import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ServicePromptRuntimeApi } from "../contract/runtime-api.js";

export function createServicePromptRoutes(runtime: ServicePromptRuntimeApi) {
  return new Hono()
    .patch("/api/service-prompts/reorder", zValidator("json", schemas.reorderServicePromptProfilesSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.reorderServicePromptProfiles(body.updates));
    })
    .get("/api/service-prompts/profiles", async (c) => {
      return c.json(await runtime.listServicePromptProfiles());
    })
    .get("/api/service-prompts/profiles/:id", async (c) => {
      const detail = await runtime.getServicePromptProfile(c.req.param("id"));
      if (!detail) return c.json({ error: "Service prompt profile not found" }, 404);
      return c.json(detail);
    })
    .post("/api/service-prompts/profiles", zValidator("json", schemas.createServicePromptProfileRequestSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createServicePromptProfile(body), 201);
    })
    .patch(
      "/api/service-prompts/profiles/:id",
      zValidator("json", schemas.updateServicePromptProfileRequestSchema),
      async (c) => {
        const id = c.req.param("id");
        const body = c.req.valid("json");
        const result = await runtime.updateServicePromptProfile(id, body);
        if (result.status === "not-found") return c.json({ error: "Service prompt profile not found" }, 404);
        if (result.status === "forbidden") return c.json({ error: "The Default service prompt profile is read-only" }, 403);
        return c.json(result.profile);
      },
    )
    .delete("/api/service-prompts/profiles/:id", async (c) => {
      const result = await runtime.deleteServicePromptProfile(c.req.param("id"));
      if (result.status === "not-found") return c.json({ error: "Service prompt profile not found" }, 404);
      if (result.status === "forbidden") return c.json({ error: "The Default service prompt profile cannot be deleted" }, 403);
      return c.json({ ok: true });
    })
    .put("/api/service-prompts/active", zValidator("json", schemas.setActiveServicePromptProfileRequestSchema), async (c) => {
      const body = c.req.valid("json");
      const result = await runtime.setActiveServicePromptProfile(body.profileId);
      if (result.status === "not-found") return c.json({ error: "Service prompt profile not found" }, 404);
      return c.json({ ok: true });
    });
}
