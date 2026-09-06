import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import type { AppMessage } from "../../api/types.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import type { NarrationPlayer } from "../../lib/tts/narration-player.js";
import type { NarrationPlaylistEntry, NarrationPlaylistIndex, NarrationSegmentCache } from "../../lib/tts/narration-cache.js";
import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "../../stores/tts-playback-store.js";
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

beforeEach(() => {
  mocks.chatId = "c1";
  mocks.branchId = "b1";
  mocks.mobile = false;
  mocks.messages = [m1(), u1()];
  synthCalls = [];
  cache = memoryCache();
  // TPE-18b: reset the player-layer keys too (volume rehydrates from
  // localStorage at creation and would otherwise leak between tests).
  localStorage.clear();
  useTtsPlaybackStore.setState({ narrations: {}, playlist: {}, lastStarted: null, rate: 1, autoNarrate: false, volume: 1, progress: {} });
  __setTtsPlaybackDepsForTests({
    player: autoPlayer(),
    synthesize: mock(async (text: string) => {
      synthCalls.push(text);
      return { blob: new Blob([`audio:${text}`]), mime: "audio/wav" };
    }),
    cache,
    playlistIndex: memoryIndex(),
    notifyError: () => {},
  });
});

describe("narration playlist panel (TPE-18a)", () => {
  it("pill stays hidden with an empty playlist and opens after a narration lands in the index", async () => {
    const { queryByTestId, getByTestId } = render(<NarrationPlaylistPanel docked />);
    expect(queryByTestId("narration-playlist-pill")).toBeNull();

    await act(async () => {
      await useTtsPlaybackStore.getState().startNarration("m1", "First line\nSecond line\nThird line", profile(), {
        chatId: "c1",
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
        chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
      });
      await store.startNarration("m2", "Second message body here", profile(), {
        chatId: "c1", variantId: "m2-v1", variantIndex: 0, snippet: "Second message body here",
      });
      await store.startNarration("u1", "user words", profile(), {
        chatId: "c1", variantId: "u1-v1", variantIndex: 0, snippet: "user words",
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
        chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
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
        chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
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
        chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
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
        chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "First line",
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
    return { chatId: "c1", variantId: "m1-v1", variantIndex: 0, snippet: "Para one." };
  }

  it("pause freezes the live lane and resume continues it (footer toggle)", async () => {
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

    const pause = getByTestId("playlist-pause");
    expect(pause.getAttribute("aria-label")).toContain("narration_playlist_pause");
    await act(async () => { fireEvent.click(pause); });
    expect(lane.pauseCalls).toEqual(["pause"]);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("paused");

    // The toggle now offers resume; the parked segment does not advance.
    expect(getByTestId("playlist-pause").getAttribute("aria-label")).toContain("narration_playlist_resume");
    await act(async () => { fireEvent.click(getByTestId("playlist-pause")); });
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

  it("volume slider persists globally and reaches the lane player", async () => {
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

  it("formats the seek clock as m:ss", async () => {
    const { formatPlaybackTime } = await import("./NarrationPlaylist.js");
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(5)).toBe("0:05");
    expect(formatPlaybackTime(65)).toBe("1:05");
    expect(formatPlaybackTime(600)).toBe("10:00");
  });
});
});
