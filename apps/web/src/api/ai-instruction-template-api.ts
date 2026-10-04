/**
 * Typed RPC client for the user-saved instruction-template library
 * (AI_EDITOR_INSTRUCTION_TEMPLATES) — a file-by-file fork of the
 * format-template client: the word-twin small-resource library behind the
 * message AI editor's «Templates ▾» button.
 */
import type {
	AiInstructionTemplate,
	AiInstructionTemplateCreate,
	AiInstructionTemplateList,
	AiInstructionTemplateUpdate,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/ai-instruction-templates` — the library in store order. */
export async function listAiInstructionTemplates(): Promise<AiInstructionTemplateList> {
	const response = await client.api["ai-instruction-templates"].$get();
	return unwrapRpc(response);
}

/** `POST /api/ai-instruction-templates` — create (the «save current
 *  instruction» flow). */
export async function createAiInstructionTemplate(input: AiInstructionTemplateCreate): Promise<AiInstructionTemplate> {
	const response = await client.api["ai-instruction-templates"].$post({ json: input });
	return unwrapRpc(response);
}

/** `PATCH /api/ai-instruction-templates/:id` — partial update: rename and/or
 *  overwrite the stored text. */
export async function updateAiInstructionTemplate(
	templateId: string,
	input: AiInstructionTemplateUpdate,
): Promise<AiInstructionTemplate> {
	const response = await client.api["ai-instruction-templates"][":templateId"].$patch({
		param: { templateId },
		json: input,
	});
	return unwrapRpc(response);
}

/** `DELETE /api/ai-instruction-templates/:id` — delete a template. */
export async function deleteAiInstructionTemplate(templateId: string): Promise<void> {
	const response = await client.api["ai-instruction-templates"][":templateId"].$delete({
		param: { templateId },
	});
	if (!response.ok) throw await unwrapError(response);
}
