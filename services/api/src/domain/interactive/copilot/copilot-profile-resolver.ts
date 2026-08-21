/**
 * Copilot-profile resolution (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-6).
 *
 * Resolves the effective copilot profile for an experience (script): the
 * script's soft-linked `copilotProfileId` → the `copilot_profiles` row, with
 * the built-in read-only seed (CP-4) as the fallback for every "no profile"
 * case. The thread → script hop happens in the stream (which already loads the
 * thread for history) and hands the resolver its `scriptId`; this module owns
 * only the script → profile part so it stays unit-testable against a bare store
 * container.
 *
 * Fallback rule (zero behavior change for unassigned experiences): a null
 * scriptId, a missing script, a null/empty `copilotProfileId`, or a DANGLING id
 * (the profile row was deleted — the soft link is never FK-enforced) all resolve
 * to the built-in seed, exactly matching the pre-plan ER-16 module.
 */

import type { StoreContainer, CopilotProfileRow } from "@vibe-tavern/db";
import { COPILOT_TOOL_KEYS, type CopilotProfile, type CopilotToolSet } from "@vibe-tavern/api-contracts";
import { resolveBuiltinCopilotProfile } from "./experience-copilot-module.js";

/**
 * Project a stored user-profile row into the wire `CopilotProfile` shape.
 * `isBuiltIn` is always false here (the built-in seed is code-defined, never a
 * row); `createdAt`/`updatedAt` are dropped (the wire profile has no timestamps).
 * The stored `toolSet` is a loose partial record — it is projected through
 * {@link COPILOT_TOOL_KEYS} so only the known toggleable-tool keys (and only
 * their `true` entries) survive, producing a strict `CopilotToolSet`.
 */
export function copilotProfileRowToWire(row: CopilotProfileRow): CopilotProfile {
	const toolSet: CopilotToolSet = {};
	for (const key of COPILOT_TOOL_KEYS) {
		if (row.toolSet[key] === true) toolSet[key] = true;
	}
	return {
		id: row.id,
		name: row.name,
		isBuiltIn: false,
		basePrompt: row.basePrompt,
		skillIds: row.skillIds,
		toolSet,
	};
}

export class CopilotProfileResolver {
	constructor(private readonly stores: StoreContainer) {}

	/**
	 * Resolve the profile for a script. `scriptId === null` (a draft, pre-save)
	 * or any missing/dangling link falls back to the built-in seed.
	 */
	async resolveForScript(scriptId: string | null): Promise<CopilotProfile> {
		if (scriptId === null) return resolveBuiltinCopilotProfile();
		const script = await this.stores.scripts.getById(scriptId);
		const profileId = script?.copilotProfileId ?? null;
		if (profileId === null) return resolveBuiltinCopilotProfile();
		const row = await this.stores.copilotProfiles.getById(profileId);
		if (row === null) return resolveBuiltinCopilotProfile();
		return copilotProfileRowToWire(row);
	}
}
