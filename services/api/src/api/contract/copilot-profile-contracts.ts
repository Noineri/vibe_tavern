/**
 * Copilot profile contract (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3).
 *
 * Extracted into its own module per the file-size ratchet (runtime-api.ts
 * grows only by re-export) — the same split the tracker-template contracts
 * took. Re-exported from runtime-api.ts so every existing import path keeps
 * resolving.
 */

/** Copilot profile CRUD (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3). The
 *  built-in "Experience Authoring" seed (id "builtin") is READ-ONLY — update /
 *  delete reject it with a 400. AS-3: every profile carries `agentKind`
 *  (immutable after create); lists filter by it (`kind` defaults to
 *  `'experience'` so the current web client keeps working until AS-6).
 *  ML-6: the manual list order lives WITHIN one kind's list — `reorder`
 *  rewrites one kind's user rows and returns that kind's merged list. */
export interface CopilotProfileRuntimeApi {
	/** Built-in seed first, then user profiles of that kind in store order. */
	listCopilotProfiles: (kind?: string) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile[]>;
	createCopilotProfile: (input: import("@vibe-tavern/api-contracts").CopilotProfileCreate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	updateCopilotProfile: (id: string, input: import("@vibe-tavern/api-contracts").CopilotProfileUpdate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	deleteCopilotProfile: (id: string) => Promise<void>;
	/** Rewrite the manual list order (ML-6) of ONE kind's user profiles and
	 *  return that kind's full merged list (seed first, then user rows in
	 *  stored order) — the same list `listCopilotProfiles` serves. */
	reorderCopilotProfiles: (kind: string, updates: Array<{ id: string; sortOrder: number }>) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile[]>;
	// ── DR-2 (owner ruling M1): a profile's own model ─────────────────────
	/** Read the (kind, profile) own-model binding — `model: null` is no own
	 *  model (same as sidechat; no row). Addressable for built-in seed ids of
	 *  the kind and user rows of the kind alike; anything else is the shared
	 *  404. */
	getCopilotProfileModel: (
		kind: string,
		profileId: string,
	) => Promise<{ model: import("@vibe-tavern/api-contracts").AgentProfileModelWire | null }>;
	/** Set/replace the binding (a whole row, never a merge). The provider link
	 *  is soft: a dangling id stores fine and falls through to the chain at
	 *  turn time (the stream never errors on it). */
	setCopilotProfileModel: (
		kind: string,
		profileId: string,
		input: import("@vibe-tavern/api-contracts").AgentProfileModelPutRequest,
	) => Promise<{ model: import("@vibe-tavern/api-contracts").AgentProfileModelWire }>;
	/** Clear the binding (back to same as sidechat). Idempotent. */
	clearCopilotProfileModel: (kind: string, profileId: string) => Promise<{ ok: true }>;
}
