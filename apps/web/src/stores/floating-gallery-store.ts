/**
 * Floating gallery viewers (owner fix 2026-10-20) — the ONE home for every
 * open floating `GalleryViewer`, shared by the chat Media menu
 * (`DesktopMediaMenu`) and the Build gallery (`GalleryGrid`).
 *
 * Why one store: both surfaces must keep a viewer open across a character
 * switch showing the image it was opened with. Local state cannot do both —
 * the chat menu stays mounted under a new `characterId` prop (re-targeting
 * the URL to a 404) and the Build grid unmounts when the other character's
 * accordion is collapsed (dropping the state). Each entry pins its own
 * `characterId` + asset snapshot (by id, never by list index), so a switch
 * neither closes nor re-targets viewers; the user closes them. A viewer
 * whose image is deleted closes via the gallery-store subscription below
 * (it has nothing to show).
 */
import { create } from "zustand";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useGalleryStore } from "./gallery-store.js";

export interface FloatingGalleryViewer {
  /** The character the viewer was opened from — the URL builds from this, never the current selection. */
  characterId: string;
  /** Asset snapshot at open time (by id, never by list index). */
  asset: CharacterAsset;
}

export interface FloatingGalleryState {
  viewers: FloatingGalleryViewer[];
}

export interface FloatingGalleryActions {
  /** Open a viewer; opening the same image twice keeps the one window. */
  openGalleryViewer(characterId: string, asset: CharacterAsset): void;
  /** Close one viewer. */
  closeGalleryViewer(characterId: string, rowId: string): void;
}

export type FloatingGalleryStore = FloatingGalleryState & FloatingGalleryActions;

export const useFloatingGalleryStore = create<FloatingGalleryStore>((set, get) => ({
  viewers: [],

  openGalleryViewer(characterId, asset) {
    const rowId = asset.id as string;
    if (get().viewers.some((v) => v.characterId === characterId && (v.asset.id as string) === rowId)) return;
    set((s) => ({ viewers: [...s.viewers, { characterId, asset }] }));
  },

  closeGalleryViewer(characterId, rowId) {
    set((s) => ({
      viewers: s.viewers.filter((v) => !(v.characterId === characterId && (v.asset.id as string) === rowId)),
    }));
  },
}));

// A viewer whose image is gone has nothing to show: whenever a character's
// gallery cache holds a LOADED list that no longer contains the row (an
// optimistic delete, or a server-side removal surfacing through reload),
// close its viewers. A MISSING list (never loaded, or dropped via reset)
// means "unknown" — the viewer stays open. That distinction is what lets a
// viewer survive a character switch to a character whose gallery was never
// loaded.
useGalleryStore.subscribe((gallery) => {
  const open = useFloatingGalleryStore.getState().viewers;
  if (open.length === 0) return;
  const gone = new Set<string>();
  for (const v of open) {
    const list = gallery.byCharacter[v.characterId];
    if (list !== undefined && !list.some((a) => a.id === v.asset.id)) {
      gone.add(`${v.characterId}:${v.asset.id as string}`);
    }
  }
  if (gone.size === 0) return;
  useFloatingGalleryStore.setState((s) => ({
    viewers: s.viewers.filter((v) => !gone.has(`${v.characterId}:${v.asset.id as string}`)),
  }));
});
