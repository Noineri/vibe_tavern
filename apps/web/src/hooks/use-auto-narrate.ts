import { useEffect, useRef } from "react";

import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useMacroContext } from "../stores/chat-selectors.js";
import { useTtsPlaybackStore } from "../stores/tts-playback-store.js";
import { useVoiceMapData } from "../lib/tts/voice-map-data.js";
import { resolveNarrationProfile } from "../lib/tts/voice-map.js";
import { voicedVariantSource } from "../lib/tts/narration-source.js";

export function useAutoNarrate(): void {
  const autoNarrate = useTtsPlaybackStore((s) => s.autoNarrate);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const streamingMessageId = useChatStore((s) => {
    if (!s.activeChatId) return null;
    return s.generations[s.activeChatId]?.streamingMessageId ?? null;
  });
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const activeBranchId = useSnapshotStore((s) => (s.activeBranch ? String(s.activeBranch.id) : null));
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
      // Text seam: the shared voicedVariantSource (TPE-18a) — same
      // selected-variant preference (TTS annotation first, TPE-1) and same
      // TPE-19 macro rules as the manual button, so both speak
      // byte-identical text for the same message. KNOWN v1 DIVERGENCE
      // (documented in TTS_PLAN): markdownOnly display-regex presets are
      // NOT re-applied here (that seam lives inside MessageBlock's render
      // hooks); persist-mode regex already baked into stored content. The
      // manual narrate button reads the exact screen text.
      const source = voicedVariantSource(msg, macroContext, activeChat?.mode === "coauthor");
      if (!source) {
        // No speakable text (no variants / empty after cleaning) — consume
        // the transition like every other early-return path above.
        prevStreamingIdRef.current = cur;
        return;
      }
      const { text } = source;
      lastAutoNarratedIdRef.current = finishedId;
      // TPE-18a: playlist index meta — the chat + variant this narration
      // belongs to, plus the two-line snippet (owner decision). TPE-18c:
      // character + branch ride along for library addressing. The store
      // writes the index row when the orchestrator reports completion.
      const meta = activeChatId
        ? {
            chatId: activeChatId,
            characterId: activeChat?.characterId ? String(activeChat.characterId) : null,
            branchId: activeBranchId,
            variantId: source.variantId,
            variantIndex: source.variantIndex,
            snippet: source.snippet,
          }
        : undefined;
      void startNarration(finishedId, text, resolution.profile, meta);
    }

    prevStreamingIdRef.current = cur;
  }, [streamingMessageId, autoNarrate, activeChatId, activeChat, messagesById, messageOrder, macroContext, voiceMapData, startNarration]);
}
