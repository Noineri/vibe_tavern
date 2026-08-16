/**
 * Copilot skill catalog store (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 /
 * CP-10). Mirrors `coauthor-skill-store.ts` exactly but against the copilot
 * skill roots: the merged metadata-only catalog (built-in + user skills) is
 * canonical data consumed by the skill manager modal (import / inspect / delete)
 * and the profile editor's skill picker. Mutations delegate to the API and then
 * refresh the whole catalog — the server is the source of truth.
 */
import { create } from "zustand";
import type { SkillCatalogEntryDto, SkillCatalogError } from "@vibe-tavern/api-contracts";
import {
  listCopilotSkills,
  importCopilotSkills,
  deleteCopilotSkill,
} from "../api/copilot-skill-api.js";

export interface CopilotSkillState {
  entries: SkillCatalogEntryDto[];
  errors: SkillCatalogError[];
  isLoading: boolean;
  hasLoaded: boolean;
}

export interface CopilotSkillActions {
  /** Fetch the merged catalog. Safe to call repeatedly. */
  load: () => Promise<void>;
  /** Atomically import a skill tree (each file's `webkitRelativePath` is its
   *  relative path). Returns the imported skill ids. Refreshes the catalog. */
  importTree: (files: File[]) => Promise<string[]>;
  /** Delete one user skill by id. A pure built-in is rejected by the server. */
  remove: (id: string) => Promise<void>;
}

export type CopilotSkillStore = CopilotSkillState & CopilotSkillActions;

export const useCopilotSkillStore = create<CopilotSkillStore>()((set, get) => ({
  entries: [],
  errors: [],
  isLoading: false,
  hasLoaded: false,

  load: async () => {
    set({ isLoading: true });
    try {
      const { entries, errors } = await listCopilotSkills();
      set({ entries, errors, isLoading: false, hasLoaded: true });
    } catch {
      set({ isLoading: false, hasLoaded: true });
    }
  },

  importTree: async (files) => {
    const result = await importCopilotSkills(files);
    await get().load();
    return result.importedSkillIds;
  },

  remove: async (id) => {
    await deleteCopilotSkill(id);
    await get().load();
  },
}));

if (typeof window !== "undefined") window.__useCopilotSkillStore = useCopilotSkillStore;
