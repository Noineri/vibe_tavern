import { create } from "zustand";

/**
 * Fine-tuning chip section open-state (IMAGEGEN_CHIP_REDESIGN_PLAN ICR-2).
 *
 * Owner ruling: the chip REMEMBERS which collapsible sections were open
 * between openings («давай рекомендованные, да», proposal 2). Plain Zustand,
 * no Immer (UI state, no canonical data), in-memory only — the memory spans
 * popover/sheet openings within the session and deliberately resets on
 * reload. GLOBAL, not per chat (the owner's phrasing was about the chip, not
 * per-conversation workspaces).
 *
 * Only the disclosure-variant sections live here (LoRA, Krea 2, Samplers) —
 * the toggle-variant sections (Hires, ADetailer) have no "open" of their
 * own: their body follows their own enabled value.
 */

export type ImageGenChipSectionKey = "loras" | "krea" | "samplers";

export interface ImageGenChipSectionsState {
  /** All sections collapsed by default (the mockup's resting state). */
  open: { loras: boolean; krea: boolean; samplers: boolean };
  setOpen: (key: ImageGenChipSectionKey, value: boolean) => void;
}

export const useImageGenChipSectionsStore = create<ImageGenChipSectionsState>()((set) => ({
  open: { loras: false, krea: false, samplers: false },
  setOpen: (key, value) =>
    set((state) => ({ open: { ...state.open, [key]: value } })),
}));
