import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { SamplerSetRuntimeApi } from "../contract/runtime-api.js";

/**
 * Named sampler-set library routes (LOCAL_SUPPORT_PLAN LS-5b). Mirrors the
 * small-resource pattern (copilot-profile.ts):
 *
 *  - `GET    /api/sampler-sets`              — the library in store order.
 *  - `POST   /api/sampler-sets`              — create from the panel's current
 *    values (the «+» flow: name + extracted overlay payload).
 *  - `PATCH  /api/sampler-sets/:setId`       — rename (pencil morph) and/or
 *    overwrite the stored payload (the 💾 save-into-set flow).
 *  - `DELETE /api/sampler-sets/:setId`       — delete; dangling
 *    provider_profiles.sampler_set_id references are cleared first (LS-5e).
 *  - `POST   /api/sampler-sets/import`       — point import (upload button):
 *    name + RAW JSON; the backend sniffs VT-native vs ST TextGen shape and
 *    pre-maps, returning the created set + import notes.
 */
export function createSamplerSetRoutes(runtime: SamplerSetRuntimeApi) {
	return new Hono()
		.get("/api/sampler-sets", async (c) => {
			return c.json(await runtime.listSamplerSets());
		})
		.post("/api/sampler-sets/import", zValidator("json", schemas.importSamplerSetSchema), async (c) => {
			return c.json(await runtime.importSamplerSet(c.req.valid("json")));
		})
		.post("/api/sampler-sets", zValidator("json", schemas.createSamplerSetSchema), async (c) => {
			return c.json(await runtime.createSamplerSet(c.req.valid("json")));
		})
		.patch("/api/sampler-sets/:setId", zValidator("json", schemas.updateSamplerSetSchema), async (c) => {
			return c.json(await runtime.updateSamplerSet(c.req.param("setId"), c.req.valid("json")));
		})
		.delete("/api/sampler-sets/:setId", async (c) => {
			await runtime.deleteSamplerSet(c.req.param("setId"));
			return c.json({ ok: true });
		});
}
