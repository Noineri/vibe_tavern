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
import { COPILOT_TOOL_KEYS, SCRIPT_AGENT_TOOL_KEYS, type CopilotProfile, type CopilotToolSet, type ScriptAgentToolSet } from "@vibe-tavern/api-contracts";
import { resolveBuiltinCopilotProfile } from "./experience-copilot-module.js";

/**
 * Project a stored user-profile row into the wire `CopilotProfile` shape.
 * `isBuiltIn` is always false here (the built-in seed is code-defined, never a
 * row); `createdAt`/`updatedAt` are dropped (the wire profile has no timestamps).
 * The stored `toolSet` is a loose partial record — it is projected through
 * the OWNING KIND's wire-contract tool keys (AS-7: `script` rows project
 * through `SCRIPT_AGENT_TOOL_KEYS`, everything else through
 * `COPILOT_TOOL_KEYS`) so only the kind's toggleable-tool keys (and only
 * their `true` entries) survive, producing a strict per-kind tool set.
 * `skillIds` is NOT projected (PM-8, owner ruling 2026-10-12): the skill
 * catalog is ungated, so the stored `skill_ids_json` column is legacy data
 * the resolver simply never reads.
 */
export function copilotProfileRowToWire(row: CopilotProfileRow): CopilotProfile {
	// Per-kind projection (AS-7): a script row projects through the script tool
	// keys, everything else through the experience keys — a union-typed key
	// array cannot index one concrete tool-set type, so the two projections
	// branch explicitly. Extend the branch when a third kind registers.
	let toolSet: CopilotProfile["toolSet"];
	if (row.agentKind === "script") {
		const scriptToolSet: ScriptAgentToolSet = {};
		for (const key of SCRIPT_AGENT_TOOL_KEYS) {
			if (row.toolSet[key] === true) scriptToolSet[key] = true;
		}
		toolSet = scriptToolSet;
	} else {
		const copilotToolSet: CopilotToolSet = {};
		for (const key of COPILOT_TOOL_KEYS) {
			if (row.toolSet[key] === true) copilotToolSet[key] = true;
		}
		toolSet = copilotToolSet;
	}
	return {
		id: row.id,
		name: row.name,
		isBuiltIn: false,
		basePrompt: row.basePrompt,
		toolSet,
		agentKind: row.agentKind,
	};
}

export class CopilotProfileResolver {
	constructor(private readonly stores: StoreContainer) {}

	/**
	 * Resolve the profile for a script. `scriptId === null` (a draft, pre-save)
	 * or any missing/dangling link falls back to the built-in seed.
	 */
	async resolveForScript(scriptId: string | null): Promise<CopilotProfile> {
		if (scriptId === null) return resolveBuiltinCopilotProfile("experience", this.stores.db);
		const script = await this.stores.scripts.getById(scriptId);
		const profileId = script?.copilotProfileId ?? null;
		if (profileId === null) return resolveBuiltinCopilotProfile("experience", this.stores.db);
		const row = await this.stores.copilotProfiles.getById(profileId);
		if (row === null) return resolveBuiltinCopilotProfile("experience", this.stores.db);
		return copilotProfileRowToWire(row);
	}
}
