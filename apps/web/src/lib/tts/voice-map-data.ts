import { useCallback, useEffect, useState } from "react";

import { listAllTtsLinks, listAllTtsProfiles, type TtsLinkRecord, type TtsProfileRecord } from "../../api/tts-api.js";
import { devLog } from "../dev-log.js";

export interface VoiceMapData {
  profiles: TtsProfileRecord[];
  links: Array<TtsLinkRecord & { mode: "voice" | "disabled" }>;
}

let cachedData: VoiceMapData | null = null;
let inflightPromise: Promise<VoiceMapData | null> | null = null;
const listeners = new Set<(data: VoiceMapData | null) => void>();

function notifyListeners(data: VoiceMapData | null): void {
  for (const listener of listeners) listener(data);
}

async function fetchVoiceMapData(): Promise<VoiceMapData | null> {
  try {
    const [profiles, links] = await Promise.all([listAllTtsProfiles(), listAllTtsLinks()]);
    return { profiles, links };
  } catch (error) {
    devLog("voice-map-data-fetch-failed", { error: String(error) });
    return null;
  }
}

async function loadVoiceMapData(): Promise<VoiceMapData | null> {
  if (cachedData !== null) return cachedData;
  if (inflightPromise !== null) return inflightPromise;
  inflightPromise = fetchVoiceMapData().then((data) => {
    cachedData = data;
    inflightPromise = null;
    notifyListeners(data);
    return data;
  });
  return inflightPromise;
}

export async function refreshVoiceMapData(): Promise<void> {
  const data = await fetchVoiceMapData();
  cachedData = data;
  notifyListeners(data);
}

/** Test seam: reset module cache. */
export function __resetVoiceMapDataForTests(): void {
  cachedData = null;
  inflightPromise = null;
  listeners.clear();
}

export function useVoiceMapData(): { data: VoiceMapData | null; refresh: () => Promise<void> } {
  const [data, setData] = useState<VoiceMapData | null>(cachedData);

  useEffect(() => {
    listeners.add(setData);
    if (cachedData !== null) {
      setData(cachedData);
    } else if (inflightPromise === null) {
      void loadVoiceMapData().then((result) => {
        // load notifies listeners, but ensure this instance also updates if
        // it mounted before the fetch resolved.
        setData(result);
      });
    }
    return () => {
      listeners.delete(setData);
    };
  }, []);

  const refresh = useCallback(async () => {
    await refreshVoiceMapData();
  }, []);

  return { data, refresh };
}
