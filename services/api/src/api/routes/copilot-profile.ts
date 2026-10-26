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
 *
 * DR-2 (owner ruling M1) — a profile's own model, addressed per (kind,
 * profile) because built-in seed ids are kind-scoped (the kind-settings
 * path family):
 *  - `GET    /api/agent/kinds/:kind/profiles/:profileId/model` — read the
 *    binding; `{ model: null }` means no own model (same as sidechat; no
 *    row stored).
 *  - `PUT    /api/agent/kinds/:kind/profiles/:profileId/model` — set/replace
 *    the whole binding (`.strict()` body: `providerProfileId` required,
 *    `modelName` optional/null = the provider's default model).
 *  - `DELETE /api/agent/kinds/:kind/profiles/:profileId/model` — clear (back
 *    to same as sidechat); idempotent.
 *
 * Model set/clear is served for BUILT-IN seed ids too — the model is a
 * setting, not an edit (the read-only guard protects prompt/tools only).
 * The (kind, id) pair must address something (a declared seed of the kind or
 * a user row of the kind); anything else is the shared 404. An unknown kind
 * is the family's 400 `UNKNOWN_AGENT_KIND`. Deleting a USER profile through
 * the DELETE above removes its model row with it.
 */
export function createCopilotProfileRoutes(runtime: CopilotProfileRuntimeApi) {
	return new Hono()
		// DR-2 (M1): registered first among this file's additions — all three
		// carry a literal `model` tail, so they cannot collide with the
		// `:profileId`-shaped profile routes on other methods (Hono matches
		// method + registration order).
		.get("/api/agent/kinds/:kind/profiles/:profileId/model", async (c) => {
			return c.json(
				await runtime.getCopilotProfileModel(c.req.param("kind"), c.req.param("profileId")),
			);
		})
		.put(
			"/api/agent/kinds/:kind/profiles/:profileId/model",
			zValidator("json", schemas.agentProfileModelPutSchema),
			async (c) => {
				return c.json(
					await runtime.setCopilotProfileModel(
						c.req.param("kind"),
						c.req.param("profileId"),
						c.req.valid("json"),
					),
				);
			},
		)
		.delete("/api/agent/kinds/:kind/profiles/:profileId/model", async (c) => {
			return c.json(
				await runtime.clearCopilotProfileModel(c.req.param("kind"), c.req.param("profileId")),
			);
		})
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
