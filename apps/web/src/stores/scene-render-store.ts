/**
 * Scene state render-variant preference — the single source of truth for how a
 * validated `sceneState` block is VISUALLY rendered, shared by the chat header
 * (Scene zone, expanded) and the Build → Insights → Scene Preview.
 *
 * Selecting Graphical/Compact in the Preview re-renders the header too (and
 * vice-versa) — the choice is global, not Preview-local. Persisted to
 * localStorage so it survives a reload; defaults to `"rich"`.
 *
 * Raw JSON / XML are Preview-only debug views (a collapsed disclosure under the
 * rendered output), NOT a header view, so they are intentionally NOT part of
 * this preference — they never affect how the header renders.
 *
 * UI/cache store only — not canonical state, not synced to the server.
 */
import { create } from "zustand";

export type SceneRenderVariant = "rich" | "compact";

const STORAGE_KEY = "vibe:sceneRenderVariant";
const DEFAULT: SceneRenderVariant = "rich";

function hydrate(): SceneRenderVariant {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "compact" || v === "rich" ? v : DEFAULT;
  } catch {
    // localStorage disabled / quota — fall back to the default, stay in-memory.
    return DEFAULT;
  }
}

interface SceneRenderState {
  variant: SceneRenderVariant;
  setVariant: (v: SceneRenderVariant) => void;
}

export const useSceneRenderStore = create<SceneRenderState>((set) => ({
  variant: hydrate(),
  setVariant: (variant) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, variant);
      } catch {
        /* localStorage unavailable — the in-memory state still updates below. */
      }
    }
    set({ variant });
  },
}));

if (typeof window !== "undefined") window.__useSceneRenderStore = useSceneRenderStore;
