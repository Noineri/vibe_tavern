/**
 * Per-character media-gallery cache (MEDIA_GALLERY_FRONTEND_PLAN F2).
 *
 * This is a UI/cache store, NOT canonical state: the server owns the gallery.
 * Only the gallery LIST + CRUD live here; the `includeGalleryInPrompt` /
 * `includeAvatarInPrompt` / `avatarDescription` toggles are character/persona
 * fields and flow through the snapshot store via `updateCharacter` /
 * `updatePersona` (NOT here).
 *
 * Invariants (MEDIA_GALLERY_FRONTEND_PLAN §"Non-negotiable constraints"):
 *  - Optimistic updates roll back on error + toast.
 *  - `describe` is NOT optimistic — it sets a per-image `describing` set and
 *    reloads when it resolves (vision describe is slow and may fail per-image).
 *  - `load` is idempotent (no-op if already loaded); `reload` forces.
 */
import { create } from "zustand";
import { toast } from "sonner";
import type { CharacterAsset } from "@vibe-tavern/domain";
import {
  listCharacterAssets,
  uploadCharacterAsset,
  updateCharacterAsset,
  reorderCharacterAssets,
  deleteCharacterAsset,
  describeCharacterAssets,
} from "../api/gallery-api.js";

export interface GalleryState {
  /** characterId → ordered gallery list. Presence ⇒ loaded. */
  byCharacter: Record<string, CharacterAsset[]>;
  /** characterId → currently loading the list (load/reload/describe-reload). */
  loading: Record<string, boolean>;
  /** characterId → currently uploading one or more images. */
  uploading: Record<string, boolean>;
  /** characterId → rowIds whose vision description is in flight. */
  describing: Record<string, Set<string>>;
  /** characterId → last fatal error message (null = none). */
  error: Record<string, string | null>;
}

export interface GalleryActions {
  /** Fetch the list; no-op if already cached. Call on first accordion open. */
  load(characterId: string): Promise<void>;
  /** Force-refresh the list (after describe, or manually). */
  reload(characterId: string): Promise<void>;
  /** Upload one image; appends the returned row. Sets `uploading` while in flight. */
  upload(characterId: string, file: File): Promise<void>;
  /** Optimistically edit a caption; rolls back on error. */
  updateCaption(characterId: string, rowId: string, caption: string): Promise<void>;
  /** Optimistically toggle a row's per-image prompt inclusion (D7); rolls back on error. */
  setIncludeInPrompt(characterId: string, rowId: string, includeInPrompt: boolean): Promise<void>;
  /** Optimistically reorder; rolls back on error. `orderedIds` is the FULL new order. */
  reorder(characterId: string, orderedIds: string[]): Promise<void>;
  /** Optimistically remove one row; rolls back (restores) on error. */
  remove(characterId: string, rowId: string): Promise<void>;
  /**
   * Vision-describe images. NOT optimistic: marks each target row in
   * `describing`, reloads the list on resolve. `rowIds` omitted ⇒ all
   * undescribed images. Partial failures are reported via toast; the list is
   * still reloaded so successful descriptions show.
   */
  describe(characterId: string, rowIds?: string[]): Promise<void>;
  /** Drop the cached list for a character (call on character switch / unmount). */
  reset(characterId: string): void;
}

export type GalleryStore = GalleryState & GalleryActions;

export const useGalleryStore = create<GalleryStore>((set, get) => ({
  byCharacter: {},
  loading: {},
  uploading: {},
  describing: {},
  error: {},

  async load(characterId) {
    if (get().byCharacter[characterId]) return; // idempotent
    await get().reload(characterId);
  },

  async reload(characterId) {
    set((s) => ({ loading: { ...s.loading, [characterId]: true }, error: { ...s.error, [characterId]: null } }));
    try {
      const list = await listCharacterAssets(characterId);
      set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: list } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({ error: { ...s.error, [characterId]: message } }));
      toast.error(message);
    } finally {
      set((s) => ({ loading: { ...s.loading, [characterId]: false } }));
    }
  },

  async upload(characterId, file) {
    set((s) => ({ uploading: { ...s.uploading, [characterId]: true } }));
    try {
      const asset = await uploadCharacterAsset(characterId, file);
      set((s) => ({
        byCharacter: { ...s.byCharacter, [characterId]: [...(s.byCharacter[characterId] ?? []), asset] },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
      throw err; // let the caller (footer Import) surface per-file failure
    } finally {
      set((s) => ({ uploading: { ...s.uploading, [characterId]: false } }));
    }
  },

  async updateCaption(characterId, rowId, caption) {
    const prev = get().byCharacter[characterId] ?? [];
    // Optimistic: patch the caption locally.
    set((s) => ({
      byCharacter: {
        ...s.byCharacter,
        [characterId]: prev.map((a) => (a.id === rowId ? { ...a, caption } : a)),
      },
    }));
    try {
      const updated = await updateCharacterAsset(characterId, rowId, { caption });
      set((s) => ({
        byCharacter: {
          ...s.byCharacter,
          [characterId]: (s.byCharacter[characterId] ?? []).map((a) => (a.id === rowId ? updated : a)),
        },
      }));
    } catch (err) {
      // Rollback to the pre-edit list.
      set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: prev } }));
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    }
  },

  async setIncludeInPrompt(characterId, rowId, includeInPrompt) {
    const prev = get().byCharacter[characterId] ?? [];
    // Optimistic: flip the flag locally.
    set((s) => ({
      byCharacter: {
        ...s.byCharacter,
        [characterId]: prev.map((a) => (a.id === rowId ? { ...a, includeInPrompt } : a)),
      },
    }));
    try {
      const updated = await updateCharacterAsset(characterId, rowId, { includeInPrompt });
      set((s) => ({
        byCharacter: {
          ...s.byCharacter,
          [characterId]: (s.byCharacter[characterId] ?? []).map((a) => (a.id === rowId ? updated : a)),
        },
      }));
    } catch (err) {
      // Rollback to the pre-toggle list.
      set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: prev } }));
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    }
  },

  async reorder(characterId, orderedIds) {
    const prev = get().byCharacter[characterId] ?? [];
    // Optimistic: reorder the local list to match orderedIds.
    const byId = new Map(prev.map((a) => [a.id as string, a]));
    const next = orderedIds.map((id) => byId.get(id)).filter((a): a is CharacterAsset => a != null);
    set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: next } }));
    try {
      await reorderCharacterAssets(characterId, orderedIds);
    } catch (err) {
      set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: prev } }));
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    }
  },

  async remove(characterId, rowId) {
    const prev = get().byCharacter[characterId] ?? [];
    // Optimistic: drop the row locally.
    set((s) => ({
      byCharacter: { ...s.byCharacter, [characterId]: prev.filter((a) => a.id !== rowId) },
    }));
    try {
      await deleteCharacterAsset(characterId, rowId);
    } catch (err) {
      // Rollback: restore the removed row (at its original position).
      set((s) => ({ byCharacter: { ...s.byCharacter, [characterId]: prev } }));
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    }
  },

  async describe(characterId, rowIds) {
    const list = get().byCharacter[characterId] ?? [];
    // Default: all undescribed rows.
    const targets = rowIds ?? list.filter((a) => a.description == null).map((a) => a.id);
    if (targets.length === 0) return;
    set((s) => ({ describing: { ...s.describing, [characterId]: new Set(targets) } }));
    try {
      const { failed } = await describeCharacterAssets(characterId, targets);
      if (failed.length > 0) {
        toast.error(`${failed.length} image(s) failed to describe.`);
      }
      // Reload so successful descriptions (persisted server-side) show.
      await get().reload(characterId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    } finally {
      set((s) => {
        const next = new Set(s.describing[characterId] ?? []);
        for (const id of targets) next.delete(id);
        return { describing: { ...s.describing, [characterId]: next } };
      });
    }
  },

  reset(characterId) {
    set((s) => {
      const { [characterId]: _drop, ...restList } = s.byCharacter;
      const { [characterId]: _ld, ...restLoading } = s.loading;
      const { [characterId]: _up, ...restUploading } = s.uploading;
      const { [characterId]: _ds, ...restDescribing } = s.describing;
      const { [characterId]: _er, ...restError } = s.error;
      void _drop; void _ld; void _up; void _ds; void _er;
      return {
        byCharacter: restList,
        loading: restLoading,
        uploading: restUploading,
        describing: restDescribing,
        error: restError,
      };
    });
  },
}));
