import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { FormatTemplateRuntimeApi } from "../contract/runtime-api.js";

/**
 * Named custom format-template library routes (LOCAL_SUPPORT_PLAN LS-10).
 * Mirrors the sampler-set routes minus the import endpoint (ST instruct
 * import lands through the pane's own file picker + parser, not a raw-JSON
 * route):
 *
 *  - `GET    /api/format-templates`         — the library in store order.
 *  - `POST   /api/format-templates`         — create from the manual editor's
 *    current sequences (the «save-as-new» morph flow).
 *  - `PATCH  /api/format-templates/:id`     — rename (the morph) and/or
 *    overwrite the stored payload.
 *  - `DELETE /api/format-templates/:id`     — delete; profiles whose selection
 *    pointed at the deleted id degrade to auto semantics at resolution (a
 *    missing payload never breaks a generation).
 */
export function createFormatTemplateRoutes(runtime: FormatTemplateRuntimeApi) {
	return new Hono()
		.get("/api/format-templates", async (c) => {
			return c.json(await runtime.listFormatTemplates());
		})
		.post("/api/format-templates", zValidator("json", schemas.createFormatTemplateSchema), async (c) => {
			return c.json(await runtime.createFormatTemplate(c.req.valid("json")));
		})
		.patch("/api/format-templates/:templateId", zValidator("json", schemas.updateFormatTemplateSchema), async (c) => {
			return c.json(await runtime.updateFormatTemplate(c.req.param("templateId"), c.req.valid("json")));
		})
		.delete("/api/format-templates/:templateId", async (c) => {
			await runtime.deleteFormatTemplate(c.req.param("templateId"));
			return c.json({ ok: true });
		});
}
