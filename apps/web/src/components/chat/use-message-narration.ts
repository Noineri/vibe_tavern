import { useCallback, useMemo } from "react";

import { useTtsPlaybackStore } from "../../stores/tts-playback-store.js";
import type { NarrationStartMeta } from "../../stores/tts-playback-store.js";
import { useMacroContext } from "../../stores/chat-selectors.js";
import { useMessage, useSnapshotStore } from "../../stores/snapshot-store.js";
import { replaceUiMacros } from "../../lib/macros.js";
import { resolveNarrationProfile } from "../../lib/tts/voice-map.js";
import { prepareNarrationTextPreservingTags, narrationTextOptionsForMode } from "../../lib/tts/narration-text.js";
import { readTtsNarrationMode } from "../../lib/local-storage.js";
import { firstTwoLines, voicedVariantSource } from "../../lib/tts/narration-source.js";
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
  // TPE-19: the SAME macro context the chat view renders with
  // (useMacroContext — character/persona/pronouns from the snapshot
  // store), so the narrated text always matches the screen text.
  const macroContext = useMacroContext();
  const isCoauthorMode = useSnapshotStore((s) => s.activeChat?.mode === "coauthor");
  const activeChatId = useSnapshotStore((s) => (s.activeChat ? String(s.activeChat.id) : null));
  const message = useMessage(messageId);

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
    // getText() already prefers the selected variant's TTS annotation
    // (MessageBlock seam, TPE-1): when present it IS the narration source.
    // TPE-19: resolve UI macros BEFORE prepare — byte-identical to the
    // useAutoNarrate seam (same resolver, same context, same coauthor
    // guard) so manual and auto narration speak the same text. BEFORE
    // (not after): prepare strips codeblocks/HTML, and macro VALUES
    // (persona description, names) must go through the same cleaning as
    // the rest of the narration text. replaceUiMacros is idempotent, so
    // the already-resolved screen-text path is a no-op here.
    const base = macroContext && !isCoauthorMode ? replaceUiMacros(raw, macroContext) : raw;
    const text = prepareNarrationTextPreservingTags(base, {
      regexPresets: [],
      skipCodeblocks: true,
      stripHtml: true,
      ...narrationTextOptionsForMode(readTtsNarrationMode()),
    });
    if (text.trim().length === 0) return;
    // TPE-18a: playlist index meta from the shared voicedVariantSource
    // seam (same selected-variant preference, same TPE-19 macro rules).
    // The snippet is cut from the final voiced text (what the
    // synthesizer receives), not from the pre-prepare source.
    const source = voicedVariantSource(message, macroContext, isCoauthorMode);
    // Null-safe: without a chat or message the narration still plays,
    // just unindexed.
    const meta: NarrationStartMeta | undefined =
      activeChatId && source
        ? {
            chatId: activeChatId,
            variantId: source.variantId,
            variantIndex: source.variantIndex,
            snippet: firstTwoLines(text),
          }
        : undefined;
    void startNarration(messageId, text, resolution.profile, meta);
  }, [narrating, available, resolution, getText, messageId, startNarration, stopNarration, macroContext, isCoauthorMode, activeChatId, message]);

  return { available, narrating, onNarrate };
}
