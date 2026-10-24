import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as schemas from "@vibe-tavern/api-contracts";
import type { CopilotProfileRuntimeApi } from "../contract/runtime-api.js";

/**
 * Copilot profile CRUD routes (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3).
 *
 * Mirrors the co-author module routes (`/api/coauthor/modules`) but for copilot
 * profiles:
 *
 *  - `GET    /api/copilot/profiles`              — built-in seed first, then user
 *    profiles of the requested kind in store order (the seed is resolved, not
 *    stored). `?kind=` selects the kind (default `'experience'`); an unknown
 *    kind is a 400 carrying `UNKNOWN_AGENT_KIND`.
 *  - `POST   /api/copilot/profiles`              — create a user profile.
 *  - `PATCH  /api/copilot/profiles/reorder`      — rewrite ONE kind's user
 *    profiles' manual list order (ML-6); `?kind=` selects the kind (default
 *    `'experience'`, like the GET). Registered BEFORE the `:profileId` PATCH
 *    so the literal "reorder" segment is matched here, not swallowed as a
 *    profile id (Hono matches registration order).
 *  - `PATCH  /api/copilot/profiles/:profileId`   — partial update; the built-in
 *    seed (id "builtin") is rejected as read-only (400).
 *  - `DELETE /api/copilot/profiles/:profileId`   — delete a user profile; the
 *    built-in seed is rejected as read-only (400). A dangling id on a script
 *    resolves to the seed at the resolver (soft link, no FK rewire needed).
 */
export function createCopilotProfileRoutes(runtime: CopilotProfileRuntimeApi) {
	return new Hono()
		.get("/api/copilot/profiles", async (c) => {
			const kind = c.req.query("kind") ?? "experience";
			return c.json({ profiles: await runtime.listCopilotProfiles(kind) });
		})
		.post("/api/copilot/profiles", zValidator("json", schemas.copilotProfileCreateSchema), async (c) => {
			return c.json(await runtime.createCopilotProfile(c.req.valid("json")));
		})
		.patch(
			"/api/copilot/profiles/reorder",
			zValidator("query", z.object({ kind: z.string().min(1).default("experience") })),
			zValidator("json", schemas.reorderCopilotProfilesSchema),
			async (c) => {
				return c.json({ profiles: await runtime.reorderCopilotProfiles(c.req.valid("query").kind, c.req.valid("json").updates) });
			},
		)
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
