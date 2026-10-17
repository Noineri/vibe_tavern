/**
 * Copilot skill catalog store (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 /
 * CP-10, per-kind libraries AS-8d2). Mirrors `coauthor-skill-store.ts` but
 * against the copilot skill roots: each agent kind's merged metadata-only
 * catalog (built-in + user skills) is canonical data consumed by the skill
 * manager modal (import / inspect / delete). Mutations delegate to the API
 * and then refresh that kind's catalog — the server is the source of truth.
 * Catalogs are keyed by kind, so opening one kind's manager never shows
 * another kind's cached entries.
 */
import { create } from "zustand";
import type { SkillCatalogEntryDto, SkillCatalogError } from "@vibe-tavern/api-contracts";
import type { AgentKind } from "../lib/agent-host-registry.js";
import {
  listCopilotSkills,
  importCopilotSkills,
  deleteCopilotSkill,
} from "../api/copilot-skill-api.js";

/** One kind's cached skills library. */
export interface CopilotSkillCatalog {
  entries: SkillCatalogEntryDto[];
  errors: SkillCatalogError[];
  /** True once the first `load` for this kind resolves (distinguishes
   *  "loading" from "loaded an empty list"). */
  hasLoaded: boolean;
}

const EMPTY_CATALOG: CopilotSkillCatalog = { entries: [], errors: [], hasLoaded: false };

export interface CopilotSkillState {
  /** The merged catalog per agent kind (AS-8d2 — one library per kind). */
  catalogs: Partial<Record<AgentKind, CopilotSkillCatalog>>;
  isLoading: boolean;
}

export interface CopilotSkillActions {
  /** Fetch one kind's merged catalog. Safe to call repeatedly. */
  load: (kind: AgentKind) => Promise<void>;
  /** Atomically import a skill tree into one kind's library (each file's
   *  `webkitRelativePath` is its relative path). Returns the imported skill
   *  ids. Refreshes that kind's catalog. */
  importTree: (kind: AgentKind, files: File[]) => Promise<string[]>;
  /** Delete one user skill of one kind's library by id. A pure built-in is
   *  rejected by the server. Refreshes that kind's catalog. */
  remove: (kind: AgentKind, id: string) => Promise<void>;
}

export type CopilotSkillStore = CopilotSkillState & CopilotSkillActions;

export const useCopilotSkillStore = create<CopilotSkillStore>()((set, get) => ({
  catalogs: {},
  isLoading: false,

  load: async (kind) => {
    set({ isLoading: true });
    try {
      const { entries, errors } = await listCopilotSkills(kind);
      set((s) => ({
        catalogs: { ...s.catalogs, [kind]: { entries, errors, hasLoaded: true } },
        isLoading: false,
      }));
    } catch {
      // Keep stale entries on failure rather than blanking the UI; mark the
      // kind loaded so the manager settles instead of spinning.
      set((s) => ({
        catalogs: {
          ...s.catalogs,
          [kind]: { ...(s.catalogs[kind] ?? EMPTY_CATALOG), hasLoaded: true },
        },
        isLoading: false,
      }));
    }
  },

  importTree: async (kind, files) => {
    const result = await importCopilotSkills(kind, files);
    await get().load(kind);
    return result.importedSkillIds;
  },

  remove: async (kind, id) => {
    await deleteCopilotSkill(kind, id);
    await get().load(kind);
  },
}));

if (typeof window !== "undefined") window.__useCopilotSkillStore = useCopilotSkillStore;
