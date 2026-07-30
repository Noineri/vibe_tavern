/**
 * Shared catalog store for Co-Author skills (CTX-S7). The merged metadata-only
 * catalog (built-in + user skills) is canonical data consumed by two surfaces:
 * the skill manager modal (import / inspect / delete) and the module editor's
 * skill picker. Centralizing it here means an import in the manager is
 * immediately visible to an open module editor, with a single fetch.
 *
 * Mutations (`importTree`, `remove`) delegate to {@link importCoauthorSkills} /
 * {@link deleteCoauthorSkill} and then refresh the whole catalog from the
 * server — the catalog is the source of truth, not the optimistic local patch.
 * The module reference guard (reporting modules that still bind a skill about
 * to be deleted) is a UI concern handled in the skill manager modal before it
 * calls `remove`; this store has no knowledge of modules.
 */
import { create } from "zustand";
import type { SkillCatalogEntryDto, SkillCatalogError } from "@vibe-tavern/api-contracts";
import {
  listCoauthorSkills,
  importCoauthorSkills,
  deleteCoauthorSkill,
} from "../api/skill-api.js";

export interface CoauthorSkillState {
  entries: SkillCatalogEntryDto[];
  errors: SkillCatalogError[];
  isLoading: boolean;
  /** True once the first `load()` resolves, so callers can distinguish "loading"
   *  from "loaded an empty catalog". */
  hasLoaded: boolean;
}

export interface CoauthorSkillActions {
  /** Fetch the merged catalog from the server. Safe to call repeatedly. */
  load: () => Promise<void>;
  /** Atomically import a skill tree (each file's `webkitRelativePath` is its
   *  relative path). Returns the imported skill ids. Refreshes the catalog. */
  importTree: (files: File[]) => Promise<string[]>;
  /** Delete one user skill by id. A pure built-in is rejected by the server.
   *  Refreshes the catalog. */
  remove: (id: string) => Promise<void>;
}

export type CoauthorSkillStore = CoauthorSkillState & CoauthorSkillActions;

export const useCoauthorSkillStore = create<CoauthorSkillStore>()((set, get) => ({
  entries: [],
  errors: [],
  isLoading: false,
  hasLoaded: false,

  load: async () => {
    set({ isLoading: true });
    try {
      const { entries, errors } = await listCoauthorSkills();
      set({ entries, errors, isLoading: false, hasLoaded: true });
    } catch {
      // Keep stale entries on failure rather than blanking the UI; surface via
      // the caller's toast. Loading clears either way.
      set({ isLoading: false, hasLoaded: true });
    }
  },

  importTree: async (files) => {
    const result = await importCoauthorSkills(files);
    await get().load();
    return result.importedSkillIds;
  },

  remove: async (id) => {
    await deleteCoauthorSkill(id);
    await get().load();
  },
}));

if (typeof window !== "undefined") window.__useCoauthorSkillStore = useCoauthorSkillStore;
