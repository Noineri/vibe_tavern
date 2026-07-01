import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Render-isolation invariant for MessageBlock.
 *
 * WHAT THIS PROVES
 *   Mutating message B's data (a streaming tick, a variant swipe, a content
 *   edit) must NOT cause the MessageBlock for message A to re-render. This is
 *   the render-isolation contract established by CHAT_FRONTEND_REFACTOR_PLAN
 *   Wave A, and it is the gate every future MessageBlock subscription must
 *   keep green — the generation queue (CHAT_GENERATION_QUEUE_PLAN) and Insights
 *   (INSIGHTS_PLAN) plug in by writing per-message / primitive / reference-
 *   stable selectors, never a broad chat-wide one.
 *
 * HOW IT PROVES IT
 *   The real MessageBlock is mounted for message A (its subscription graph is
 *   the subject under test — not a stub). Heavy out-of-graph dependencies are
 *   mocked at the module boundary (useChatController, useT); jsdom gaps are
 *   shimmed (matchMedia, ResizeObserver). A <Profiler> wraps A and counts
 *   commits. We then drive real store mutations and assert commit counts.
 *
 * POSITIVE CONTROLS (not just negatives)
 *   A "0 re-renders" assertion passes trivially if MessageBlock is broken or
 *   its subscriptions never fire. So each negative case is paired with a
 *   positive control proving the subscription graph IS active: mutating A's
 *   own content re-renders A; changing persona (which useMessageAuthor reads)
 *   re-renders A. If the negatives pass but a positive fails, isolation holds
 *   for the wrong reason and the test must be fixed.
 *
 * STATIC IMPORT GUARD
 *   A final case reads MessageBlock.tsx's source and asserts it imports none
 *   of the broad selectors (useChatMeta / useActiveGeneration / useMessageOrder)
 *   that caused the original re-render storm. This catches a future regression
 *   at import time, before any scenario is written.
 */

// ---------------------------------------------------------------------------
// Module mocks — must run before the dynamic import of MessageBlock so bun's
// module loader returns the stubs. useChatController pulls in provider stores,
// api-actions and sonner; useT needs a React context provider. Neither is
// relevant to the isolation graph under test.
// ---------------------------------------------------------------------------

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

const STABLE_CONTROLLER = {
  handleSend: NOOP_ASYNC,
  handleCancelGeneration: NOOP,
  handleSwitchChat: NOOP_ASYNC,
  handleStartEdit: NOOP,
  handleCancelEdit: NOOP,
  handleSaveMessageEdit: NOOP_ASYNC,
  handleDeleteMessage: NOOP_ASYNC,
  handleDeleteVariant: NOOP_ASYNC,
  handleRegenerateMessage: NOOP_ASYNC,
  handleSelectMessageVariant: NOOP_ASYNC,
  handleResend: NOOP_ASYNC,
  handleFork: NOOP_ASYNC,
  handleActivateBranch: NOOP_ASYNC,
  handleDeleteActiveBranch: NOOP_ASYNC,
  handleRenameBranch: NOOP_ASYNC,
};

mock.module("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

// ---------------------------------------------------------------------------
// SCOPED happy-dom registration + jsdom shims.
//
// WHY SCOPED (not a bunfig preload): this test file registers the global DOM
// in beforeAll and UNREGISTERS it in afterAll. The repo has DOM-averse tests
// (avatar.test.ts, gateway-client) that rely on `typeof window === "undefined"`
// so e.g. getGatewayBaseUrl() returns its SSR fallback. A permanent preload
// would inject a window into their environment and break them. Scoping keeps
// both worlds working: this file gets a window while it runs; pure-logic files
// never see one.
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Register the DOM FIRST so the shims below see a defined `window`.
  GlobalRegistrator.register();
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

afterEach(() => {
  // Unmount anything this file rendered so commits/cleanup don't leak across cases.
  cleanup();
});

afterAll(() => {
  // Remove the global DOM so subsequent DOM-averse test files see no window.
  GlobalRegistrator.unregister();
});

// ---------------------------------------------------------------------------
// Dynamic import AFTER mocks are registered.
// ---------------------------------------------------------------------------

const MessageBlockModule = import("./MessageBlock.js");
const SnapshotStoreModule = import("../../stores/snapshot-store.js");
const ChatStoreModule = import("../../stores/chat-store.js");
const FsModule = import("node:fs/promises");
const PathModule = import("node:path");

// Resolved lazily inside tests (after mocks apply).
async function loadModules() {
  const [{ MessageBlock }, snapshotStore, chatStore, fs, path] = await Promise.all([
    MessageBlockModule as Promise<{ MessageBlock: React.ComponentType<{ messageId: string; index: number; isFirstAssistant: boolean; isLast: boolean; prevRole: string | null }> }>,
    SnapshotStoreModule as Promise<typeof import("../../stores/snapshot-store.js")>,
    ChatStoreModule as Promise<typeof import("../../stores/chat-store.js")>,
    FsModule,
    PathModule,
  ]);
  return { MessageBlock, snapshotStore, chatStore, fs, path };
}

// ---------------------------------------------------------------------------
// Test factories (hermetic — no live DB; matches the convention in
// snapshot-store.test.ts). Synthetic content is sufficient for the isolation
// invariant: what matters is the subscription graph, not message realism.
// ---------------------------------------------------------------------------

import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../app-client.js";
import type { ChatId, ChatBranchId } from "@vibe-tavern/domain";

const asChatId = (id: string): ChatId => id as ChatId;
const asBranchId = (id: string): ChatBranchId => id as ChatBranchId;

function makeCharacter(id: string, name = `Char ${id}`): AppCharacter {
  return {
    id, name, avatarExt: null, avatarFullExt: null, description: "", scenario: "",
    systemPrompt: "", subtitle: "", firstMessage: null, mesExample: null,
    mesExampleMode: "always", mesExampleDepth: 4, alternateGreetings: [],
    postHistoryInstructions: null, creatorNotes: null, depthPrompt: null,
    depthPromptDepth: null, depthPromptRole: null, tags: [], avatarAssetId: null,
    avatarFullAssetId: null, avatarCropJson: null, personalitySummary: null,
    includeGalleryInPrompt: false, includeAvatarInPrompt: false,
    avatarDescription: null, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePersona(id: string, name = `Persona ${id}`): AppPersona {
  return {
    id, name, avatarExt: null, description: "",
    avatarAssetId: null, avatarCropJson: null,
  } as unknown as AppPersona;
}

function makeAssistantMessage(id: string, content = `msg ${id}`): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

/** Message with multiple variants — used for the variant-swipe scenario. */
function makeMultiVariantMessage(id: string): AppMessage {
  return {
    id, role: "assistant",
    content: "variant-0",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [
      { variantIndex: 0, content: "variant-0", reasoning: null, reasoningDurationMs: null, isSelected: true },
      { variantIndex: 1, content: "variant-1", reasoning: null, reasoningDurationMs: null, isSelected: false },
      { variantIndex: 2, content: "variant-2", reasoning: null, reasoningDurationMs: null, isSelected: false },
    ],
    selectedVariantIndex: 0, modelId: null,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[], persona: AppPersona | null = null): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null, contextPreview: null,
    character: makeCharacter("c1"),
    persona,
  } as unknown as AppSnapshot;
}

const CHAT = "chat-1";

beforeEach(async () => {
  const { snapshotStore, chatStore } = await loadModules();
  snapshotStore.useSnapshotStore.getState().clear();
  // Reset chat-store to a clean baseline: no active chat, no generations.
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
});

/** Mount MessageBlock for `messageId` and return its commit counter + rerender(). */
async function mountBlockForCounting(messageId: string) {
  const { MessageBlock } = await loadModules();
  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => { commits++; };
  const tree = (
    <Profiler id={messageId} onRender={onRender}>
      <MessageBlock messageId={messageId} index={0} isFirstAssistant={false} isLast={false} prevRole={null} />
    </Profiler>
  );
  const utils = render(tree);
  return {
    get commits() { return commits; },
    reset() { commits = 0; },
    rerender: utils.rerender,
    unmount: utils.unmount,
  };
}

describe("MessageBlock — render isolation invariant", () => {
  test("POSITIVE CONTROL: a streaming tick on A's target re-renders A (after start transition)", async () => {
    const { snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")]));
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const probe = await mountBlockForCounting("m1");
    expect(probe.commits).toBe(1); // mount

    // Begin streaming into m1. This flips isSending false→true (chat-wide),
    // which legitimately re-renders A once — that is the start TRANSITION,
    // not a tick. Reset the counter so we measure only the per-tick phase.
    act(() => { chatStore.useChatStore.getState().startGeneration(CHAT, null, undefined, "m1"); });
    await act(async () => { await Promise.resolve(); });
    probe.reset();

    // Tick the revealed text — useStreamingRevealedFor must observe each tick.
    act(() => { chatStore.useChatStore.getState().setStreamingRevealed(CHAT, "delta"); });
    await act(async () => { await Promise.resolve(); });

    expect(probe.commits).toBeGreaterThan(0); // A re-rendered on its own tick — graph is active
    probe.unmount();
  });

  test("NEGATIVE: streaming ticks on B do NOT re-render A (after start transition)", async () => {
    const { snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeAssistantMessage("m2")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const probeA = await mountBlockForCounting("m1");
    expect(probeA.commits).toBe(1);

    // Begin streaming into m2 only. The isSending false→true flip legitimately
    // re-renders A once (start TRANSITION, chat-wide busy state). Reset so the
    // per-tick phase is what we assert on — that is the actual invariant.
    act(() => { chatStore.useChatStore.getState().startGeneration(CHAT, null, undefined, "m2"); });
    await act(async () => { await Promise.resolve(); });
    probeA.reset();

    // Multiple revealed-text ticks — none must touch A.
    act(() => { chatStore.useChatStore.getState().setStreamingRevealed(CHAT, "delta-one"); });
    await act(async () => { await Promise.resolve(); });
    act(() => { chatStore.useChatStore.getState().setStreamingRevealed(CHAT, "delta-two"); });
    await act(async () => { await Promise.resolve(); });

    expect(probeA.commits).toBe(0); // A untouched by B's streaming ticks
    probeA.unmount();
  });

  test("NEGATIVE: a variant swipe on B does NOT re-render A", async () => {
    const { snapshotStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2")]),
    );
    const { setActiveChatId } = (await loadModules()).chatStore.useChatStore.getState();
    setActiveChatId(asChatId(CHAT));

    const probeA = await mountBlockForCounting("m1");
    expect(probeA.commits).toBe(1);

    // Switch m2's selected variant via the snapshot store action.
    act(() => { snapshotStore.useSnapshotStore.getState().selectVariant("m2", 1, 1); });
    await act(async () => { await Promise.resolve(); });
    act(() => { snapshotStore.useSnapshotStore.getState().selectVariant("m2", 2, 1); });
    await act(async () => { await Promise.resolve(); });

    expect(probeA.commits).toBe(1); // A untouched by B's variant change
    probeA.unmount();
  });

  test("NEGATIVE: a content edit on B does NOT re-render A", async () => {
    const { snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeAssistantMessage("m2", "old m2")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const probeA = await mountBlockForCounting("m1");
    expect(probeA.commits).toBe(1);

    // Simulate an endpoint response returning a new m2 content (B is mutated).
    act(() => {
      snapshotStore.useSnapshotStore.getState().ingestSnapshot({
        messages: [makeAssistantMessage("m1"), makeAssistantMessage("m2", "edited m2")],
      } as AppSnapshot);
    });
    await act(async () => { await Promise.resolve(); });

    expect(probeA.commits).toBe(1); // A untouched by B's edit
    probeA.unmount();
  });

  test("POSITIVE CONTROL: changing persona (chat-wide, read by useMessageAuthor) re-renders A", async () => {
    const { snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1")], makePersona("p1", "Alice")),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const probeA = await mountBlockForCounting("m1");
    expect(probeA.commits).toBe(1);

    act(() => {
      snapshotStore.useSnapshotStore.getState().ingestSnapshot({
        persona: makePersona("p1", "Bob"),
      } as AppSnapshot);
    });
    await act(async () => { await Promise.resolve(); });

    expect(probeA.commits).toBeGreaterThan(1); // useMessageAuthor fired — proves it is wired
    probeA.unmount();
  });

  test("STATIC IMPORT GUARD: main MessageBlock does not call broad selectors", async () => {
    const { fs, path } = await loadModules();
    const file = path.resolve(import.meta.dirname, "MessageBlock.tsx");
    const src = await fs.readFile(file, "utf8");

    // Scope to the main MessageBlock function body only. The broad selectors
    // (useChatMeta / useActiveGeneration) ARE still legitimately used by the
    // singleton PendingUserMessage / PendingAssistantMessage components in
    // this same file — that is explicitly allowed by the plan (singletons,
    // one instance, low value to narrow). What is forbidden is calling them
    // from the main memoized MessageBlock, which renders once per visible
    // message and would leak across all of them.
    const mainStart = src.indexOf("export const MessageBlock = memo(function MessageBlock");
    expect(mainStart).toBeGreaterThan(-1);
    const nextFnIdx = src.indexOf("\nfunction ", mainStart + 1);
    expect(nextFnIdx).toBeGreaterThan(-1);
    const mainBody = src.slice(mainStart, nextFnIdx);

    expect(mainBody).not.toContain("useChatMeta(");
    expect(mainBody).not.toContain("useActiveGeneration(");
    expect(mainBody).not.toContain("useMessageOrder(");

    // Sanity: the narrow ones ARE wired in main (otherwise the guard is vacuous).
    expect(mainBody).toContain("useMessageAuthor()");
    expect(mainBody).toContain("useIsStreamingTarget(");
    expect(mainBody).toContain("useStreamingRevealedFor(");
  });
});

// Silence unused ReactNode import lint.
type _Unused = ReactNode;
