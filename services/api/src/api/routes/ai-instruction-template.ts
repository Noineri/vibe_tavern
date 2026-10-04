import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { AiInstructionTemplateRuntimeApi } from "../contract/runtime-api.js";

/**
 * User-saved instruction-template routes for the message AI editor
 * (AI_EDITOR_INSTRUCTION_TEMPLATES) — the format-template routes minus the
 * import endpoint (there is nothing to import: a template IS its text):
 *
 *  - `GET    /api/ai-instruction-templates`     — the library in store order.
 *  - `POST   /api/ai-instruction-templates`     — create (the «save current
 *    instruction» flow; name = first line of the text, chosen client-side).
 *  - `PATCH  /api/ai-instruction-templates/:id` — rename and/or overwrite
 *    the stored text.
 *  - `DELETE /api/ai-instruction-templates/:id` — delete (no references:
 *    insert copies text into the field, nothing points back at the id).
 */
export function createAiInstructionTemplateRoutes(runtime: AiInstructionTemplateRuntimeApi) {
	return new Hono()
		.get("/api/ai-instruction-templates", async (c) => {
			return c.json(await runtime.listAiInstructionTemplates());
		})
		.post("/api/ai-instruction-templates", zValidator("json", schemas.createAiInstructionTemplateSchema), async (c) => {
			return c.json(await runtime.createAiInstructionTemplate(c.req.valid("json")));
		})
		.patch("/api/ai-instruction-templates/:templateId", zValidator("json", schemas.updateAiInstructionTemplateSchema), async (c) => {
			return c.json(await runtime.updateAiInstructionTemplate(c.req.param("templateId"), c.req.valid("json")));
		})
		.delete("/api/ai-instruction-templates/:templateId", async (c) => {
			await runtime.deleteAiInstructionTemplate(c.req.param("templateId"));
			return c.json({ ok: true });
		});
}
