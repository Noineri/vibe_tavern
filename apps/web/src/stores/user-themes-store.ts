import { create } from "zustand";
import type { UploadUserTheme, UserTheme, UserThemeSummary } from "@vibe-tavern/api-contracts";
import { userThemeApi, type UserThemeApi } from "../api/user-theme-api.js";

interface UserThemesState {
  themes: UserThemeSummary[];
  documents: Record<string, UserTheme>;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  load: () => Promise<void>;
  read: (id: string) => Promise<UserTheme | null>;
  upload: (input: UploadUserTheme) => Promise<UserTheme>;
  remove: (id: string) => Promise<void>;
}

/** API is the external boundary; catalog/cache are not persisted device preferences. */
export function createUserThemesStore(api: UserThemeApi = userThemeApi) {
  let mutation = 0;
  let listing: Promise<void> | null = null;
  const reads = new Map<string, Promise<UserTheme | null>>();
  const versions = new Map<string, number>();
  return create<UserThemesState>()((set, get) => ({
    themes: [], documents: {}, loaded: false, loading: false, error: null,
    load: () => {
      if (listing) return listing;
      const version = mutation;
      set({ loading: true, error: null });
      listing = (async () => {
        try {
          const themes = await api.list();
          if (version === mutation) set({ themes, loaded: true, error: null });
        } catch (error) {
          set({ error: asError(error) });
          throw error;
        } finally {
          listing = null;
          set({ loading: false });
        }
        // A mutation finished during this request; discard its stale snapshot
        // and discover the server's new state, rather than losing the mutation.
        if (version !== mutation) await get().load();
      })();
      return listing;
    },
    read: async (id) => {
      const cached = get().documents[id];
      if (cached) return cached;
      const pending = reads.get(id);
      if (pending) return pending;
      const version = versions.get(id) ?? 0;
      const request = (async () => {
        try {
          const theme = await api.read(id);
          if (version !== (versions.get(id) ?? 0)) return null;
          if (theme) set((state) => ({ documents: { ...state.documents, [id]: theme } }));
          return theme;
        } catch (error) {
          set({ error: asError(error) });
          throw error;
        }
      })();
      reads.set(id, request);
      try { return await request; }
      finally { if (reads.get(id) === request) reads.delete(id); }
    },
    upload: async (input) => {
      const theme = await api.upload(input);
      mutation++;
      set((state) => ({ themes: [...state.themes.filter((row) => row.id !== theme.id), theme], documents: { ...state.documents, [theme.id]: theme }, error: null }));
      // An upload can succeed after initial discovery failed; reconcile the
      // rest of the library without turning a saved upload into a UI failure.
      if (!get().loaded && !listing) void get().load().catch(() => undefined);
      return theme;
    },
    remove: async (id) => {
      await api.remove(id);
      mutation++;
      versions.set(id, (versions.get(id) ?? 0) + 1);
      reads.delete(id);
      set((state) => {
        const documents = { ...state.documents };
        delete documents[id];
        return { themes: state.themes.filter((theme) => theme.id !== id), documents, error: null };
      });
    },
  }));
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
export const useUserThemesStore = createUserThemesStore();
