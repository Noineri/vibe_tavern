import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();
const { act, render } = await import("@testing-library/react");

/**
 * RX-13 display seam (REGEX_EXTENSION_PLAN Wave 3): display-affecting regex
 * presets transform the RENDERED message text without mutating the chat store.
 *
 * Pins:
 *   - display-mode (markdownOnly) preset: rendered text transformed;
 *   - prompt-only preset: render UNCHANGED (prompt seam only — the mode
 *     isolation matrix at the display boundary);
 *   - persist preset: render UNCHANGED (its transform already lives in the
 *     stored text — transforming again would double-apply);
 *   - the STORE content is never written (read back after render);
 *   - fetch failure degrades silently (render unchanged, no crash).
 *
 * Harness mirrors message-block-isolation.test.ts: real MessageBlock mounted,
 * heavy out-of-graph modules mocked at the boundary; the regex API module is
 * mocked with the SAFE pattern (capture real exports, spread, override one).
 */

const NOOP = () => {};
const STABLE_CONTROLLER = {
  handleSend: async () => {},
  handleCancelGeneration: NOOP,
  handleSwitchChat: async () => {},
  handleStartEdit: NOOP,
  handleCancelEdit: NOOP,
  handleSaveMessageEdit: async () => {},
  handleDeleteMessage: async () => {},
  handleDeleteVariant: async () => {},
  handleRegenerateMessage: async () => {},
  handleSelectMessageVariant: async () => {},
  handleResend: async () => {},
  handleFork: async () => {},
  handleActivateBranch: async () => {},
  handleDeleteActiveBranch: async () => {},
  handleRenameBranch: async () => {},
};

const realChatController = await import("../../hooks/use-chat-controller.js");
const realI18nContext = await import("../../i18n/context.js");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realTooltip = await import("../shared/Tooltip.js");
const realFramerMotion = await import("framer-motion");
const realRegexApi = await import("../../api/regex-api.js");

mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

mock.module("../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  getSceneStatusAction: () => Promise.resolve({ generating: false, record: null }),
  generateSceneAction: () => Promise.resolve({}),
  editSceneAction: () => Promise.resolve({}),
  deleteSceneAction: () => Promise.resolve({}),
  cancelSceneAction: () => Promise.resolve(),
  previewSceneAction: () => Promise.resolve({}),
}));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("framer-motion", () => ({
  ...realFramerMotion,
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: { ...realFramerMotion.motion, div: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));

// RX-13 seam under test: what the display hook resolves. Overridden per test.
let mockResolvedPresets: Array<Record<string, unknown>> = [];
let mockResolveFails = false;
mock.module("../../api/regex-api.js", () => ({
  ...realRegexApi,
  resolveActiveRegexPresets: async () => {
    if (mockResolveFails) throw new Error("network down");
    return mockResolvedPresets as unknown as Awaited<ReturnType<typeof realRegexApi.resolveActiveRegexPresets>>;
  },
}));

beforeAll(() => {
  if (typeof window !== "undefined") {
    if (!window.matchMedia) {
      window.matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: NOOP, removeEventListener: NOOP,
        addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    }
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      (window as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  }
});

const MessageBlockModule = import("./MessageBlock.js");
const SnapshotStoreModule = import("../../stores/snapshot-store.js");
const ChatStoreModule = import("../../stores/chat-store.js");
const HookModule = import("../../hooks/use-active-regex-presets.js");

async function loadModules() {
  const [{ MessageBlock }, snapshotStore, chatStore, hook] = await Promise.all([
    MessageBlockModule as Promise<{ MessageBlock: React.ComponentType<{ messageId: string; index: number; isFirstAssistant: boolean; isLast: boolean; prevRole: string | null }> }>,
    SnapshotStoreModule as Promise<typeof import("../../stores/snapshot-store.js")>,
    ChatStoreModule as Promise<typeof import("../../stores/chat-store.js")>,
    HookModule,
  ]);
  return { MessageBlock, snapshotStore, chatStore, hook };
}

beforeEach(async () => {
  // The display-preset cache is MODULE-level — without invalidation every
  // test after the first would receive the first test's cached resolution.
  const { hook } = await loadModules();
  hook.invalidateActiveRegexPresets();
});

import type { AppCharacter, AppMessage, AppSnapshot } from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";

const CHAT = "chat-1" as ChatId;

function makeCharacter(id: string): AppCharacter {
  return {
    id, name: `Char ${id}`, avatarExt: null, avatarFullExt: null, description: "", scenario: "",
    systemPrompt: "", subtitle: "", firstMessage: null, mesExample: null,
    mesExampleMode: "always", mesExampleDepth: 4, alternateGreetings: [],
    postHistoryInstructions: null, creatorNotes: null, depthPrompt: null,
    depthPromptDepth: null, depthPromptRole: null, tags: [], avatarAssetId: null,
    avatarFullAssetId: null, avatarCropJson: null, personalitySummary: null,
    includeGalleryInPrompt: false, includeAvatarInPrompt: false,
    avatarDescription: null, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeAssistantMessage(id: string, content: string): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[]): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: {
      id: "chat-1",
      title: "Chat 1",
      characterId: "c1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled: false },
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: makeCharacter("c1"),
    persona: null,
  } as unknown as AppSnapshot;
}

/** Wire-format preset record as /api/regex/resolve-active returns it. */
function wirePreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rx_1",
    name: "test",
    findRegex: "/secret/g",
    replaceString: "[redacted]",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function mountAndRead(content: string) {
  const mods = await loadModules();
  mods.snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", content)]));
  mods.chatStore.useChatStore.getState().setActiveChatId(CHAT);

  const utils = render(
    <mods.MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />,
  );
  // Flush the async preset fetch so the display transform settles.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const storeContent = () =>
    mods.snapshotStore.useSnapshotStore.getState().messagesById["m1"]?.content ?? null;
  return { text: () => utils.container.textContent ?? "", storeContent, utils, mods };
}

describe("MessageBlock — RX-13 display regex seam", () => {
  test("display-mode preset transforms the render, never the store", async () => {
    mockResolvedPresets = [wirePreset({ markdownOnly: true })];
    const { text, storeContent } = await mountAndRead("a secret appears");

    // Note: the Markdown renderer consumes the brackets of "[redacted]"
    // (reference-link syntax) — assert on the replacement word + absence of
    // the original, which is the actual behavior under pin.
    expect(text()).toContain("redacted");
    expect(text()).not.toContain("secret");
    // Store stays raw — display-only never writes back.
    expect(storeContent()).toBe("a secret appears");
  });

  test("replaceString macros resolve on the render output (R-14 parity with ST engine.js:444 substituteParams(replaceWithGroups))", async () => {
    // ST resolves macros on the replacement result AT REGEX TIME; VT's seam
    // macro-resolves the base BEFORE the regex, so a macro born in the
    // replacement (here {{char}}) must be resolved on the LAYER OUTPUT.
    mockResolvedPresets = [wirePreset({ markdownOnly: true, replaceString: "{{char}} here" })];
    const { text, storeContent } = await mountAndRead("a secret appears");

    expect(text()).toContain("Char c1 here");
    expect(text()).not.toContain("{{char}}");
    // Store stays raw — display-only never writes back.
    expect(storeContent()).toBe("a secret appears");
  });

  test("prompt-only preset does NOT change the render (mode isolation)", async () => {
    mockResolvedPresets = [wirePreset({ promptOnly: true })];
    const { text } = await mountAndRead("a secret appears");
    expect(text()).toContain("secret");
    expect(text()).not.toContain("[redacted]");
  });

  test("persist preset does NOT re-transform the render (already stored)", async () => {
    mockResolvedPresets = [wirePreset({})];
    const { text } = await mountAndRead("a secret appears");
    expect(text()).toContain("secret");
    expect(text()).not.toContain("[redacted]");
  });

  test("disabled preset never applies", async () => {
    mockResolvedPresets = [wirePreset({ markdownOnly: true, disabled: true })];
    const { text } = await mountAndRead("a secret appears");
    expect(text()).toContain("secret");
  });

  test("resolve failure degrades silently — render unchanged, no crash", async () => {
    mockResolveFails = true;
    const { text } = await mountAndRead("a secret appears");
    expect(text()).toContain("secret");
    mockResolveFails = false;
  });
});
