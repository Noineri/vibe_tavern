import { describe, expect, test, beforeEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

import { brandId, type Chat, type ChatBranchId, type ChatId, type CharacterId, type MessageId, type PromptPresetId, type ToolProfileId } from "@vibe-tavern/domain";
import type { AppMessage } from "../api/types.js";
import type { TtsProfileRecord } from "../api/tts-api.js";
import { useTtsPlaybackStore } from "../stores/tts-playback-store.js";
import { useChatStore, type ChatGenerationState } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Default",
    backend: "kokoro",
    config: {},
    hasStoredApiKey: false,
    voiceId: "af_heart",
    narratorVoiceId: null,
    lang: "en",
    sortOrder: 0,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const pDefault = profile({ id: "p1", isDefault: true });
const NOW = "2026-01-01T00:00:00.000Z";

// ─── typed fixtures (no casts) ──────────────────────────────────────────

function makeActiveChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: brandId<ChatId>("c1"),
    characterId: brandId<CharacterId>("char1"),
    personaId: null,
    title: "test chat",
    status: "active",
    mode: "rp",
    activeBranchId: brandId<ChatBranchId>("b1"),
    promptPresetId: brandId<PromptPresetId>("pp1"),
    toolProfileId: brandId<ToolProfileId>("tp1"),
    selectedGreetingIndex: 0,
    coauthorContextLinks: [],
    coauthorModuleId: null,
    dynamicPrompt: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeMessage(id: string, content: string): AppMessage {
  return {
    id: brandId<MessageId>(id),
    chatId: brandId<ChatId>("c1"),
    branchId: brandId<ChatBranchId>("b1"),
    role: "assistant",
    authorType: "assistant",
    position: 0,
    content,
    state: "complete",
    createdAt: NOW,
    updatedAt: NOW,
    variants: [],
    selectedVariantIndex: null,
    modelId: null,
    sceneTracker: null,
    toolCallId: null,
  };
}

function genState(streamingMessageId: string | null): ChatGenerationState {
  return {
    isSending: streamingMessageId !== null,
    streamingMessageId,
    streamingRevealedText: "",
    streamingReasoningText: "",
    generationStatus: streamingMessageId !== null ? "streaming" : "idle",
    pendingUserMessageContent: null,
    pendingUserMessageAttachments: [],
    pendingDiceRolls: [],
    abortController: null,
  };
}

// ─── module mock: voice-map-data (safe pattern — spread real first) ─────

let currentData: { profiles: TtsProfileRecord[]; links: Array<{ ttsProfileId: string; targetType: "character" | "persona"; targetId: string; mode: "voice" | "disabled" }> } | null = {
  profiles: [pDefault],
  links: [],
};

const realVoiceMapData = await import("../lib/tts/voice-map-data.js");
mock.module("../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  useVoiceMapData: () => ({
    data: currentData,
    refresh: async () => {},
  }),
  refreshVoiceMapData: async () => {},
}));

const { render, act, cleanup } = await import("@testing-library/react");
const { useAutoNarrate } = await import("./use-auto-narrate.js");

// Restore point: tests replace startNarration with capture mocks; reset the
// real implementation between tests so order never matters.
const realStartNarration = useTtsPlaybackStore.getState().startNarration;

function Probe() {
  useAutoNarrate();
  return null;
}

interface Captured {
  id: string;
  text: string;
  prof: TtsProfileRecord;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function seedActiveChatWith(message: AppMessage): void {
  useSnapshotStore.setState({
    activeChat: makeActiveChat(),
    messagesById: { [message.id]: message },
    messageOrder: [message.id],
  });
  useChatStore.setState({ activeChatId: brandId<ChatId>("c1"), generations: { c1: genState(message.id) } });
}

beforeEach(() => {
  useTtsPlaybackStore.setState({ narrations: {}, rate: 1, autoNarrate: false, startNarration: realStartNarration });
  useChatStore.setState({ activeChatId: null, generations: {} });
  useSnapshotStore.setState({ activeChat: undefined, messagesById: {}, messageOrder: [] });
  currentData = { profiles: [pDefault], links: [] };
  cleanup();
});

describe("useAutoNarrate", () => {
  test("fires once on streaming id->null when autoNarrate on, passing macro-seam text and resolved profile", async () => {
    const fired: Captured[] = [];
    useTtsPlaybackStore.setState({
      autoNarrate: true,
      startNarration: async (id: string, text: string, prof: TtsProfileRecord) => {
        fired.push({ id, text, prof });
      },
    });

    const m1 = makeMessage("m1", "hello world");
    seedActiveChatWith(m1);

    await act(async () => {
      render(React.createElement(Probe));
    });

    // Transition to null: stream finished.
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState(null) } });
    });
    await flushEffects();

    expect(fired.length).toBe(1);
    expect(fired[0].id).toBe("m1");
    expect(fired[0].text).toBe("hello world");
    expect(fired[0].prof.id).toBe("p1");

    // Second stream finishes for a message that is NOT last in order → no fire.
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState("m2") } });
    });
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState(null) } });
    });
    await flushEffects();
    expect(fired.length).toBe(1);
  });

  test("does not fire when autoNarrate off", async () => {
    let captured: Captured | null = null;
    useTtsPlaybackStore.setState({
      autoNarrate: false,
      startNarration: async (id: string, text: string, prof: TtsProfileRecord) => {
        captured = { id, text, prof };
      },
    });

    seedActiveChatWith(makeMessage("m1", "hi"));

    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState(null) } });
    });
    await flushEffects();
    expect(captured).toBeNull();
  });

  test("does not double-fire for same message", async () => {
    let callCount = 0;
    useTtsPlaybackStore.setState({
      autoNarrate: true,
      startNarration: async () => {
        callCount += 1;
      },
    });

    seedActiveChatWith(makeMessage("m1", "hi"));

    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState(null) } });
    });
    await flushEffects();
    expect(callCount).toBe(1);

    // Same id transitions again — guarded by lastAutoNarratedIdRef.
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState("m1") } });
    });
    await act(async () => {
      useChatStore.setState({ generations: { c1: genState(null) } });
    });
    await flushEffects();
    expect(callCount).toBe(1);
  });
});
