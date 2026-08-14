import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { CopilotProfileRuntimeApi } from "../contract/runtime-api.js";

/**
 * Copilot profile CRUD routes (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3).
 *
 * Mirrors the co-author module routes (`/api/coauthor/modules`) but for copilot
 * profiles:
 *
 *  - `GET    /api/copilot/profiles`              — built-in seed first, then user
 *    profiles in store order (the seed is resolved, not stored).
 *  - `POST   /api/copilot/profiles`              — create a user profile.
 *  - `PATCH  /api/copilot/profiles/:profileId`   — partial update; the built-in
 *    seed (id "builtin") is rejected as read-only (400).
 *  - `DELETE /api/copilot/profiles/:profileId`   — delete a user profile; the
 *    built-in seed is rejected as read-only (400). A dangling id on a script
 *    resolves to the seed at the resolver (soft link, no FK rewire needed).
 */
export function createCopilotProfileRoutes(runtime: CopilotProfileRuntimeApi) {
	return new Hono()
		.get("/api/copilot/profiles", async (c) => {
			return c.json({ profiles: await runtime.listCopilotProfiles() });
		})
		.post("/api/copilot/profiles", zValidator("json", schemas.copilotProfileCreateSchema), async (c) => {
			return c.json(await runtime.createCopilotProfile(c.req.valid("json")));
		})
		.patch(
			"/api/copilot/profiles/:profileId",
			zValidator("json", schemas.copilotProfileUpdateSchema),
			async (c) => {
				return c.json(await runtime.updateCopilotProfile(c.req.param("profileId"), c.req.valid("json")));
			},
		)
		.delete("/api/copilot/profiles/:profileId", async (c) => {
			await runtime.deleteCopilotProfile(c.req.param("profileId"));
			return c.json({ ok: true });
		});
}
