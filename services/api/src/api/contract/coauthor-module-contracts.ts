import type { CoauthorModule, CoauthorModuleCreate, CoauthorModuleUpdate } from "@vibe-tavern/api-contracts";

/**
 * Runtime contract for the user Co-Author module catalog (CS-24; stored order
 * ML-5) — extracted from runtime-api.ts for its size ratchet, the
 * coauthor-connection-contracts.ts pattern: the interface lives here and
 * ChatRuntimeApi extends it, so existing importers of the catalog are
 * untouched.
 *
 * Seed modules are code-defined read-only defs (the registry); this catalog
 * owns the DB-stored user modules and their manual list order.
 */
export interface CoauthorModuleRuntimeApi {
	/** The merged list (seed defs first, then user rows in stored order). */
	listCoauthorModules: () => Promise<CoauthorModule[]>;
	createCoauthorModule: (input: CoauthorModuleCreate) => Promise<CoauthorModule>;
	updateCoauthorModule: (id: string, input: CoauthorModuleUpdate) => Promise<CoauthorModule>;
	deleteCoauthorModule: (id: string) => Promise<void>;
	/** Rewrite the user modules' manual list order (ML-5) and return the full
	 * merged module list (seed defs first, then user rows in stored order) —
	 * the same list `listCoauthorModules` serves. */
	reorderCoauthorModules: (updates: Array<{ id: string; sortOrder: number }>) => Promise<CoauthorModule[]>;
}
