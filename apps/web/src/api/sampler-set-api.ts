/**
 * Typed RPC client for the named sampler-set library (LOCAL_SUPPORT_PLAN LS-5c).
 * Mirrors the copilot-profile client (`copilot-profile-api.ts`) but against
 * `client.api["sampler-sets"]…` — a global library of inert sampler value
 * bundles the provider sampler panel applies copy-on-select. The import call
 * sends the RAW parsed file JSON; the backend sniffs VT-native vs ST TextGen
 * shape and pre-maps (LS-5g), returning the created set + import notes.
 */
import type {
	SamplerSet,
	SamplerSetCreate,
	SamplerSetImport,
	SamplerSetList,
	SamplerSetUpdate,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/** `GET /api/sampler-sets` — the library in store order. */
export async function listSamplerSets(): Promise<SamplerSetList> {
	const response = await client.api["sampler-sets"].$get();
	return unwrapRpc<SamplerSetList>(response);
}

/** `POST /api/sampler-sets` — create from the panel's current values (the «+» flow). */
export async function createSamplerSet(input: SamplerSetCreate): Promise<SamplerSet> {
	const response = await client.api["sampler-sets"].$post({ json: input });
	return unwrapRpc<SamplerSet>(response);
}

/** `PATCH /api/sampler-sets/:setId` — partial update: rename (pencil morph)
 *  and/or overwrite the stored payload (the 💾 save-into-set flow). */
export async function updateSamplerSet(
	setId: string,
	input: SamplerSetUpdate,
): Promise<SamplerSet> {
	const response = await client.api["sampler-sets"][":setId"].$patch({
		param: { setId },
		json: input,
	});
	return unwrapRpc<SamplerSet>(response);
}

/** `DELETE /api/sampler-sets/:setId` — delete a set (dangling
 *  provider_profiles.sampler_set_id references are cleared server-side, LS-5e). */
export async function deleteSamplerSet(setId: string): Promise<void> {
	const response = await client.api["sampler-sets"][":setId"].$delete({
		param: { setId },
	});
	if (!response.ok) throw await unwrapError(response);
}

/** `POST /api/sampler-sets/import` — point import (upload button): name + RAW
 *  parsed JSON. Returns the created set + the ST mapping's skipped-field notes. */
export async function importSamplerSet(
	input: SamplerSetImport,
): Promise<{ set: SamplerSet; notes: string[] }> {
	const response = await client.api["sampler-sets"].import.$post({ json: input });
	return unwrapRpc<{ set: SamplerSet; notes: string[] }>(response);
}
