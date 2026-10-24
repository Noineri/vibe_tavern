/**
 * Copilot profile store (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3 / CP-8).
 * Mirrors `coauthor-skill-store.ts` (Zustand, canonical list + load + mutations
 * that refresh from the server — the server is the source of truth, not the
 * optimistic local patch). The built-in seed ("builtin", read-only) is returned
 * FIRST by `listCopilotProfiles`; user profiles follow. Assignment (which
 * profile an experience uses) is a SCRIPT property (`scripts.copilotProfileId`)
 * and is therefore NOT held here — the editor passes it into the modal and
 * writes it via `setCopilotProfile`.
 */
import { create } from "zustand";
import type { CopilotProfile, CopilotProfileCreate, CopilotProfileUpdate } from "@vibe-tavern/api-contracts";
import {
  listCopilotProfiles,
  createCopilotProfile,
  updateCopilotProfile,
  deleteCopilotProfile,
  reorderCopilotProfiles,
} from "../api/copilot-profile-api.js";

export interface CopilotProfileState {
  profiles: CopilotProfile[];
  isLoading: boolean;
  /** True once the first `load()` resolves (distinguishes "loading" from
   *  "loaded an empty list"). */
  hasLoaded: boolean;
  /** The kind the current list was loaded for (AS-8b — lists are
   *  kind-filtered server-side; mutations refresh under the SAME kind). */
  kind: string;
}

export interface CopilotProfileActions {
  /** Fetch the list for a kind (its built-in seed + its user profiles). Safe
   *  to call repeatedly. Omitting `kind` re-fetches the last-loaded kind. */
  load: (kind?: string) => Promise<void>;
  /** Create a user profile and refresh. Returns the created profile. */
  create: (input: CopilotProfileCreate) => Promise<CopilotProfile>;
  /** Update a user profile and refresh. Returns the updated profile. */
  update: (id: string, input: CopilotProfileUpdate) => Promise<CopilotProfile>;
  /** Delete a user profile and refresh. The built-in id is rejected server-side. */
  remove: (id: string) => Promise<void>;
  /** Rewrite ONE kind's user profiles' manual list order (ML-8) and adopt
   *  the reorder response (the server returns the refreshed merged list —
   *  the ServicePromptsPane pattern, no second fetch). The built-in seed
   *  has no stored record and never appears in `updates`. */
  reorder: (kind: string, updates: Array<{ id: string; sortOrder: number }>) => Promise<void>;
}

export type CopilotProfileStore = CopilotProfileState & CopilotProfileActions;

export const useCopilotProfileStore = create<CopilotProfileStore>()((set, get) => ({
  profiles: [],
  isLoading: false,
  hasLoaded: false,
  kind: "experience",

  load: async (kind?: string) => {
    const effectiveKind = kind ?? get().kind;
    set({ isLoading: true, ...(kind !== undefined ? { kind } : {}) });
    try {
      const profiles = await listCopilotProfiles(effectiveKind);
      set({ profiles, isLoading: false, hasLoaded: true });
    } catch {
      // Keep stale profiles on failure rather than blanking the UI; the caller's
      // toast surfaces the error. Loading clears either way.
      set({ isLoading: false, hasLoaded: true });
    }
  },

  create: async (input) => {
    const created = await createCopilotProfile(input);
    await get().load();
    return created;
  },

  update: async (id, input) => {
    const updated = await updateCopilotProfile(id, input);
    await get().load();
    return updated;
  },

  remove: async (id) => {
    await deleteCopilotProfile(id);
    await get().load();
  },

  reorder: async (kind, updates) => {
    const profiles = await reorderCopilotProfiles(kind, updates);
    set({ profiles });
  },
}));

if (typeof window !== "undefined") window.__useCopilotProfileStore = useCopilotProfileStore;
