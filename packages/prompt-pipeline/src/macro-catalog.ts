import { createFullMacroEngine, type MacroCatalogEntry } from "./macro-registry.js";

let macroCatalogCache: MacroCatalogEntry[] | null = null;

/**
 * The full macro catalog (all user-facing resolvers), derived from a fresh full
 * engine and cached because the registry is static after module load.
 */
export function getMacroCatalog(): MacroCatalogEntry[] {
  if (macroCatalogCache == null) macroCatalogCache = createFullMacroEngine().catalog();
  return macroCatalogCache;
}
