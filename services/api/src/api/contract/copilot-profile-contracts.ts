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
 *  delete reject it with a 400. */
export interface CopilotProfileRuntimeApi {
	/** Built-in seed first, then user profiles in store order. */
	listCopilotProfiles: () => Promise<import("@vibe-tavern/api-contracts").CopilotProfile[]>;
	createCopilotProfile: (input: import("@vibe-tavern/api-contracts").CopilotProfileCreate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	updateCopilotProfile: (id: string, input: import("@vibe-tavern/api-contracts").CopilotProfileUpdate) => Promise<import("@vibe-tavern/api-contracts").CopilotProfile>;
	deleteCopilotProfile: (id: string) => Promise<void>;
}
