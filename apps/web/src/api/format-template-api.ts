/**
 * Typed RPC client for the named custom format-template library (LOCAL_SUPPORT
 * PLAN LS-10). Mirrors the sampler-set client but against
 * `client.api["format-templates"]…` — the format-block counterpart of the
 * sampler-set library: user-saved sequence bundles selectable in the provider
 * format block's auto dropdown, managed with the LS-5 save/rename chrome.
 */
import type {
	FormatTemplate,
	FormatTemplateCreate,
	FormatTemplateList,
	FormatTemplateUpdate,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/format-templates` — the library in store order. */
export async function listFormatTemplates(): Promise<FormatTemplateList> {
	const response = await client.api["format-templates"].$get();
	return unwrapRpc<FormatTemplateList>(response);
}

/** `POST /api/format-templates` — create from the manual editor's current
 *  sequences (the «save-as-new» morph flow). */
export async function createFormatTemplate(input: FormatTemplateCreate): Promise<FormatTemplate> {
	const response = await client.api["format-templates"].$post({ json: input });
	return unwrapRpc<FormatTemplate>(response);
}

/** `PATCH /api/format-templates/:id` — partial update: rename (the morph)
 *  and/or overwrite the stored payload. */
export async function updateFormatTemplate(
	templateId: string,
	input: FormatTemplateUpdate,
): Promise<FormatTemplate> {
	const response = await client.api["format-templates"][":templateId"].$patch({
		param: { templateId },
		json: input,
	});
	return unwrapRpc<FormatTemplate>(response);
}

/** `DELETE /api/format-templates/:id` — delete a template (profiles whose
 *  selection pointed at it degrade to auto semantics server-side). */
export async function deleteFormatTemplate(templateId: string): Promise<void> {
	const response = await client.api["format-templates"][":templateId"].$delete({
		param: { templateId },
	});
	if (!response.ok) throw await unwrapError(response);
}
