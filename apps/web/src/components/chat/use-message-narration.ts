import { useCallback, useMemo } from "react";

import { useTtsPlaybackStore } from "../../stores/tts-playback-store.js";
import { resolveNarrationProfile } from "../../lib/tts/voice-map.js";
import { prepareNarrationText, narrationTextOptionsForMode } from "../../lib/tts/narration-text.js";
import { readTtsNarrationMode } from "../../lib/local-storage.js";
import { useVoiceMapData } from "../../lib/tts/voice-map-data.js";

export function useMessageNarration(
  messageId: string,
  characterId: string | null,
  personaId: string | null,
  getText: () => string,
): { available: boolean; narrating: boolean; onNarrate: () => void } {
  const { data } = useVoiceMapData();
  const narrations = useTtsPlaybackStore((s) => s.narrations);
  const startNarration = useTtsPlaybackStore((s) => s.startNarration);
  const stopNarration = useTtsPlaybackStore((s) => s.stopNarration);

  const resolution = useMemo(() => {
    if (data === null) return null;
    return resolveNarrationProfile(data.profiles, data.links, {
      ...(characterId ? { characterId } : {}),
      ...(personaId ? { personaId } : {}),
    });
  }, [data, characterId, personaId]);

  const available = resolution !== null && resolution.kind === "profile";

  const narrating = useMemo(() => {
    const state = narrations[messageId];
    if (!state) return false;
    return state.status === "generating" || state.status === "playing" || state.status === "paused";
  }, [narrations, messageId]);

  const onNarrate = useCallback(() => {
    if (narrating) {
      stopNarration();
      return;
    }
    if (!available || resolution === null || resolution.kind !== "profile") return;
    const raw = getText();
    const text = prepareNarrationText(raw, {
      regexPresets: [],
      skipCodeblocks: true,
      stripHtml: true,
      ...narrationTextOptionsForMode(readTtsNarrationMode()),
    });
    if (text.trim().length === 0) return;
    void startNarration(messageId, text, resolution.profile);
  }, [narrating, available, resolution, getText, messageId, startNarration, stopNarration]);

  return { available, narrating, onNarrate };
}
