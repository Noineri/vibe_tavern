import type { CoauthorConnectionSettingsRecord, UpsertCoauthorConnectionSettingsValue } from "@vibe-tavern/api-contracts";

/**
 * Runtime contract for the per-connection Co-Author generation set
 * (COAUTHOR_OWN_GENERATION_SETTINGS_PLAN CG-1) — extracted from
 * runtime-api.ts for its size ratchet, the template-library-contracts.ts
 * pattern: the interface lives here and ProviderRuntimeApi extends it, so
 * existing importers of the catalog are untouched.
 *
 * The Co-Author shares ONLY the connection identity with the RP provider
 * profile; these two methods own the generation set that replaces every RP
 * inheritance (model, samplers, reasoning, limits).
 */
export interface CoauthorConnectionSettingsRuntimeApi {
	/** The connection's stored set, or `null` when it has none yet (the shared
	 *  domain resolver resolveCoauthorGenerationSettings applies the Co-Author
	 *  defaults — never an RP-profile fallback). Unknown provider id → 404. */
	getCoauthorConnectionSettings: (providerProfileId: string) => Promise<CoauthorConnectionSettingsRecord | null>;
	/** Persist the independently ordered Co-Author provider list. */
	reorderCoauthorProviderProfiles: (updates: Array<{ id: string; sortOrder: number }>) => Promise<void>;
	/** Replace the connection's whole set (model + settings) in one write. */
	upsertCoauthorConnectionSettings: (
		providerProfileId: string,
		body: UpsertCoauthorConnectionSettingsValue,
	) => Promise<CoauthorConnectionSettingsRecord>;
}
