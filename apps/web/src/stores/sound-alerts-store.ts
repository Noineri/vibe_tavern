import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * SM-8 sound alerts — per-device preferences (owner ruling 2026-10-06:
 * per-device like the interface prefs, no server sync; every toggle OFF by
 * default — «давай выключено пока человек не включит»).
 */

export const SOUND_ALERTS_STORAGE_KEY = "vibe-tavern.sound-alerts";

export interface SoundAlertsSettings {
  replyReady: boolean;
  imageReady: boolean;
  queueFinished: boolean;
  generationError: boolean;
  osNotifications: boolean;
  /** 0–1, applied to every tone at play time. */
  volume: number;
}

export const DEFAULT_SOUND_ALERTS: SoundAlertsSettings = {
  replyReady: false,
  imageReady: false,
  queueFinished: false,
  generationError: false,
  osNotifications: false,
  volume: 0.5,
};

interface SoundAlertsStore {
  settings: SoundAlertsSettings;
  setSetting: <K extends keyof SoundAlertsSettings>(key: K, value: SoundAlertsSettings[K]) => void;
}

type SyncStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage that degrades to an in-memory map when storage is blocked. */
function safeStorage(): SyncStorage {
  const memory = new Map<string, string>();
  return {
    getItem: (key) => {
      try { return localStorage.getItem(key); } catch { return memory.get(key) ?? null; }
    },
    setItem: (key, value) => {
      try { localStorage.setItem(key, value); } catch { memory.set(key, value); }
    },
    removeItem: (key) => {
      try { localStorage.removeItem(key); } catch { memory.delete(key); }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): SoundAlertsSettings {
  if (!record(value)) return { ...DEFAULT_SOUND_ALERTS };
  const toggles = ["replyReady", "imageReady", "queueFinished", "generationError", "osNotifications"] as const;
  const result = { ...DEFAULT_SOUND_ALERTS };
  for (const key of toggles) {
    if (typeof value[key] === "boolean") result[key] = value[key] as boolean;
  }
  const volume = value.volume;
  if (typeof volume === "number" && Number.isFinite(volume)) {
    result.volume = Math.min(1, Math.max(0, volume));
  }
  return result;
}

export const useSoundAlertsStore = create<SoundAlertsStore>()(
  persist(
    (set) => ({
      settings: { ...DEFAULT_SOUND_ALERTS },
      setSetting: (key, value) =>
        set((s) => ({ settings: validate({ ...s.settings, [key]: value }) })),
    }),
    {
      name: SOUND_ALERTS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage()),
      merge: (_persisted, current) => {
        const persisted = record(_persisted) ? (_persisted as { settings?: unknown }).settings : undefined;
        return { ...current, settings: validate(persisted) };
      },
    },
  ),
);
