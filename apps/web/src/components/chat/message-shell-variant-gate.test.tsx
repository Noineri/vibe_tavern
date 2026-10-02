import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { normalizeInsightsConfig, normalizeObjectiveState } from "@vibe-tavern/domain";
import { wireCharacter } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();

/**
 * Variant-carousel gating invariant for the mobile message actions row.
 *
 * WHAT THIS PROVES
 *   On mobile, the prev/next variant carousel (VariantControls mobile) must
 *   only be offered for the LAST message in the chat. For older assistant
 *   messages the carousel must NOT render at all — exactly as the desktop
 *   actions row already gates with `&& canSwitchVariant`. Letting the carousel
 *   act on an old message silently flips which swipe is "current" and detaches
 *   the following user reply from the variant the user actually responded to.
 *   Reported symptom (2026-06-21): after importing a SillyTavern chat, opening
 *   it on a phone and brushing an old assistant message's arrows rewrote the
 *   active variant — read as "import picked the wrong swipe".
 *
 * HOW IT PROVES IT
 *   The real MessageBlock is mounted for a multi-variant assistant message
 *   under two `isLast` values (false / true) with `useIsMobile()` resolving
 *   true (matchMedia mocked mobile). The variant counter "1/3" is the sentinel
 *   that the mobile variant controls rendered. It must be absent for non-last
 *   and present for last.
 *
 * ROOT CAUSE (for the fix this gates)
 *   MessageShell.tsx MobileMessageActions rendered its `variantControls` slot
 *   under `{!isUser && !isGreeting && variantControls}` — missing the
 *   `&& canSwitchVariant` gate that DesktopMessageActions already enforces.
 */

// ---------------------------------------------------------------------------
// Module mocks — same boundary pattern as message-block-isolation.test.tsx.
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
  handleContinueMessage: NOOP_ASYNC,
  handleSelectMessageVariant: NOOP_ASYNC,
  handleResend: NOOP_ASYNC,
  handleFork: NOOP_ASYNC,
  handleActivateBranch: NOOP_ASYNC,
  handleDeleteActiveBranch: NOOP_ASYNC,
  handleRenameBranch: NOOP_ASYNC,
};

const realChatController = await import("../../hooks/use-chat-controller.js");
const realI18nContext = await import("../../i18n/context.js");
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
	...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
	...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

// ImageBlock's image chrome rides CustomTooltip (needs the app-level
// TooltipProvider) — same passthrough boundary as message-block-image-slot.
mock.module("../shared/Tooltip.js", () => ({
	...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// ---------------------------------------------------------------------------
// Scoped happy-dom + matchMedia mocked to MOBILE (so useIsMobile() === true).
// ---------------------------------------------------------------------------

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let MessageBlockModule: typeof import("./MessageBlock.js");
let SnapshotStoreModule: typeof import("../../stores/snapshot-store.js");
let ChatStoreModule: typeof import("../../stores/chat-store.js");
beforeAll(async () => {
  if (typeof window !== "undefined") {
    // Mobile viewport: the (max-width: 768px) query must match.
    window.matchMedia = (q: string) => ({
      matches: q === "(max-width: 768px)",
      media: q, onchange: null,
      addEventListener: NOOP, removeEventListener: NOOP,
      addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      (window as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  }
  ({ render, act } = await import("@testing-library/react"));
  MessageBlockModule = await import("./MessageBlock.js");
  SnapshotStoreModule = await import("../../stores/snapshot-store.js");
  ChatStoreModule = await import("../../stores/chat-store.js");
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER mocks.
// ---------------------------------------------------------------------------

async function loadModules() {
  return {
    MessageBlock: MessageBlockModule.MessageBlock,
    snapshotStore: SnapshotStoreModule,
    chatStore: ChatStoreModule,
  };
}

// ---------------------------------------------------------------------------
// Factories (mirror message-block-isolation.test.tsx conventions).
// ---------------------------------------------------------------------------

import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../api/types.js";
import type { Attachment, ChatId } from "@vibe-tavern/domain";

const asChatId = (id: string): ChatId => id as ChatId;

function makeCharacter(id: string): AppCharacter {
  return {
    ...wireCharacter(),
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

function makeAssistantMessage(id: string, content = `msg ${id}`): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

/** Assistant message with 3 variants — sentinel counter is "1/3". */
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

function seed(messages: AppMessage[]): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", mode: "rp", messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1", insightsConfig: normalizeInsightsConfig({}), insightsObjectiveState: normalizeObjectiveState({}) } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: makeCharacter("c1"),
    persona: { id: "p1", name: "Persona", avatarExt: null, description: "", avatarAssetId: null, avatarCropJson: null } as unknown as AppPersona,
  } as unknown as AppSnapshot;
}

const CHAT = "chat-1";

beforeEach(async () => {
  const { snapshotStore, chatStore } = await loadModules();
  snapshotStore.useSnapshotStore.getState().clear();
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
});

describe("Mobile variant carousel — gated to last message (desktop parity)", () => {
  test("NON-LAST multi-variant assistant message: carousel must NOT render", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    // m1 = a prior assistant message, m2 = multi-variant non-last assistant message,
    // m3 = a trailing user message so m2 is provably not the last message.
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2"), makeAssistantMessage("m3")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={false} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // The mobile variant counter "1/3" is the sentinel that VariantControls rendered.
    // It must be ABSENT for non-last messages — otherwise tapping the arrows on an
    // old message silently rewrites its active variant.
    expect(container.textContent).not.toContain("1/3");
  });

  test("LAST multi-variant assistant message: carousel IS rendered", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // Positive control: the counter proves the carousel renders for the last message.
    expect(container.textContent).toContain("1/3");
  });
});

// ---------------------------------------------------------------------------
// Content swipe carousel (MobileVariantCarousel in MessageBlock) — the
// 3-panel framer-motion track that fires onSelectVariant on swipe. This is a
// SECOND gate (regression 2026-08): the 2026-06-21 fix above gated only the
// actions-row VariantControls; MessageBlock's mobile render branch still chose
// the swipe carousel for ANY multi-variant message via `isMobile && variantCount > 1`,
// without the `canSwitchVariant` (isLast && !isCoauthorMode) term — so brushing
// an old message's content sideways flipped its variant. Sentinel for the
// swipe carousel is its 300%-wide track (`w-[300%]`); the static desktop-style
// branch never contains it.
// ---------------------------------------------------------------------------

describe("Mobile content swipe carousel — gated to last message", () => {
  test("NON-LAST multi-variant assistant message: swipe track must NOT render, content stays static", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2"), makeAssistantMessage("m3")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={false} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // The 300% track is the swipe carousel; it must be absent for older messages.
    expect(container.innerHTML).not.toContain("w-[300%]");
    // Fallback branch still renders the selected variant's content statically.
    expect(container.textContent).toContain("variant-0");
  });

  test("LAST multi-variant assistant message: swipe track IS rendered", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // Positive control: the swipe carousel track renders for the last message.
    expect(container.innerHTML).toContain("w-[300%]");
  });
});

// ---------------------------------------------------------------------------
// IG-CF11 (owner defect 2026-09-29): a pure image slot's mobile carousel had
// NO swipe surface — the Markdown panels render nothing for empty-content
// variants, so the track collapsed to ~0 height and a finger swipe over the
// image did nothing (only the chevron buttons switched variants). The fix:
// on mobile the carousel panels carry each variant's IMAGE; the standalone
// AttachmentGrid below is suppressed for that path (else the current variant's
// image renders twice). Sentinel: `[data-testid=image-block-img]` src counts.
// ---------------------------------------------------------------------------

describe("Mobile image-slot carousel — panels carry the image (IG-CF11)", () => {
  const slotAtt = (id: string, assetId: string): Attachment => ({
    id, assetId, type: "image", name: `gen-${assetId}`, mimeType: "image/png", sizeBytes: 1, description: null,
    imageGen: { mode: "portrait", profileId: "p1", params: {}, prompt: "p" },
  });

  /** Pure image slot, 3 variants, loaded with variant 1 selected (its own set
   *  on `attachments`, the row set shadowed per IG-CF10b). */
  function makeImageSlot(withRowShadow: boolean): AppMessage {
    const row = slotAtt("a-row", "asset-row");
    const v1 = slotAtt("a-1", "asset-1");
    const v2 = slotAtt("a-2", "asset-2");
    return {
      id: "m2", role: "assistant", content: "",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      attachments: [v1],
      ...(withRowShadow ? { messageLevelAttachments: [row] } : {}),
      variants: [
        { variantIndex: 0, content: "", reasoning: null, reasoningDurationMs: null, isSelected: false, attachmentsJson: null },
        { variantIndex: 1, content: "", reasoning: null, reasoningDurationMs: null, isSelected: true, attachmentsJson: JSON.stringify([v1]) },
        { variantIndex: 2, content: "", reasoning: null, reasoningDurationMs: null, isSelected: false, attachmentsJson: JSON.stringify([v2]) },
      ],
      selectedVariantIndex: 1, modelId: null,
    } as unknown as AppMessage;
  }

  function imageSrcs(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-testid="image-block-img"]')].map((el) => el.getAttribute("src") ?? "");
  }

  test("multi-variant slot: one image PER PANEL (row set / v1 / v2), no duplicate grid below", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeImageSlot(true)]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // The swipe track renders AT ALL for the slot (the pre-fix bug: it existed
    // but its empty panels gave it zero height — no swipe surface).
    expect(container.innerHTML).toContain("w-[300%]");
    // One image per panel: v0 → the row-set shadow, v1 → its own set,
    // v2 → its own set. Exactly one of each — the standalone grid below must
    // NOT add a second copy of the current variant's image.
    const srcs = imageSrcs(container);
    expect(srcs.length).toBe(3);
    expect(srcs.filter((s) => s.includes("asset-row")).length).toBe(1);
    expect(srcs.filter((s) => s.includes("asset-1")).length).toBe(1);
    expect(srcs.filter((s) => s.includes("asset-2")).length).toBe(1);
    // The current panel's neighbors are non-interactive (neighbor images must
    // not open the lightbox/menus; the drag lives on the track).
    const neighborPanels = container.querySelectorAll(".pointer-events-none");
    expect(neighborPanels.length).toBe(2);
  });

  test("legacy payload (no row-set shadow): the v0 panel mirrors the store's keep-current resolution", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeImageSlot(false)]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // The row set was never visible on the wire (pre-CF10b payload): the store
    // resolves a null-attachmentsJson variant to the CURRENT set — the v0
    // panel previews exactly that (asset-1 on both the v0 and v1 panels), so
    // the preview never lies about what the swipe will land on.
    const srcs = imageSrcs(container);
    expect(srcs.length).toBe(3);
    expect(srcs.filter((s) => s.includes("asset-1")).length).toBe(2);
    expect(srcs.filter((s) => s.includes("asset-2")).length).toBe(1);
  });

  test("single-variant slot (no carousel): the standalone grid renders exactly one image", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    const only = slotAtt("a-row", "asset-row");
    const slot = {
      id: "m2", role: "assistant", content: "",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      attachments: [only],
      variants: [
        { variantIndex: 0, content: "", reasoning: null, reasoningDurationMs: null, isSelected: true, attachmentsJson: null },
      ],
      selectedVariantIndex: 0, modelId: null,
    } as unknown as AppMessage;
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1"), slot]));
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // variantCount === 1 → no carousel; the plain grid path must render the
    // image exactly once (the suppression must not eat the no-carousel case).
    expect(container.innerHTML).not.toContain("w-[300%]");
    const srcs = imageSrcs(container);
    expect(srcs.length).toBe(1);
    expect(srcs[0].includes("asset-row")).toBe(true);
  });
});
