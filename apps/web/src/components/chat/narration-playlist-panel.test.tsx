import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import type { AppMessage } from "../../api/types.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import type { NarrationPlayer } from "../../lib/tts/narration-player.js";
import type { NarrationPlaylistEntry, NarrationPlaylistIndex, NarrationSegmentCache } from "../../lib/tts/narration-cache.js";
import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "../../stores/tts-playback-store.js";
import { PlaylistVolumeRail } from "./playlist-volume-rail.js";
import en from "../../i18n/locales/en.json";
import ru from "../../i18n/locales/ru.json";

useDomEnv();

let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let act: typeof import("@testing-library/react").act;

function message(overrides: Omit<Partial<AppMessage>, "id"> & { id: string }): AppMessage {
  const id = brandId<MessageId>(overrides.id);
  return {
    chatId: brandId<ChatId>("c1"),
    branchId: brandId<ChatBranchId>("b1"),
    role: "assistant",
    authorType: "assistant",
    position: 0,
    content: "Body",
    state: "complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [
      {
        id: brandId<MessageVariantId>(`${overrides.id}-v1`),
        messageId: id,
        variantIndex: 0,
        content: "First line\nSecond line\nThird line",
        isSelected: true,
        finishReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    selectedVariantIndex: 0,
    modelId: null,
    sceneTracker: null,
    ...overrides,
    id,
  } as AppMessage;
}

const m1 = () => message({ id: "m1" });
const m2 = () =>
  message({
    id: "m2",
    content: "Second message body here",
    variants: [
      {
        id: brandId<MessageVariantId>("m2-v1"),
        messageId: brandId<MessageId>("m2"),
        variantIndex: 0,
        content: "Second message body here",
        isSelected: true,
        finishReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
const u1 = () => message({ id: "u1", role: "user", authorType: "user", content: "user words", variants: [] });

function profile(): TtsProfileRecord {
  return {
    id: "p1",
    name: "Test",
    backend: "openai",
    config: {},
    hasStoredApiKey: false,
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "alloy",
    narratorVoiceId: null,
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const mocks = {
  chatId: "c1",
  branchId: "b1",
  mobile: false,
  android: false,
  character: { id: "char1", name: "Hero" },
  persona: { id: "persona1", name: "Player", description: null, pronouns: null, pronounForms: null },
  macroContext: {
    characterName: "Hero",
    personaName: "Player",
    personaDescription: null,
    personaPronouns: null,
    personaPronounForms: null,
  },
  messages: [] as AppMessage[],
  voiceMap: {
    profiles: [profile()],
    links: [{ ttsProfileId: "p1", targetType: "character", targetId: "char1", mode: "voice" as const }],
  },
};

const realSnapshotStore = await import("../../stores/snapshot-store.js");
const realChatSelectors = await import("../../stores/chat-selectors.js");
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");
const realVoiceMapData = await import("../../lib/tts/voice-map-data.js");
const realTooltip = await import("../shared/Tooltip.js");
const realBottomSheet = await import("../shared/BottomSheet.js");
const realPlatform = await import("../../lib/platform.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      // Same shape as the dice-panel test mock: key + colon-joined vars.
      if (!vars) return key;
      return `${key}:${Object.values(vars).map((value) => String(value)).join(":")}:`;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => mocks.mobile,
}));

mock.module("../../stores/snapshot-store.js", () => ({
  ...realSnapshotStore,
  useSnapshotStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeChat: { id: mocks.chatId, characterId: "char1", personaId: "persona1", mode: "chat" },
      activeBranch: { id: mocks.branchId },
      character: mocks.character,
      persona: mocks.persona,
      messagesById: Object.fromEntries(mocks.messages.map((m) => [m.id, m])),
      messageOrder: mocks.messages.map((m) => m.id),
    }),
  useOrderedMessages: () => mocks.messages,
  useMessage: (id: string) => mocks.messages.find((m) => m.id === id) ?? null,
}));

mock.module("../../stores/chat-selectors.js", () => ({
  ...realChatSelectors,
  useMacroContext: () => mocks.macroContext,
}));

mock.module("../../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  useVoiceMapData: () => ({ data: mocks.voiceMap, refresh: async () => {} }),
}));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("../shared/BottomSheet.js", () => ({
  ...realBottomSheet,
  BottomSheet: ({ open, title, children }: { open: boolean; title?: ReactNode; children: ReactNode }) =>
    open ? <div data-testid="bottom-sheet">{title}{children}</div> : null,
}));

mock.module("../../lib/platform.js", () => ({
  ...realPlatform,
  // UA-driven like the real helper; tests flip mocks.android per case.
  isAndroidDevice: () => mocks.android,
}));

let NarrationPlaylistPanel: typeof import("./NarrationPlaylistPanel.js").NarrationPlaylistPanel;
beforeAll(async () => {
  ({ fireEvent, render, waitFor, act } = await import("@testing-library/react"));
  ({ NarrationPlaylistPanel } = await import("./NarrationPlaylistPanel.js"));
});

function memoryCache(): NarrationSegmentCache & { size: () => number } {
  const blobs = new Map<string, Blob>();
  return {
    async get(key: string) { return blobs.get(key) ?? null; },
    async put(key: string, blob: Blob) { blobs.set(key, blob); },
    async delete(key: string) { blobs.delete(key); },
    size: () => blobs.size,
  };
}

function memoryIndex(): NarrationPlaylistIndex {
  const chats = new Map<string, Map<string, NarrationPlaylistEntry>>();
  return {
    async list(chatId: string) {
      const items = chats.get(chatId);
      if (!items) return [];
      return [...items.values()].sort((a, b) => a.narratedAt - b.narratedAt);
    },
    async upsert(chatId: string, entry: NarrationPlaylistEntry) {
      let items = chats.get(chatId);
      if (!items) { items = new Map(); chats.set(chatId, items); }
      items.set(entry.messageId, entry);
    },
    async remove(chatId: string, messageId: string) {
      chats.get(chatId)?.delete(messageId);
    },
    async clear(chatId: string) { chats.delete(chatId); },
  };
}

function autoPlayer(): NarrationPlayer {
  return {
    play: async () => "ended",
    skipCurrent: () => {},
    pause: () => {},
    resume: () => {},
    setRate: () => {},
    dispose: () => {},
  };
}

let synthCalls: string[];
let cache: NarrationSegmentCache & { size: () => number };
// TPE-18c: hermetic library HTTP + merge seams (no real fetch/encoder).
let libraryFiles: Map<string, Blob>;
let librarySaved: Array<{ bytes: number; type: string }>;
let libraryDeleted: string[];
let libraryRevealed: string[];

function stubLibraryClient(): import("../../lib/tts/narration-library-client.js").NarrationLibraryClient {
  const keyOf = (ids: import("../../lib/tts/narration-library-client.js").NarrationLibraryIds): string =>
    `${ids.chatId}/${ids.branchId}/${ids.messageId}/${ids.variantIndex}`;
  return {
    async saveRecording(ids, audio) {
      librarySaved.push({ bytes: audio.size, type: audio.type });
      libraryFiles.set(keyOf(ids), audio);
      return { saved: true, leaf: "narrations/mock.ogg" };
    },
    async recordingExists(ids) {
      return libraryFiles.has(keyOf(ids));
    },
    async fetchRecording(ids) {
      return libraryFiles.get(keyOf(ids)) ?? null;
    },
    async deleteRecording(ids) {
      const deleted = libraryFiles.delete(keyOf(ids));
      if (deleted) libraryDeleted.push(keyOf(ids));
      return { deleted };
    },
    async revealRecording(ids) {
      libraryRevealed.push(keyOf(ids));
      return { revealed: true };
    },
  };
}

beforeEach(() => {
  mocks.chatId = "c1";
  mocks.branchId = "b1";
  mocks.mobile = false;
  mocks.android = false;
  mocks.messages = [m1(), u1()];
  synthCalls = [];
  cache = memoryCache();
  libraryFiles = new Map();
  librarySaved = [];
  libraryDeleted = [];
  libraryRevealed = [];
  // TPE-18b: reset the player-layer keys too (volume rehydrates from
  // localStorage at creation and would otherwise leak between tests).
  // TPE-18d: same for the chain pref + any armed advance.
  localStorage.clear();
  useTtsPlaybackStore.setState({ narrations: {}, playlist: {}, lastStarted: null, rate: 1, autoNarrate: false, volume: 1, progress: {}, continuous: false, advanceTo: null });
  __setTtsPlaybackDepsForTests({
    player: autoPlayer(),
    synthesize: mock(async (text: string) => {
      synthCalls.push(text);
      return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
    }),
    cache,
    playlistIndex: memoryIndex(),
    notifyError: () => {},
    libraryClient: stubLibraryClient(),
    mergeToOgg: async () => new Uint8Array([9, 9]),
  });
});

describe("narration playlist panel (TPE-18a)", () => {
  it("pill stays hidden with an empty playlist and opens after a narration lands in the index", async () => {
    const { queryByTestId, getByTestId } = render(<NarrationPlaylistPanel docked />);
    expect(queryByTestId("narration-playlist-pill")).toBeNull();

    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line\nThird line", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const row = await waitFor(() => getByTestId("narration-playlist-row"));
    expect(row.textContent).toContain("First line");
    // Owner scene: swipe number of the voiced variant (1 of 1 here).
    expect(row.textContent).toContain("narration_playlist_swipe:1:1:");
  });

  it("relisten plays from cache without synthesis", async () => {
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    // Seed with the message's own voiced text so the panel replay hits
    // the same segment key (a different text MUST miss — that is the
    // content-hash contract, pinned by the overwrite test below).
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line\nThird line", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
    expect(synthCalls).toHaveLength(1);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const play = await waitFor(() => getByTestId("playlist-row-play"));
    await act(async () => { fireEvent.click(play); });
    // The replay resolves through the segment cache — eventually consistent.
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    expect(synthCalls).toHaveLength(1);
  });

  it("live item shows growing n/total fetch progress while synthesizing", async () => {
    let releaseSecond!: (value: { blob: Blob; mime: string }) => void;
    let calls = 0;
    __setTtsPlaybackDepsForTests({
      player: autoPlayer(),
      synthesize: mock(async (text: string) => {
        calls += 1;
        synthCalls.push(text);
        if (calls === 1) return { blob: new Blob(["a1"]), mime: "audio/wav" };
        return new Promise<{ blob: Blob; mime: string }>((resolve) => { releaseSecond = resolve; });
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
    });
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const started = act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "Para one.\n\nPara two.", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "Para one.",
      });
    });
    // Two paragraphs = two segments; the first resolves, the second is held.
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    expect(pill.textContent).toContain("narration_playlist_generating");
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => {
      expect(queryByTestId("narration-playlist-row")?.textContent).toContain(
        "narration_playlist_fetching:1:2:",
      );
    });
    // The second segment is requested after the pacing yield — wait for
    // the deferred call before releasing it.
    await waitFor(() => { expect(calls).toBe(2); });
    await act(async () => { releaseSecond({ blob: new Blob(["a2"]), mime: "audio/wav" }); });
    await started;
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
  });

  it("lists only the selected variant and skips user messages", async () => {
    mocks.messages = [m1(), u1(), m2()];
    const { getByTestId, queryByText } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      const store = useTtsPlaybackStore.getState();
      await store.startNarration("m1", "First line", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
      await store.startNarration("m2", "Second message body here", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m2-v1", variantIndex: 0, snippet: "Second message body here",
      });
      await store.startNarration("u1", "user words", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "u1-v1", variantIndex: 0, snippet: "user words",
      });
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => {
      // m1 + m2 indexed; the user message never gets a row (owner decision).
      expect(document.querySelectorAll('[data-testid="narration-playlist-row"]')).toHaveLength(2);
    });
    expect(queryByText(/user words/)).toBeNull();
  });

  it("chat switch collapses the panel and hides the pill", async () => {
    const { getByTestId, queryByTestId, rerender } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));

    mocks.chatId = "c2";
    mocks.messages = [];
    rerender(<NarrationPlaylistPanel docked />);
    await waitFor(() => {
      expect(queryByTestId("narration-playlist-row")).toBeNull();
      expect(queryByTestId("narration-playlist-pill")).toBeNull();
    });
  });

  it("show-in-chat scrolls to the message and flashes it", async () => {
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));

    const target = document.createElement("div");
    target.setAttribute("data-message-id", "m1");
    document.body.appendChild(target);
    let scrolled = false;
    let flashed = false;
    target.scrollIntoView = () => { scrolled = true; };
    (target as unknown as { animate: unknown }).animate = () => { flashed = true; return {}; };
    try {
      await act(async () => { fireEvent.click(getByTestId("playlist-row-show")); });
      // The chat anchor is unique — playlist rows must not carry
      // data-message-id (they once shadowed the MessageShell anchor and
      // "show in chat" scrolled to the row itself).
      expect(document.querySelectorAll('[data-message-id="m1"]').length).toBe(1);
      expect(scrolled).toBe(true);
      expect(flashed).toBe(true);
    } finally {
      target.remove();
    }
  });

  it("rate button cycles the global playback rate", async () => {
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const rate = await waitFor(() => getByTestId("playlist-rate"));
    expect(rate.textContent).toContain("×1");
    await act(async () => { fireEvent.click(rate); });
    expect(useTtsPlaybackStore.getState().rate).toBe(1.25);
  });

  it("mobile renders the sheet variant", async () => {
    mocks.mobile = true;
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), {
        chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("bottom-sheet"));
  });

  it("declares every visible string in en + ru", () => {
    const keys = [
      "narration_playlist_title",
      "narration_playlist_open",
      "narration_playlist_count",
      "narration_playlist_generating",
      "narration_playlist_empty",
      "narration_playlist_show_in_chat",
      "narration_playlist_swipe",
      "narration_playlist_fetching",
      "narration_playlist_rate",
      "narration_playlist_pause",
      "narration_playlist_resume",
      "narration_playlist_volume",
      "narration_playlist_seek",
    ];
    for (const key of keys) {
      expect((en as Record<string, string>)[key], `en:${key}`).toBeTruthy();
      expect((ru as Record<string, string>)[key], `ru:${key}`).toBeTruthy();
    }
  });


describe("narration playlist player controls (TPE-18b)", () => {
  interface DeferredLane {
    plays: Array<{ text: string; startAt: number }>;
    pauseCalls: string[];
    volumeCalls: number[];
    resolveCurrent: (result?: "ended" | "skipped" | "error") => void;
  }

  /** Controllable lane: deferred plays, recorded pauses/volume, fixed
   *  probe durations (one 10s segment per blob unless mapped). */
  function installDeferredLane(durationsByText: Record<string, number> = {}): DeferredLane {
    const plays: DeferredLane["plays"] = [];
    const pauseCalls: string[] = [];
    const volumeCalls: number[] = [];
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(blob: Blob, _rate: number, options?: { startAt?: number }): Promise<"ended" | "skipped" | "error"> {
          void blob.text().then((t) => plays.push({ text: t, startAt: options?.startAt ?? 0 }));
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => { pauseCalls.push("pause"); },
        resume: () => { pauseCalls.push("resume"); },
        setRate: () => {},
        setVolume: (v: number) => { volumeCalls.push(v); },
        probeDuration: (blob: Blob) => blob.text().then((t) => durationsByText[t] ?? null),
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
    });
    return {
      plays,
      pauseCalls,
      volumeCalls,
      resolveCurrent: (result = "ended") => {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn(result);
      },
    };
  }

  function playlistMeta() {
    return { chatId: "c1", characterId: "char1", branchId: "b1", variantId: "m1-v1", variantIndex: 0, snippet: "Para one." };
  }

  it("pause freezes the live lane and resume continues it (unified bar play-pause; RD-5 replaces the pause-only toggle)", async () => {
    const lane = installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    // Do NOT await the narration inside act — the deferred play parks it.
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "Para one.", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));

    // RD-5: the footer pause-only toggle is gone — the unified bar
    // play-pause owns the same lane path (playing → pause offered).
    const pause = getByTestId("playlist-bar-play");
    expect(pause.getAttribute("aria-label")).toContain("narration_playlist_pause");
    await act(async () => { fireEvent.click(pause); });
    expect(lane.pauseCalls).toEqual(["pause"]);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");

    // The button now offers resume; the parked segment does not advance.
    expect(getByTestId("playlist-bar-play").getAttribute("aria-label")).toContain("narration_playlist_resume");
    await act(async () => { fireEvent.click(getByTestId("playlist-bar-play")); });
    expect(lane.pauseCalls).toEqual(["pause", "resume"]);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");

    await act(async () => { lane.resolveCurrent("ended"); });
    await started;
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    // One synthesis, one play: pause never skipped or duplicated the segment.
    expect(synthCalls).toHaveLength(1);
    expect(lane.plays).toHaveLength(1);
  });

  it("RD-3: live rows show a row stop; both it and the footer stop abort the same lane (single stopNarration path)", async () => {
    const lane = installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    // Do NOT await the narration inside act — the deferred play parks it.
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", "Para one.", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));

    // RD-3 supersedes the FS-2 layout ("no per-row stop") per the
    // owner's «отдельно кнопка стоп»: the live row offers a stop next
    // to play/pause, inside the controls zone.
    const rowStop = getByTestId("playlist-row-stop");
    expect(getByTestId("playlist-row-play")).toBeDefined();
    const controls = rowStop.closest('[data-testid="playlist-row-zone-controls"]');
    expect(controls).not.toBeNull();
    // The footer stop surface stays: enabled while the lane is live.
    const footerStop = getByTestId("playlist-stop");
    expect(footerStop.getAttribute("disabled")).toBeNull();
    // The row surface aborts the parked lane with the same store
    // outcome the FS-2 footer-stop assertion pinned — one path.
    await act(async () => { fireEvent.click(rowStop); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().lastStarted).toBeNull();
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
  });

  it("seek bar jumps the live lane to the dragged position (cache hit, offset kept)", async () => {
    const lane = installDeferredLane({ "audio:Para one.": 10 });
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "Para one.", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    // Wait for the background duration probe — the seek maps over it.
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().progress["m1"]?.durations).toEqual([10]);
    });

    // 3s into the 10s segment: same-segment clock jump, served from cache.
    await act(async () => { fireEvent.change(getByTestId("playlist-seek"), { target: { value: "3" } }); });
    await waitFor(() => { expect(lane.plays).toHaveLength(2); });
    expect(lane.plays[1]).toEqual({ text: "audio:Para one.", startAt: 3 });
    expect(synthCalls).toHaveLength(1);

    await act(async () => { lane.resolveCurrent("ended"); });
    await started;
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
  });

  it("volume rail persists globally and reaches the lane player", async () => {
    const lane = installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    // Do NOT await the narration inside act — the deferred play parks it.
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("playlist-volume"));

    await act(async () => { fireEvent.change(getByTestId("playlist-volume"), { target: { value: "0.5" } }); });
    expect(useTtsPlaybackStore.getState().volume).toBe(0.5);
    expect(localStorage.getItem("vt.tts.narration-volume")).toBe("0.5");
    expect(lane.volumeCalls).toContain(0.5);
  });

  it("RD-4a: percent shows above the rail only while interacting — no numeric input anywhere", async () => {
    const lane = installDeferredLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const rail = await waitFor(() => getByTestId("playlist-volume"));
    // The FS-5 percent number box is gone: no numeric input in the panel.
    expect(queryByTestId("playlist-volume-number")).toBeNull();
    expect(document.querySelector('input[inputmode="numeric"]')).toBeNull();
    // Idle: the reserved slot renders blank — never a number.
    expect(getByTestId("playlist-volume-percent").textContent).toBe("");
    await act(async () => { fireEvent.mouseDown(rail); });
    // Default full volume renders as percent, not 0..1 — while held.
    expect(getByTestId("playlist-volume-percent").textContent).toBe("100%");
    await act(async () => { fireEvent.change(rail, { target: { value: "0.5" } }); });
    expect(getByTestId("playlist-volume-percent").textContent).toBe("50%");
    // Internal contract unchanged: store + persistence + lane stay 0..1.
    expect(useTtsPlaybackStore.getState().volume).toBe(0.5);
    expect(localStorage.getItem("vt.tts.narration-volume")).toBe("0.5");
    expect(lane.volumeCalls).toContain(0.5);
    // The hard-stop fill follows the value via the --p custom property.
    expect(rail.getAttribute("style") ?? "").toContain("--p: 50%");
    await act(async () => { fireEvent.mouseUp(rail); });
    expect(getByTestId("playlist-volume-percent").textContent).toBe("");
  });

  it("RD-4b: mute writes 0 and unmute restores the pre-mute volume", async () => {
    const lane = installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const rail = await waitFor(() => getByTestId("playlist-volume"));
    await act(async () => { fireEvent.change(rail, { target: { value: "0.5" } }); });
    const mute = getByTestId("playlist-volume-mute");
    await act(async () => { fireEvent.click(mute); });
    expect(useTtsPlaybackStore.getState().volume).toBe(0);
    expect(localStorage.getItem("vt.tts.narration-volume")).toBe("0");
    expect(lane.volumeCalls).toContain(0);
    await act(async () => { fireEvent.click(mute); });
    expect(useTtsPlaybackStore.getState().volume).toBe(0.5);
    expect(localStorage.getItem("vt.tts.narration-volume")).toBe("0.5");
  });

  it("RD-4c: arrow keys adjust the rail volume", async () => {
    installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), playlistMeta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const rail = await waitFor(() => getByTestId("playlist-volume"));
    await act(async () => { fireEvent.change(rail, { target: { value: "0.5" } }); });
    await act(async () => { fireEvent.keyDown(rail, { key: "ArrowUp" }); });
    expect(useTtsPlaybackStore.getState().volume).toBe(0.55);
    await act(async () => { fireEvent.keyDown(rail, { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(rail, { key: "ArrowDown" }); });
    expect(useTtsPlaybackStore.getState().volume).toBe(0.45);
  });

  it("RD-4d: rail and seek render the playlist-local slider family (vertical rail density)", async () => {
    const lane = installDeferredLane();
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    let started: Promise<void> | null = null;
    act(() => {
      started = useTtsPlaybackStore.getState().startNarration("m1", "First line", profile(), playlistMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const volume = await waitFor(() => getByTestId("playlist-volume"));
    expect(volume.getAttribute("class") ?? "").toContain("playlist-slider");
    expect(volume.getAttribute("class") ?? "").toContain("playlist-slider--vertical");
    expect(volume.getAttribute("class") ?? "").not.toContain("playlist-slider--seek");
    // The live row's playback bar joins the same family at seek density.
    const seek = await waitFor(() => getByTestId("playlist-seek"));
    expect(seek.getAttribute("class") ?? "").toContain("playlist-slider--seek");
  });

  it("RD-4e: disabled rail renders inert", () => {
    const { getByTestId } = render(
      <PlaylistVolumeRail value={0.5} onChange={() => {}} disabled rangeTestId="t-range" muteTestId="t-mute" percentTestId="t-percent" />,
    );
    expect((getByTestId("t-range") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("t-mute") as HTMLButtonElement).disabled).toBe(true);
  });

  it("formats the seek clock as m:ss", async () => {
    const { formatPlaybackTime } = await import("./NarrationPlaylist.js");
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(5)).toBe("0:05");
    expect(formatPlaybackTime(65)).toBe("1:05");
    expect(formatPlaybackTime(600)).toBe("10:00");
  });
});

describe("narration playlist partial tracks (FS-3)", () => {
  const TEXT = "Para one and only.";

  function singleLineMessage(): AppMessage {
    return message({
      id: "m1",
      content: TEXT,
      variants: [
        {
          id: brandId<MessageVariantId>("m1-v1"),
          messageId: brandId<MessageId>("m1"),
          variantIndex: 0,
          content: TEXT,
          isSelected: true,
          finishReason: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  function abortMeta() {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: "m1-v1",
      variantIndex: 0,
      snippet: TEXT,
    };
  }

  /** Deferred player lane (single parked segment) — same shape as the
   *  TPE-18b helper, scoped here because that one lives in its describe. */
  function parkLane(): {
    plays: Array<{ text: string; startAt: number }>;
    resolveCurrent: (result?: "ended" | "skipped" | "error") => void;
  } {
    const plays: Array<{ text: string; startAt: number }> = [];
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(blob: Blob, _rate: number, options?: { startAt?: number }): Promise<"ended" | "skipped" | "error"> {
          void blob.text().then((t) => plays.push({ text: t, startAt: options?.startAt ?? 0 }));
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
    });
    return {
      plays,
      resolveCurrent: (result = "ended") => {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn(result);
      },
    };
  }

  function partialEntry(): NarrationPlaylistEntry | undefined {
    return useTtsPlaybackStore.getState().playlist["c1"]?.find((entry) => entry.messageId === "m1");
  }

  it("FS-3a: aborting mid-way keeps the pill and surfaces a partial row with continue", async () => {
    mocks.messages = [singleLineMessage(), u1()];
    const lane = parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), abortMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    // Abort through the footer stop (the only stop since FS-2).
    await act(async () => { fireEvent.click(getByTestId("playlist-stop")); });
    // The aborted lane lands in the index as a partial row — wait for
    // the write before asserting the pill, so the test pins the end
    // state instead of racing the live-to-index handoff.
    await waitFor(() => { expect(partialEntry()?.partial).toBe(true); });
    expect(getByTestId("narration-playlist-pill")).toBeDefined();
    const row = getByTestId("narration-playlist-row");
    expect(row.textContent).toContain(TEXT);
    expect(getByTestId("playlist-row-continue")).toBeDefined();
    expect(getByTestId("playlist-row-drop-cache")).toBeDefined();
    // Partials never offer library save (the file is whole-track only).
    expect(queryByTestId("playlist-row-save")).toBeNull();
    const entry = partialEntry();
    expect(entry?.cacheKeys.length).toBeGreaterThan(0);
  });

  it("FS-3b: continue re-runs the narration from cache and settles the row", async () => {
    mocks.messages = [singleLineMessage(), u1()];
    const lane = parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), abortMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    act(() => { useTtsPlaybackStore.getState().stopNarration(); });
    await waitFor(() => { expect(partialEntry()?.partial).toBe(true); });
    await act(async () => { fireEvent.click(getByTestId("narration-playlist-pill")); });
    await waitFor(() => getByTestId("playlist-row-continue"));
    expect(synthCalls).toHaveLength(1);
    // Continue speaks the same voiced variant text, so every segment is
    // a cache hit: one more play, zero new synthesis.
    await act(async () => { fireEvent.click(getByTestId("playlist-row-continue")); });
    await waitFor(() => { expect(lane.plays).toHaveLength(2); });
    expect(lane.plays[1]?.text).toBe(`audio:${TEXT}`);
    expect(synthCalls).toHaveLength(1);
    await act(async () => { lane.resolveCurrent("ended"); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    // A genuine completion clears the partial flag — the row settles.
    await waitFor(() => { expect(partialEntry()?.partial).not.toBe(true); });
    expect(queryByTestId("playlist-row-continue")).toBeNull();
    expect(getByTestId("narration-playlist-row")).toBeDefined();
    expect(getByTestId("narration-playlist-pill")).toBeDefined();
  });

  it("FS-3c: dropping the partial clears it and hides the pill when nothing remains", async () => {
    mocks.messages = [singleLineMessage(), u1()];
    const lane = parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), abortMeta());
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    act(() => { useTtsPlaybackStore.getState().stopNarration(); });
    await waitFor(() => { expect(partialEntry()?.partial).toBe(true); });
    const keys = [...(partialEntry()?.cacheKeys ?? [])];
    expect(keys.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(getByTestId("narration-playlist-pill")); });
    await waitFor(() => getByTestId("playlist-row-drop-cache"));
    await act(async () => { fireEvent.click(getByTestId("playlist-row-drop-cache")); });
    // The row is gone, its blobs are evicted, and with no live lane and
    // no rows left the pill unmounts.
    await waitFor(() => { expect(queryByTestId("narration-playlist-pill")).toBeNull(); });
    expect(queryByTestId("narration-playlist-row")).toBeNull();
    expect(partialEntry()).toBeUndefined();
    for (const key of keys) {
      expect(await cache.get(key)).toBeNull();
    }
  });
});

describe("narration playlist re-voice (FS-6)", () => {
  const FULL_TEXT = "Revoice one.\n\nRevoice two.";

  function revoiceMessage(id: string, text: string): AppMessage {
    return message({
      id,
      content: text,
      variants: [
        {
          id: brandId<MessageVariantId>(`${id}-v1`),
          messageId: brandId<MessageId>(id),
          variantIndex: 0,
          content: text,
          isSelected: true,
          finishReason: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  function revoiceMeta(messageId: string) {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: `${messageId}-v1`,
      variantIndex: 0,
      snippet: "Revoice one.",
    };
  }

  function playlistEntry(messageId: string): NarrationPlaylistEntry | undefined {
    return useTtsPlaybackStore.getState().playlist["c1"]?.find((entry) => entry.messageId === messageId);
  }

  function trackCacheDeletes(): string[] {
    const deleted: string[] = [];
    const originalDelete = cache.delete.bind(cache);
    cache.delete = async (key: string): Promise<void> => {
      deleted.push(key);
      await originalDelete(key);
    };
    return deleted;
  }

  function parkLane(): {
    plays: Array<{ text: string; startAt: number }>;
    resolveCurrent: (result?: "ended" | "skipped" | "error") => void;
  } {
    const plays: Array<{ text: string; startAt: number }> = [];
    let currentResolve: ((value: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(blob: Blob, _rate: number, options?: { startAt?: number }): Promise<"ended" | "skipped" | "error"> {
          void blob.text().then((text) => plays.push({ text, startAt: options?.startAt ?? 0 }));
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const resolve = currentResolve;
          currentResolve = null;
          if (resolve) resolve("skipped");
        },
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      notifyError: () => {},
    });
    return {
      plays,
      resolveCurrent: (result = "ended") => {
        const resolve = currentResolve;
        currentResolve = null;
        if (resolve) resolve(result);
      },
    };
  }

  function rowByMessageId(messageId: string): Element | undefined {
    return Array.from(document.querySelectorAll('[data-testid="narration-playlist-row"]')).find(
      (row) => row.getAttribute("data-playlist-message-id") === messageId,
    );
  }

  function hasRevoiceButton(messageId: string): boolean {
    return rowByMessageId(messageId)?.querySelector('[data-testid="playlist-row-revoice"]') !== null;
  }

  it("FS-6a: re-voice drops cached segments, then synthesizes every segment fresh", async () => {
    mocks.messages = [revoiceMessage("m1", FULL_TEXT), u1()];
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", FULL_TEXT, profile(), revoiceMeta("m1"));
    });
    const beforeEntry = playlistEntry("m1");
    if (!beforeEntry) throw new Error("m1 was not indexed before re-voice");
    const beforeKeys = [...beforeEntry.cacheKeys];
    expect(beforeKeys.length).toBeGreaterThan(0);
    const baselineSynthCalls = synthCalls.length;
    const deletedKeys = trackCacheDeletes();
    const { getByTestId, getByText } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("playlist-row-revoice"));
    await act(async () => { fireEvent.click(getByTestId("playlist-row-revoice")); });
    // RD-6: the button only opens the confirm — nothing is dropped yet.
    expect(getByText("narration_playlist_revoice_title")).toBeDefined();
    expect(getByText("narration_playlist_revoice_body")).toBeDefined();
    expect(synthCalls).toHaveLength(baselineSynthCalls);
    expect(deletedKeys).toHaveLength(0);
    await act(async () => { fireEvent.click(getByText("narration_playlist_revoice")); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    expect(deletedKeys.sort()).toEqual([...beforeKeys].sort());
    expect(synthCalls).toHaveLength(baselineSynthCalls + beforeKeys.length);
  });

  it("FS-6b: re-voice is offered on full and partial rows, but not the live row", async () => {
    mocks.messages = [m1(), m2(), revoiceMessage("m3", "Live one only."), u1()];
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line\nThird line", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line",
      });
    });
    const lane = parkLane();
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m2", "Second message body here", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m2-v1",
        variantIndex: 0,
        snippet: "Second message body here",
      });
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(1); });
    act(() => { useTtsPlaybackStore.getState().stopNarration(); });
    await waitFor(() => { expect(playlistEntry("m2")?.partial).toBe(true); });
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m3", "Live one only.", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m3-v1",
        variantIndex: 0,
        snippet: "Live one only.",
      });
    });
    await waitFor(() => { expect(lane.plays).toHaveLength(2); });
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => {
      expect(rowByMessageId("m1")).toBeDefined();
      expect(rowByMessageId("m2")).toBeDefined();
      expect(rowByMessageId("m3")).toBeDefined();
    });
    expect(hasRevoiceButton("m1")).toBe(true);
    expect(hasRevoiceButton("m2")).toBe(true);
    expect(hasRevoiceButton("m3")).toBe(false);
  });

  it("FS-6c: a saved library row keeps its file and does not offer re-voice", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("playlist-row-revoice"));
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));
    expect(librarySaved).toHaveLength(1);
    expect(queryByTestId("playlist-row-revoice")).toBeNull();
    expect(getByTestId("playlist-row-reveal")).toBeDefined();
    expect(getByTestId("playlist-row-drop")).toBeDefined();
    expect(libraryDeleted).toEqual([]);
    expect(libraryRevealed).toEqual([]);
    expect(en["narration_playlist_revoice"]).toBe("Re-voice");
    expect(ru["narration_playlist_revoice"]).toBe("Переозвучить");
  });

  it("RD-6a: cancelling the row confirm leaves the cache and synthesis untouched", async () => {
    mocks.messages = [revoiceMessage("m1", FULL_TEXT)];
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", FULL_TEXT, profile(), revoiceMeta("m1"));
    });
    const beforeEntry = playlistEntry("m1");
    if (!beforeEntry) throw new Error("m1 was not indexed before re-voice");
    const beforeKeys = [...beforeEntry.cacheKeys];
    expect(beforeKeys.length).toBeGreaterThan(0);
    const baselineSynthCalls = synthCalls.length;
    const { getByTestId, getByText, queryByText } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("playlist-row-revoice"));
    await act(async () => { fireEvent.click(getByTestId("playlist-row-revoice")); });
    expect(getByText("narration_playlist_revoice_title")).toBeDefined();
    expect(getByText("narration_playlist_revoice_body")).toBeDefined();
    await act(async () => { fireEvent.click(getByText("cancel")); });
    expect(queryByText("narration_playlist_revoice_title")).toBeNull();
    expect(synthCalls).toHaveLength(baselineSynthCalls);
    expect([...(playlistEntry("m1")?.cacheKeys ?? [])].sort()).toEqual([...beforeKeys].sort());
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
  });

  it("RD-6b: a partial row also confirms before re-voicing, then synthesizes fresh", async () => {
    const lane = parkLane();
    mocks.messages = [revoiceMessage("m1", FULL_TEXT)];
    const { getByTestId, getByText, queryByText } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", FULL_TEXT, profile(), revoiceMeta("m1"));
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    await act(async () => { fireEvent.click(getByTestId("playlist-stop")); });
    // The stopped lane settles as a partial cache row with a re-voice offer.
    await waitFor(() => getByTestId("playlist-row-continue"));
    await waitFor(() => getByTestId("playlist-row-revoice"));
    await act(async () => { fireEvent.click(getByTestId("playlist-row-revoice")); });
    expect(getByText("narration_playlist_revoice_title")).toBeDefined();
    const playsBefore = lane.plays.length;
    await act(async () => { fireEvent.click(getByText("narration_playlist_revoice")); });
    expect(queryByText("narration_playlist_revoice_title")).toBeNull();
    // The re-voiced chain (two fresh segments) plays through the
    // parked stub: resolve each pending play in turn.
    await waitFor(() => { expect(lane.plays.length).toBeGreaterThan(playsBefore); });
    act(() => { lane.resolveCurrent(); });
    await waitFor(() => { expect(lane.plays.length).toBeGreaterThan(playsBefore + 1); });
    act(() => { lane.resolveCurrent(); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    expect(playlistEntry("m1")?.partial).toBeFalsy();
  });
});

describe("narration playlist library (TPE-18c)", () => {
  async function narrateM1Settled(): Promise<void> {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
  }

  async function openPanel(): Promise<{ getByTestId: (id: string) => HTMLElement; queryByTestId: (id: string) => HTMLElement | null }> {
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement, queryByTestId };
  }

  it("settled row offers save; saving flips the badge and swaps the actions", async () => {
    await narrateM1Settled();
    const { getByTestId, queryByTestId } = await openPanel();

    // Pre-save: save button, no badge, no reveal/drop.
    expect(getByTestId("playlist-row-save")).toBeDefined();
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
    expect(queryByTestId("playlist-row-reveal")).toBeNull();
    expect(queryByTestId("playlist-row-drop")).toBeNull();

    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));

    // One merged ogg posted (stub bytes), hash keys evicted…
    expect(librarySaved).toHaveLength(1);
    expect(librarySaved[0]?.type).toBe("audio/ogg");
    expect(cache.size()).toBe(0);
    // …save swaps for reveal + drop, the badge stays.
    expect(queryByTestId("playlist-row-save")).toBeNull();
    expect(getByTestId("playlist-row-reveal")).toBeDefined();
    expect(getByTestId("playlist-row-drop")).toBeDefined();
  });

  it("reveal forwards the row; drop clears the badge and brings save back", async () => {
    await narrateM1Settled();
    const { getByTestId, queryByTestId } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));

    await act(async () => { fireEvent.click(getByTestId("playlist-row-reveal")); });
    expect(libraryRevealed).toEqual(["c1/b1/m1/0"]);

    await act(async () => { fireEvent.click(getByTestId("playlist-row-drop")); });
    await waitFor(() => getByTestId("playlist-row-save"));
    expect(libraryDeleted).toEqual(["c1/b1/m1/0"]);
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
    expect(queryByTestId("playlist-row-reveal")).toBeNull();
    expect(queryByTestId("playlist-row-drop")).toBeNull();
  });

  it("reveal hides on Android while drop stays (no file manager to open)", async () => {
    mocks.android = true;
    await narrateM1Settled();
    const { getByTestId, queryByTestId } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));

    expect(queryByTestId("playlist-row-reveal")).toBeNull();
    expect(getByTestId("playlist-row-drop")).toBeDefined();
  });

  it("library strings exist in en and ru", () => {
    for (const key of [
      "narration_playlist_save",
      "narration_playlist_saving",
      "narration_playlist_in_library",
      "narration_playlist_reveal_file",
      "narration_playlist_drop_file",
    ] as const) {
      expect(en[key]).toBeTruthy();
      expect(ru[key]).toBeTruthy();
    }
    expect(en["narration_playlist_save"]).not.toBe(ru["narration_playlist_save"]);
  });
});
});

describe("narration playlist continuous play (TPE-18d)", () => {
  async function seedM1WithQueue(queue: string[]): Promise<void> {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line", profile(), {
        chatId: "c1",
        chainQueue: queue,
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
  }

  async function openPanel(): Promise<{ getByTestId: (id: string) => HTMLElement }> {
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement };
  }

  it("footer toggle flips the pref and persists it across reload", async () => {
    await seedM1WithQueue(["m1"]);
    await openPanel();
    expect(useTtsPlaybackStore.getState().continuous).toBe(false);

    const toggle = document.querySelector('[aria-label="narration_playlist_continuous"]');
    expect(toggle).not.toBeNull();
    await act(async () => { fireEvent.click(toggle!); });
    expect(useTtsPlaybackStore.getState().continuous).toBe(true);
    expect(localStorage.getItem("vt.tts.continuous-play")).toBe("true");

    await act(async () => { fireEvent.click(toggle!); });
    expect(useTtsPlaybackStore.getState().continuous).toBe(false);
    expect(localStorage.getItem("vt.tts.continuous-play")).toBe("false");
  });

  it("armed advance auto-plays the next row end-to-end (owner chain scene)", async () => {
    mocks.messages = [m1(), m2()];
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      useTtsPlaybackStore.getState().setContinuous(true);
    });
    await seedM1WithQueue(["m1", "m2"]);

    // m1 completes → the panel effect starts m2 with its voiced text.
    await waitFor(() => {
      const narr = useTtsPlaybackStore.getState().narrations["m2"];
      if (!narr || narr.status !== "complete") throw new Error("m2 not complete yet");
    });
    expect(synthCalls).toContain("First line\nSecond line");
    expect(synthCalls).toContain("Second message body here");
    // Chain exhausted after the last row — nothing stays armed.
    await waitFor(() => {
      if (useTtsPlaybackStore.getState().advanceTo !== null) throw new Error("advance still armed");
    });
    expect(getByTestId("narration-playlist-pill")).toBeDefined();
  });

  it("continuous strings exist in en and ru", () => {
    for (const key of ["narration_playlist_continuous", "narration_playlist_continuous_hint"] as const) {
      expect(en[key]).toBeTruthy();
      expect(ru[key]).toBeTruthy();
    }
    expect(en["narration_playlist_continuous"]).not.toBe(ru["narration_playlist_continuous"]);
  });
});

describe("narration playlist cache badge (FS-7)", () => {
  const TEXT = "First line\nSecond line";

  function meta() {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: "m1-v1",
      variantIndex: 0,
      snippet: TEXT,
    };
  }

  /** Parked player lane (single segment) — the panel shows a live row
   *  while the play promise is unresolved. */
  function parkLane(): { plays: string[]; skip: () => void } {
    const plays: string[] = [];
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(blob: Blob, _rate: number): Promise<"ended" | "skipped" | "error"> {
          void blob.text().then((t) => plays.push(t));
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
      libraryClient: stubLibraryClient(),
      mergeToOgg: async () => new Uint8Array([9, 9]),
    });
    return {
      plays,
      skip: () => {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn("skipped");
      },
    };
  }

  async function openPanel(): Promise<{ getByTestId: (id: string) => HTMLElement; queryByTestId: (id: string) => HTMLElement | null }> {
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement, queryByTestId };
  }

  it("FS-7a: settled cache-only row shows «В кэше», not «В библиотеке»", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const { getByTestId, queryByTestId } = await openPanel();
    const badge = getByTestId("playlist-row-cache-badge");
    expect(badge.textContent).toBe("narration_playlist_in_cache");
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
  });

  it("FS-7b: partial row shows «В кэше»", async () => {
    parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    await act(async () => { fireEvent.click(getByTestId("playlist-stop")); });
    await waitFor(() => getByTestId("playlist-row-continue"));
    expect(getByTestId("playlist-row-cache-badge")).toBeDefined();
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
  });

  it("FS-7c: library row shows ONLY «В библиотеке»", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const { getByTestId, queryByTestId } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));
    expect(queryByTestId("playlist-row-cache-badge")).toBeNull();
  });

  it("FS-7d: live row shows neither badge", async () => {
    parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    expect(queryByTestId("playlist-row-cache-badge")).toBeNull();
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
  });

  it("FS-7e: cache badge strings exist in en and ru", () => {
    expect(en["narration_playlist_in_cache"]).toBeTruthy();
    expect(ru["narration_playlist_in_cache"]).toBeTruthy();
    expect(en["narration_playlist_in_cache"]).not.toBe(ru["narration_playlist_in_cache"]);
  });
});

describe("narration playlist card layout (RD-1)", () => {
  const TEXT = "First line\nSecond line\nThird line";

  function meta() {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: "m1-v1",
      variantIndex: 0,
      snippet: "First line\nSecond line",
    };
  }

  /** Deferred single-segment lane — the panel shows a live row while
   *  the play promise is unresolved (same shape as the FS-7 helper). */
  function parkLane(): void {
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(): Promise<"ended" | "skipped" | "error"> {
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
    });
  }

  async function openPanel(): Promise<{
    getByTestId: (id: string) => HTMLElement;
    queryByTestId: (id: string) => HTMLElement | null;
  }> {
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement, queryByTestId };
  }

  function zone(container: HTMLElement, zoneId: string): HTMLElement {
    const el = container.querySelector(`[data-testid="${zoneId}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`missing zone ${zoneId}`);
    return el;
  }

  it("RD-1a: settled cache-only card — head, chunk, controls; no playback zone", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const { getByTestId, queryByTestId } = await openPanel();
    const row = getByTestId("narration-playlist-row");
    const head = zone(row, "playlist-row-zone-head");
    const chunk = zone(row, "playlist-row-zone-chunk");
    const controls = zone(row, "playlist-row-zone-controls");
    expect(queryByTestId("playlist-row-zone-playback")).toBeNull();
    // Head: the two-line snippet clamps, the magnifier docks right.
    const snippet = head.querySelector("p");
    expect(snippet?.getAttribute("class") ?? "").toContain("line-clamp-2");
    expect(snippet?.textContent).toContain("First line");
    expect(head.querySelector('[data-testid="playlist-row-show"]')).not.toBeNull();
    // Chunk line: swipe label + cache badge.
    expect(chunk.textContent).toContain("narration_playlist_swipe:1:1:");
    expect(chunk.querySelector('[data-testid="playlist-row-cache-badge"]')).not.toBeNull();
    expect(chunk.querySelector('[data-testid="playlist-row-library-badge"]')).toBeNull();
    // Control panel: play + save + re-voice (FS-6), no continue.
    expect(controls.querySelector('[data-testid="playlist-row-play"]')).not.toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-save"]')).not.toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-revoice"]')).not.toBeNull();
    expect(queryByTestId("playlist-row-continue")).toBeNull();
  });

  it("RD-1b: live card carries all four zones — fetch on chunk, seek on playback", async () => {
    parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", "Para one.\n\nPara two.", profile(), meta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    const row = await waitFor(() => getByTestId("narration-playlist-row"));
    const head = zone(row, "playlist-row-zone-head");
    const chunk = zone(row, "playlist-row-zone-chunk");
    const controls = zone(row, "playlist-row-zone-controls");
    const playback = zone(row, "playlist-row-zone-playback");
    // Fetch progress lives on the chunk line (eventual: segments land async).
    await waitFor(() => {
      expect(zone(getByTestId("narration-playlist-row"), "playlist-row-zone-chunk").textContent).toContain(
        "narration_playlist_fetching:",
      );
    });
    expect(chunk.textContent).toContain("narration_playlist_swipe:1:1:");
    // Playback zone: the full-width seek control + clock, no badges.
    expect(playback.querySelector('[data-testid="playlist-seek"]')).not.toBeNull();
    expect(queryByTestId("playlist-row-cache-badge")).toBeNull();
    expect(queryByTestId("playlist-row-library-badge")).toBeNull();
    // Head + controls keep their controls.
    expect(head.querySelector('[data-testid="playlist-row-show"]')).not.toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-play"]')).not.toBeNull();
  });

  it("RD-1c: partial card — continue + cache-drop in the control panel, no save", async () => {
    parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    await act(async () => { fireEvent.click(getByTestId("playlist-stop")); });
    const row = await waitFor(() => getByTestId("narration-playlist-row"));
    const controls = zone(row, "playlist-row-zone-controls");
    expect(zone(row, "playlist-row-zone-head")).toBeDefined();
    expect(zone(row, "playlist-row-zone-chunk")).toBeDefined();
    expect(queryByTestId("playlist-row-zone-playback")).toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-continue"]')).not.toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-drop-cache"]')).not.toBeNull();
    expect(queryByTestId("playlist-row-save")).toBeNull();
  });

  it("RD-1d: library card — library badge on chunk, reveal + drop in controls", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const { getByTestId, queryByTestId } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));
    const row = getByTestId("narration-playlist-row");
    const chunk = zone(row, "playlist-row-zone-chunk");
    const controls = zone(row, "playlist-row-zone-controls");
    expect(chunk.querySelector('[data-testid="playlist-row-library-badge"]')).not.toBeNull();
    expect(chunk.querySelector('[data-testid="playlist-row-cache-badge"]')).toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-reveal"]')).not.toBeNull();
    expect(controls.querySelector('[data-testid="playlist-row-drop"]')).not.toBeNull();
    expect(queryByTestId("playlist-row-revoice")).toBeNull();
    expect(queryByTestId("playlist-row-zone-playback")).toBeNull();
  });
});

describe("narration playlist row play/pause toggle (RD-2)", () => {
  const TEXT = "First line\nSecond line\nThird line";

  function meta() {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: "m1-v1",
      variantIndex: 0,
      snippet: "First line\nSecond line",
    };
  }

  /** Parked single-segment lane with pause/resume spies — the panel
   *  shows a live row while the play promise is unresolved. */
  function parkLane(): { pauseCalls: string[]; plays: number; finish: () => void; index: NarrationPlaylistIndex } {
    const pauseCalls: string[] = [];
    const index = memoryIndex();
    let plays = 0;
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(): Promise<"ended" | "skipped" | "error"> {
          plays += 1;
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => { pauseCalls.push("pause"); },
        resume: () => { pauseCalls.push("resume"); },
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: index,
      notifyError: () => {},
    });
    return {
      pauseCalls,
      index,
      get plays() { return plays; },
      finish: () => {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn("ended");
      },
    };
  }

  async function openPanel(): Promise<{
    getByTestId: (id: string) => HTMLElement;
    queryByTestId: (id: string) => HTMLElement | null;
  }> {
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement, queryByTestId };
  }

  function rowPlay(row: HTMLElement): HTMLElement {
    const button = row.querySelector('[data-testid="playlist-row-play"]');
    if (!(button instanceof HTMLElement)) throw new Error("missing playlist-row-play");
    return button;
  }

  it("RD-2a: playing row shows pause — clicking it parks the lane", async () => {
    const lane = parkLane();
    // Do NOT await the narration inside act — the parked play holds it.
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    const { getByTestId } = await openPanel();
    const button = rowPlay(getByTestId("narration-playlist-row"));
    expect(button.getAttribute("aria-label")).toContain("narration_playlist_pause");
    await act(async () => { fireEvent.click(button); });
    expect(lane.pauseCalls).toEqual(["pause"]);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");
  });

  it("RD-2b: parked row shows play again — clicking it resumes without re-synthesis", async () => {
    const lane = parkLane();
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    const { getByTestId } = await openPanel();
    await act(async () => { fireEvent.click(rowPlay(getByTestId("narration-playlist-row"))); });
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");
    // The parked row offers resume (not a restart).
    const button = rowPlay(getByTestId("narration-playlist-row"));
    expect(button.getAttribute("aria-label")).toContain("narration_playlist_resume");
    const playsBefore = lane.plays;
    await act(async () => { fireEvent.click(button); });
    expect(lane.pauseCalls).toEqual(["pause", "resume"]);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    // Resume continues the parked segment — no new synthesis, no new play.
    expect(synthCalls).toHaveLength(1);
    expect(lane.plays).toBe(playsBefore);
    expect(rowPlay(getByTestId("narration-playlist-row")).getAttribute("aria-label")).toContain(
      "narration_playlist_pause",
    );
  });

  it("RD-2c: settled row keeps the play action — clicking replays from cache", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    const { getByTestId } = await openPanel();
    const button = rowPlay(getByTestId("narration-playlist-row"));
    expect(button.getAttribute("aria-label")).toContain("narrate_action");
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    // The replay resolved through the segment cache — no second synthesis.
    expect(synthCalls).toHaveLength(1);
  });

  it("RD-2d: lane state for another row does not flip this row's icon", async () => {
    mocks.messages = [m1(), m2()];
    const lane = parkLane();
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    // Seed m2 as a settled cache row in the SAME index the lane reads —
    // a dep swap would wipe it, so the entry lands directly, then the
    // panel reloads the chat's rows from the index.
    await act(async () => {
      await lane.index.upsert("c1", {
        messageId: "m2",
        variantId: "m2-v1",
        variantIndex: 0,
        snippet: "Second message body here",
        cacheKeys: [],
        narratedAt: Date.now(),
      });
      await useTtsPlaybackStore.getState().loadPlaylist("c1");
    });
    // openPanel() asserts a single row — with two rows, open inline.
    render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => document.querySelector('[data-testid="narration-playlist-pill"]'));
    if (!(pill instanceof HTMLElement)) throw new Error("missing pill");
    await act(async () => { fireEvent.click(pill); });
    // Live rows sort first: m1 (pause) then the settled m2 (play).
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-testid="narration-playlist-row"]')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows).toHaveLength(2);
    expect(rowPlay(rows[0] as HTMLElement).getAttribute("aria-label")).toContain("narration_playlist_pause");
    expect(rowPlay(rows[1] as HTMLElement).getAttribute("aria-label")).toContain("narrate_action");
  });
});

describe("narration playlist row stop (RD-3)", () => {
  const TEXT = "First line\nSecond line\nThird line";

  function meta() {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId: "m1-v1",
      variantIndex: 0,
      snippet: "First line\nSecond line",
    };
  }

  /** Parked single-segment lane — the panel shows a live row while the
   *  play promise is unresolved (same shape as the RD-2 helper). */
  function parkLane(): { pauseCalls: string[]; plays: number; index: NarrationPlaylistIndex } {
    const pauseCalls: string[] = [];
    const index = memoryIndex();
    let plays = 0;
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(): Promise<"ended" | "skipped" | "error"> {
          plays += 1;
          return new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          });
        },
        skipCurrent: () => {
          const fn = currentResolve;
          currentResolve = null;
          if (fn) fn("skipped");
        },
        pause: () => { pauseCalls.push("pause"); },
        resume: () => { pauseCalls.push("resume"); },
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: index,
      notifyError: () => {},
    });
    return { pauseCalls, index, get plays() { return plays; } };
  }

  async function openPanel(): Promise<{
    getByTestId: (id: string) => HTMLElement;
    queryByTestId: (id: string) => HTMLElement | null;
  }> {
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    return { getByTestId: getByTestId as (id: string) => HTMLElement, queryByTestId };
  }

  function rowStop(row: HTMLElement): HTMLElement | null {
    const button = row.querySelector('[data-testid="playlist-row-stop"]');
    return button instanceof HTMLElement ? button : null;
  }

  it("RD-3b: settled row renders no row stop", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    const { getByTestId, queryByTestId } = await openPanel();
    expect(rowStop(getByTestId("narration-playlist-row"))).toBeNull();
    expect(queryByTestId("playlist-row-stop")).toBeNull();
  });

  it("RD-3c: paused row keeps the stop — it still aborts the parked lane", async () => {
    parkLane();
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    const { getByTestId } = await openPanel();
    // Park the lane first (RD-2 row-pause path).
    await act(async () => { fireEvent.click(getByTestId("playlist-row-play")); });
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");
    const stop = rowStop(getByTestId("narration-playlist-row"));
    expect(stop).not.toBeNull();
    await act(async () => { fireEvent.click(stop as HTMLElement); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().lastStarted).toBeNull();
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
  });

  it("RD-3d: partial row renders no row stop", async () => {
    parkLane();
    const { getByTestId, queryByTestId } = render(<NarrationPlaylistPanel docked />);
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    await waitFor(() => getByTestId("narration-playlist-row"));
    // Abort through the footer stop — the lane lands as a partial row.
    await act(async () => { fireEvent.click(getByTestId("playlist-stop")); });
    await waitFor(() => getByTestId("playlist-row-continue"));
    expect(rowStop(getByTestId("narration-playlist-row"))).toBeNull();
    expect(queryByTestId("playlist-row-stop")).toBeNull();
  });

  it("RD-3e: library row renders no row stop", async () => {
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    const { getByTestId, queryByTestId } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-row-save")); });
    await waitFor(() => getByTestId("playlist-row-library-badge"));
    expect(rowStop(getByTestId("narration-playlist-row"))).toBeNull();
    expect(queryByTestId("playlist-row-stop")).toBeNull();
  });

  it("RD-3f: only the live row offers a stop — the settled sibling has none", async () => {
    mocks.messages = [m1(), m2()];
    const lane = parkLane();
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", TEXT, profile(), meta());
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    await act(async () => {
      await lane.index.upsert("c1", {
        messageId: "m2",
        variantId: "m2-v1",
        variantIndex: 0,
        snippet: "Second message body here",
        cacheKeys: [],
        narratedAt: Date.now(),
      });
      await useTtsPlaybackStore.getState().loadPlaylist("c1");
    });
    render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => document.querySelector('[data-testid="narration-playlist-pill"]'));
    if (!(pill instanceof HTMLElement)) throw new Error("missing pill");
    await act(async () => { fireEvent.click(pill); });
    // Live rows sort first: m1 (stop) then the settled m2 (no stop).
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-testid="narration-playlist-row"]')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rowStop(rows[0] as HTMLElement)).not.toBeNull();
    expect(rowStop(rows[1] as HTMLElement)).toBeNull();
  });
});

describe("narration playlist transport bar (RD-5)", () => {
  function metaFor(variantId: string, snippet: string) {
    return {
      chatId: "c1",
      characterId: "char1",
      branchId: "b1",
      variantId,
      variantIndex: 0,
      snippet,
    };
  }

  async function openPanel(): Promise<{
    getByTestId: (id: string) => HTMLElement;
    queryByTestId: (id: string) => HTMLElement | null;
    queryByText: (text: string) => HTMLElement | null;
    getByText: (text: string) => HTMLElement;
  }> {
    const queries = render(<NarrationPlaylistPanel docked />);
    const pill = await waitFor(() => queries.getByTestId("narration-playlist-pill"));
    await act(async () => { fireEvent.click(pill); });
    // Bulk tests always render several rows — wait for at least one
    // (getByTestId demands exactly one and throws on multiples).
    await waitFor(() => {
      const found = document.querySelectorAll('[data-testid="narration-playlist-row"]');
      expect(found.length).toBeGreaterThan(0);
    });
    return {
      getByTestId: queries.getByTestId as (id: string) => HTMLElement,
      queryByTestId: queries.queryByTestId,
      queryByText: queries.queryByText as (text: string) => HTMLElement | null,
      getByText: queries.getByText as (text: string) => HTMLElement,
    };
  }

  async function settleTwo(): Promise<void> {
    mocks.messages = [m1(), m2()];
    await act(async () => {
      const store = useTtsPlaybackStore.getState();
      await store.startNarration("m1", "Alpha one.", profile(), metaFor("m1-v1", "Alpha one."));
      await store.startNarration("m2", "Beta two.", profile(), metaFor("m2-v1", "Beta two."));
    });
    expect(synthCalls).toHaveLength(2);
  }

  it("RD-5a: save-all writes every complete row to the library, no confirm in between", async () => {
    await settleTwo();
    const { getByTestId, queryByText } = await openPanel();
    expect(librarySaved).toHaveLength(0);
    await act(async () => { fireEvent.click(getByTestId("playlist-save-all")); });
    // Both complete rows saved via the existing per-row path; the bulk
    // action itself never asks (non-destructive, owner decision).
    await waitFor(() => { expect(librarySaved).toHaveLength(2); });
    expect(queryByText("narration_playlist_revoice_all_title")).toBeNull();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="playlist-row-library-badge"]')).toHaveLength(2);
    });
  });

  it("RD-5b: save-all skips partial rows (no whole-track file exists)", async () => {
    // m1 narrated for real (genuine cached segments); the result is
    // transplanted into a fresh index next to a seeded partial m2
    // (RD-3f pattern — the filter reads flags, not history).
    mocks.messages = [m1(), m2()];
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "Alpha one.", profile(), metaFor("m1-v1", "Alpha one."));
    });
    const settledM1 = useTtsPlaybackStore.getState().playlist["c1"]?.find((entry) => entry.messageId === "m1");
    if (!settledM1) throw new Error("m1 did not settle");
    const index = memoryIndex();
    __setTtsPlaybackDepsForTests({
      player: autoPlayer(),
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: index,
      notifyError: () => {},
    });
    await act(async () => {
      await index.upsert("c1", settledM1);
      await index.upsert("c1", {
        messageId: "m2",
        variantId: "m2-v1",
        variantIndex: 0,
        snippet: "Beta two.",
        cacheKeys: [],
        narratedAt: Date.now(),
        partial: true,
      });
      await useTtsPlaybackStore.getState().loadPlaylist("c1");
    });
    const { getByTestId } = await openPanel();
    expect(getByTestId("playlist-row-continue")).toBeDefined();
    await act(async () => { fireEvent.click(getByTestId("playlist-save-all")); });
    await waitFor(() => { expect(librarySaved).toHaveLength(1); });
    // Only m1 settled to a library badge; the partial keeps continue.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="playlist-row-library-badge"]')).toHaveLength(1);
    });
    expect(getByTestId("playlist-row-continue")).toBeDefined();
  });

  it("RD-5c: save-all skips library rows; re-voice-all counts only cache rows", async () => {
    mocks.messages = [m1(), m2()];
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "Alpha one.", profile(), metaFor("m1-v1", "Alpha one."));
    });
    const settledM1 = useTtsPlaybackStore.getState().playlist["c1"]?.find((entry) => entry.messageId === "m1");
    if (!settledM1) throw new Error("m1 did not settle");
    // Transplant the genuine m1 entry next to a seeded library m2
    // (RD-3f pattern) BEFORE opening — post-open state writes do not
    // survive the panel's own derivations.
    const index = memoryIndex();
    __setTtsPlaybackDepsForTests({
      player: autoPlayer(),
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: index,
      notifyError: () => {},
      libraryClient: stubLibraryClient(),
    });
    await act(async () => {
      await index.upsert("c1", settledM1);
      await index.upsert("c1", {
        messageId: "m2",
        variantId: "m2-v1",
        variantIndex: 0,
        snippet: "Second message body here",
        cacheKeys: [],
        narratedAt: Date.now(),
        inLibrary: true,
      });
      // The mount-time reconcile checks the server for the file — the
      // stub must actually hold m2's recording or the flag heals to false.
      libraryFiles.set("c1/b1/m2/0", new Blob(["saved-m2"]));
      await useTtsPlaybackStore.getState().loadPlaylist("c1");
    });
    const { getByTestId, getByText } = await openPanel();
    // The bulk re-voice offer covers the single cache row (m1): the
    // modal body carries count 1, never 2. Checked BEFORE save-all —
    // saving m1 would leave zero cache rows and disable the button.
    await act(async () => { fireEvent.click(getByTestId("playlist-revoice-all")); });
    expect(getByText("narration_playlist_revoice_all_title")).toBeDefined();
    expect(getByText("narration_playlist_revoice_all_body:1:")).toBeDefined();
    await act(async () => { fireEvent.click(getByText("cancel")); });
    await act(async () => { fireEvent.click(getByTestId("playlist-save-all")); });
    await waitFor(() => { expect(librarySaved).toHaveLength(1); });
  });

  it("RD-5d: re-voice-all confirms, then drops every cache and re-narrates the whole set", async () => {
    await settleTwo();
    expect(cache.size()).toBeGreaterThan(0);
    const { getByTestId, getByText } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-revoice-all")); });
    expect(getByText("narration_playlist_revoice_all_title")).toBeDefined();
    await act(async () => { fireEvent.click(getByText("narration_playlist_revoice_all_confirm")); });
    // The chain needs Continuous on — the bulk flow enables it (the
    // modal copy says so), then both tracks synthesize fresh.
    await waitFor(() => { expect(useTtsPlaybackStore.getState().continuous).toBe(true); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
      expect(useTtsPlaybackStore.getState().narrations["m2"]?.status).toBe("complete");
    });
    expect(synthCalls).toHaveLength(4);
  });

  it("RD-5e: cancelling re-voice-all leaves caches, synthesis and prefs intact", async () => {
    await settleTwo();
    const sizeBefore = cache.size();
    expect(sizeBefore).toBeGreaterThan(0);
    const { getByTestId, getByText, queryByText } = await openPanel();
    await act(async () => { fireEvent.click(getByTestId("playlist-revoice-all")); });
    expect(getByText("narration_playlist_revoice_all_title")).toBeDefined();
    await act(async () => { fireEvent.click(getByText("cancel")); });
    expect(queryByText("narration_playlist_revoice_all_title")).toBeNull();
    expect(synthCalls).toHaveLength(2);
    expect(cache.size()).toBe(sizeBefore);
    expect(useTtsPlaybackStore.getState().continuous).toBe(false);
  });

  it("RD-5f: idle bar-play starts the first card; while playing it offers pause", async () => {
    // Parked lane: the bar start is observable as a live m1 row served
    // from cache (zero new synthesis — a replay, not a re-voice).
    mocks.messages = [m1(), m2()];
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        play(): Promise<"ended" | "skipped" | "error"> {
          return new Promise<"ended" | "skipped" | "error">((resolve) => { currentResolve = resolve; });
        },
        skipCurrent: () => {},
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
      libraryClient: stubLibraryClient(),
      mergeToOgg: async () => new Uint8Array([9, 9]),
    });
    // Seed both rows settled (synth + cache). Never await a parked
    // start inside act — the play promise resolves only below.
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", "Alpha one.", profile(), metaFor("m1-v1", "Alpha one."));
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    await act(async () => { currentResolve?.("ended"); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
    });
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m2", "Beta two.", profile(), metaFor("m2-v1", "Beta two."));
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m2"]?.status).toBe("playing");
    });
    await act(async () => { currentResolve?.("ended"); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m2"]?.status).toBe("complete");
    });
    const synthBaseline = synthCalls.length;
    const { getByTestId } = await openPanel();
    // Idle lane: bar-play offers the playlist start, then starts m1
    // (the first card). The start replays the message's CURRENT variant
    // text — not the seeded snippet — so it synthesizes the variant
    // (cache miss by design); the asserted text proves WHICH card won.
    expect(getByTestId("playlist-bar-play").getAttribute("aria-label")).toContain("narration_playlist_bar_play");
    await act(async () => { fireEvent.click(getByTestId("playlist-bar-play")); });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("playing");
    });
    expect(synthCalls).toHaveLength(synthBaseline + 1);
    expect(synthCalls[synthBaseline]).toBe("First line\nSecond line\nThird line");
    // While the lane plays, the same button offers pause.
    expect(getByTestId("playlist-bar-play").getAttribute("aria-label")).toContain("narration_playlist_pause");
    await act(async () => { currentResolve?.("ended"); });
  });

  it("RD-5g: re-voice-all stays disabled while the lane is live; save-all stays available", async () => {
    mocks.messages = [m1(), m2()];
    // Own index (RD-3f pattern): m1 seeded settled, m2 started live on
    // a parked player — swapping the index after a narrated settle
    // would drop the settled entry, so the settle is seeded, not played.
    const index = memoryIndex();
    __setTtsPlaybackDepsForTests({
      player: {
        play(): Promise<"ended" | "skipped" | "error"> {
          return new Promise<"ended" | "skipped" | "error">(() => {});
        },
        skipCurrent: () => {},
        pause: () => {},
        resume: () => {},
        setRate: () => {},
        setVolume: () => {},
        dispose: () => {},
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: index,
      notifyError: () => {},
    });
    await act(async () => {
      await index.upsert("c1", {
        messageId: "m1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "Alpha one.",
        cacheKeys: [],
        narratedAt: Date.now(),
      });
      await useTtsPlaybackStore.getState().loadPlaylist("c1");
      void useTtsPlaybackStore.getState().startNarration("m2", "Beta two.", profile(), metaFor("m2-v1", "Beta two."));
    });
    await waitFor(() => {
      expect(useTtsPlaybackStore.getState().narrations["m2"]?.status).toBe("playing");
    });
    const { getByTestId } = await openPanel();
    // A destructive bulk drop must not race the live lane (same
    // settled-only rule as row re-voice); saving is per-row
    // independent and stays available.
    expect(getByTestId("playlist-revoice-all").getAttribute("disabled")).not.toBeNull();
    expect(getByTestId("playlist-save-all").getAttribute("disabled")).toBeNull();
  });

  it("RD-5h: empty playlist — bar-play, save-all and re-voice-all all disabled", async () => {
    const { NarrationPlaylist } = await import("./NarrationPlaylist.js");
    const noop = () => {};
    const { getByTestId } = render(
      <NarrationPlaylist
        messages={[]}
        entries={[]}
        narrations={{}}
        liveTextById={() => null}
        rate={1}
        anyLive={false}
        livePaused={false}
        progress={{}}
        volume={1}
        continuous={false}
        onContinuous={noop}
        onPlay={noop}
        onStop={noop}
        onCycleRate={noop}
        onPause={noop}
        onResume={noop}
        onBarPlay={noop}
        onSeek={noop}
        onVolume={noop}
        onSave={noop}
        onReveal={noop}
        onDrop={noop}
        onDropCache={noop}
        onRevoice={noop}
        onSaveAll={noop}
        onRevoiceAll={noop}
        scrollToMessageId={null}
        onScrollToMessageDone={noop}
        savingIds={new Set()}
        canReveal={true}
        showTitle={false}
      />,
    );
    expect(getByTestId("playlist-bar-play").getAttribute("disabled")).not.toBeNull();
    expect(getByTestId("playlist-save-all").getAttribute("disabled")).not.toBeNull();
    expect(getByTestId("playlist-revoice-all").getAttribute("disabled")).not.toBeNull();
  });
});

describe("narration playlist advance auto-scroll (RD-7)", () => {
  /** Prototype-level scrollIntoView stub (happy-dom has no scroll
   *  implementation): records the scrolled element per call. Restored
   *  per test — the show-in-chat test above stubs per element instead,
   *  but the advance edge fires from a store effect, so the call site
   *  cannot be reached to stub the instance first. */
  function stubCardScrolling(): { calls: Element[]; restore: () => void } {
    const calls: Element[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (options?: unknown) => void };
    const prev = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element): void {
      calls.push(this);
    };
    return {
      calls,
      restore: () => {
        if (prev === undefined) delete proto.scrollIntoView;
        else proto.scrollIntoView = prev;
      },
    };
  }

  /** Minimal deferred player (mirrors the RD-5 helper without coupling
   *  across describe blocks): parks the current play until released. */
  function installParkedLane(): { release: (result?: "ended" | "skipped" | "error") => void } {
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    __setTtsPlaybackDepsForTests({
      player: {
        ...autoPlayer(),
        play: () =>
          new Promise<"ended" | "skipped" | "error">((resolve) => {
            currentResolve = resolve;
          }),
      },
      synthesize: mock(async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
      }),
      cache,
      playlistIndex: memoryIndex(),
      notifyError: () => {},
      libraryClient: stubLibraryClient(),
      mergeToOgg: async () => new Uint8Array([9, 9]),
    });
    return {
      release: (result = "ended") => {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn(result);
      },
    };
  }

  function scrolledMessageIds(calls: Element[]): string[] {
    return calls
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .map((el) => el.getAttribute("data-playlist-message-id"))
      .filter((id): id is string => id !== null);
  }

  it("continuous advance scrolls the newly started card into view — and never the manually started one", async () => {
    mocks.messages = [m1(), m2()];
    const { getByTestId } = render(<NarrationPlaylistPanel docked />);
    await act(async () => {
      useTtsPlaybackStore.getState().setContinuous(true);
    });
    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line", profile(), {
        chatId: "c1",
        chainQueue: ["m1", "m2"],
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "First line\nSecond line",
      });
    });
    const scrolling = stubCardScrolling();
    try {
      const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
      await act(async () => {
        fireEvent.click(pill);
      });
      // The list is the panel's own overflow container (the RD-7 seam).
      await waitFor(() => getByTestId("playlist-row-list"));
      // m1 completes → the advance edge starts m2 and owes exactly one
      // scroll: the m2 card. The target persists until the card lands,
      // so opening the panel late still scrolls deterministically.
      await waitFor(() => {
        if (!scrolledMessageIds(scrolling.calls).includes("m2")) throw new Error("m2 card not scrolled yet");
      });
      const ids = scrolledMessageIds(scrolling.calls);
      expect(ids).toContain("m2");
      // m1 was started manually (direct startNarration, no advance edge)
      // — its own start must never owe a scroll.
      expect(ids).not.toContain("m1");
      // Container-scoped: every scrolled card lives inside the list.
      const list = getByTestId("playlist-row-list");
      for (const el of scrolling.calls) {
        expect(list.contains(el)).toBe(true);
      }
    } finally {
      scrolling.restore();
    }
  });

  it("parked lane never scrolls: progress pokes and re-renders leave the view alone", async () => {
    const lane = installParkedLane();
    const { getByTestId, rerender } = render(<NarrationPlaylistPanel docked />);
    // Park m1 mid-play (deferred play never resolves on its own).
    act(() => {
      void useTtsPlaybackStore.getState().startNarration("m1", "Para one.", profile(), {
        chatId: "c1",
        characterId: "char1",
        branchId: "b1",
        variantId: "m1-v1",
        variantIndex: 0,
        snippet: "Para one.",
      });
    });
    await waitFor(() => {
      if (useTtsPlaybackStore.getState().narrations["m1"]?.status !== "playing") {
        throw new Error("m1 not playing yet");
      }
    });
    const pill = await waitFor(() => getByTestId("narration-playlist-pill"));
    await act(async () => {
      fireEvent.click(pill);
    });
    await waitFor(() => getByTestId("playlist-row-list"));
    // Park the lane via the bar play-pause (continuous stays ON — the
    // stronger case: even with the pref on, a parked lane owes nothing).
    await act(async () => {
      useTtsPlaybackStore.getState().setContinuous(true);
    });
    await act(async () => {
      fireEvent.click(getByTestId("playlist-bar-play"));
    });
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");
    const scrolling = stubCardScrolling();
    try {
      // Same-message progress + a re-render: no advance edge, no scroll.
      await act(async () => {
        useTtsPlaybackStore.setState({
          progress: { m1: { positionSec: 4, totalSec: 10, currentIndex: 0, segmentCount: 1, durations: [10] } },
        });
      });
      rerender(<NarrationPlaylistPanel docked />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();
      expect(scrolling.calls).toHaveLength(0);
    } finally {
      scrolling.restore();
      await act(async () => {
        lane.release();
      });
    }
  });
});
