import { useEffect, useRef } from "react";

import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useMacroContext } from "../stores/chat-selectors.js";
import { replaceUiMacros } from "../lib/macros.js";
import { useTtsPlaybackStore } from "../stores/tts-playback-store.js";
import { useVoiceMapData } from "../lib/tts/voice-map-data.js";
import { resolveNarrationProfile } from "../lib/tts/voice-map.js";
import { prepareNarrationTextPreservingTags, narrationTextOptionsForMode } from "../lib/tts/narration-text.js";
import { readTtsNarrationMode } from "../lib/local-storage.js";

export function useAutoNarrate(): void {
  const autoNarrate = useTtsPlaybackStore((s) => s.autoNarrate);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const streamingMessageId = useChatStore((s) => {
    if (!s.activeChatId) return null;
    return s.generations[s.activeChatId]?.streamingMessageId ?? null;
  });
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const messagesById = useSnapshotStore((s) => s.messagesById);
  const messageOrder = useSnapshotStore((s) => s.messageOrder);
  const macroContext = useMacroContext();
  const { data: voiceMapData } = useVoiceMapData();
  const startNarration = useTtsPlaybackStore((s) => s.startNarration);

  const prevStreamingIdRef = useRef<string | null>(null);
  const lastAutoNarratedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevStreamingIdRef.current;
    const cur = streamingMessageId;

    // Detect transition id -> null : a stream just finished.
    if (prev !== null && cur === null) {
      const finishedId = prev;
      // Guard: fire once per finished message.
      if (lastAutoNarratedIdRef.current === finishedId) {
        prevStreamingIdRef.current = cur;
        return;
      }
      if (!autoNarrate) {
        prevStreamingIdRef.current = cur;
        return;
      }
      if (!activeChatId) {
        prevStreamingIdRef.current = cur;
        return;
      }
      const lastId = messageOrder[messageOrder.length - 1];
      if (lastId !== finishedId) {
        prevStreamingIdRef.current = cur;
        return;
      }
      const msg = messagesById[finishedId];
      if (!msg || msg.role !== "assistant") {
        prevStreamingIdRef.current = cur;
        return;
      }
      if (!voiceMapData) {
        prevStreamingIdRef.current = cur;
        return;
      }
      const characterId = activeChat?.characterId ? String(activeChat.characterId) : undefined;
      const personaId = activeChat?.personaId ? String(activeChat.personaId) : undefined;
      const resolution = resolveNarrationProfile(voiceMapData.profiles, voiceMapData.links, {
        ...(characterId ? { characterId } : {}),
        ...(personaId ? { personaId } : {}),
      });
      if (resolution.kind !== "profile") {
        prevStreamingIdRef.current = cur;
        return;
      }
      // Text seam: mirror `useDisplayMessage` (chat-selectors) — macro-resolve
      // UI macros ({{user}}/{{char}} literal names must not be spoken raw);
      // skip in coauthor mode exactly like the display selector. KNOWN v1
      // DIVERGENCE (documented in TTS_PLAN): markdownOnly display-regex presets
      // are NOT re-applied here (that seam lives inside MessageBlock's render
      // hooks); persist-mode regex already baked into stored content. The
      // manual narrate button reads the exact screen text.
      // TPE-1: the selected variant's TTS annotation, when present, IS the
      // narration source (same preference as the manual button) — the same
      // macro rules apply to it.
      const selectedVariant = msg.variants.find((variant) => variant.isSelected) ?? null;
      const source = selectedVariant?.ttsAnnotation ?? msg.content;
      const base =
        macroContext && activeChat?.mode !== "coauthor"
          ? replaceUiMacros(source, macroContext)
          : source;
      const text = prepareNarrationTextPreservingTags(base, {
        regexPresets: [],
        skipCodeblocks: true,
        stripHtml: true,
        ...narrationTextOptionsForMode(readTtsNarrationMode()),
      });
      if (text.trim().length === 0) {
        prevStreamingIdRef.current = cur;
        return;
      }
      lastAutoNarratedIdRef.current = finishedId;
      void startNarration(finishedId, text, resolution.profile);
    }

    prevStreamingIdRef.current = cur;
  }, [streamingMessageId, autoNarrate, activeChatId, activeChat, messagesById, messageOrder, macroContext, voiceMapData, startNarration]);
}
