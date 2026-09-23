/**
 * MessageBlock — pure image-slot rendering (IG-CF6, IMAGE_GENERATION_PLAN).
 *
 * The owner-decided slot message kind (2026-09-15): an assistant message with
 * empty content whose every attachment is a generated image renders WITHOUT
 * the text action row and WITHOUT token meta — those are text-message
 * controls aimed at an empty message. The slot's own controls (regenerate /
 * promote / include + swipe carousel) REPLACE the text actions; the
 * avatar/name header stays; delete stays. Any text content or non-imageGen
 * attachment disqualifies (that is a text message with images attached) and
 * keeps the full text surface.
 *
 * Harness mirrors message-block-regex-display.test.tsx: real MessageBlock
 * mounted, heavy out-of-graph modules mocked at the boundary.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { wireCharacter } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");

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
  handleContinueMessage: async () => {},
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

type MessageBlockProps = {
  messageId: string;
  index: number;
  isFirstAssistant: boolean;
  isLast: boolean;
  prevRole: string | null;
};

async function loadModules() {
  const [{ MessageBlock }, snapshotStore, chatStore] = await Promise.all([
    MessageBlockModule as Promise<{ MessageBlock: React.ComponentType<MessageBlockProps> }>,
    SnapshotStoreModule as Promise<typeof import("../../stores/snapshot-store.js")>,
    ChatStoreModule as Promise<typeof import("../../stores/chat-store.js")>,
  ]);
  return { MessageBlock, snapshotStore, chatStore };
}

import type { AppCharacter, AppMessage, AppSnapshot } from "../../api/types.js";
import type { Attachment, ChatId } from "@vibe-tavern/domain";

const CHAT = "chat-1" as ChatId;

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

function slotAttachment(overrides?: Partial<Attachment>): Attachment {
  return {
    id: "att-1",
    assetId: "asset-1",
    type: "image",
    name: "imagegen-asset-1",
    mimeType: "image/png",
    sizeBytes: 12,
    description: null,
    imageGen: {
      mode: "portrait",
      profileId: "p1",
      params: {},
      prompt: "A painted portrait of the tavern keeper.",
    },
    ...overrides,
  };
}

/** The IG-CF6 pure image slot: assistant, empty content, imageGen attachments. */
function makeSlotMessage(id: string, attachments: Attachment[] = [slotAttachment()], variants: unknown[] = []): AppMessage {
  return {
    id, role: "assistant", content: "",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants, selectedVariantIndex: variants.length > 0 ? 0 : null, modelId: null,
    attachments,
  } as unknown as AppMessage;
}

function makeAssistantMessage(id: string, content: string, attachments?: Attachment[]): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
    ...(attachments !== undefined ? { attachments } : {}),
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

beforeEach(async () => {
  const { snapshotStore, chatStore } = await loadModules();
  snapshotStore.useSnapshotStore.getState().clear();
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
});

describe("MessageBlock — pure image slot (IG-CF6)", () => {
  test("pure slot: NO text action row, NO token meta; slot controls + carousel + delete replace them; image renders via ImageBlock", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeSlotMessage("m1")]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);

    // The image is the content (justified row); its generation prompt sits
    // behind the MR-8 accordion — collapsed at rest, one click reveals it.
    expect(view.getAllByTestId("image-block-img").length).toBe(1);
    const captionRow = view.getByTestId("image-block-caption");
    expect(captionRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(captionRow);
    expect(view.getByTestId("image-block-caption-text").textContent).toContain("A painted portrait");

    // Text actions are GONE — copy/edit/branch/text-regen never render.
    for (const label of ["copy", "edit", "branch", "regen", "continue_tooltip"]) {
      expect(view.queryByText(label), `text action "${label}"`).toBeNull();
    }
    // Token meta is gone.
    expect(view.queryByText(/^\d+ tokens_label$/)).toBeNull();

    // The slot's own controls replace the text row.
    expect(view.getByTestId("image-gen-slot-regenerate")).toBeTruthy();
    expect(view.getByTestId("image-gen-slot-promote")).toBeTruthy();
    expect(view.getByTestId("image-gen-slot-include")).toBeTruthy();
    // C-B: the mode label now lives in the slot's OWN meta line at the
    // text message's metadata position — ABOVE the action row (owner
    // 2026-09-19: «вынести мету… выше кнопок, как у текстового сообщения»)
    // — together with the generation model when the slot stamped one.
    const meta = view.getByTestId("image-gen-slot-meta");
    expect(view.getByTestId("image-gen-slot-mode").textContent).toBe("image_gen_mode_portrait");
    expect(view.queryByTestId("image-gen-slot-model")).toBeNull(); // fixture stamps no model
    const metaChrome = meta.className;
    expect(metaChrome).toContain("text-t3/50"); // the text metadata bar's quiet chrome
    expect(meta.compareDocumentPosition(view.getByTestId("image-gen-slot-regenerate")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Delete stays so a slot can be removed.
    expect(view.getByTestId("image-slot-delete")).toBeTruthy();

    // The avatar/name header stays (the character's name renders).
    expect(view.container.textContent).toContain("Char c1");
  });

  test("C-B meta line: a model-bearing provenance renders the generation model beside the mode", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([
        makeSlotMessage("m2", [
          slotAttachment({
            imageGen: {
              mode: "scene-illustration",
              profileId: "p1",
              model: "graycolor_v18.safetensors",
              params: {},
              prompt: "x",
            },
          }),
        ]),
      ]),
    );
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m2" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    expect(view.getByTestId("image-gen-slot-mode").textContent).toBe("image_gen_mode_scene-illustration");
    expect(view.getByTestId("image-gen-slot-model").textContent).toBe("graycolor_v18.safetensors");
  });

  test("pure slot with swipe variants: the variant carousel stays intact (1/2 counter)", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    const variants = [
      { variantIndex: 0, content: "", reasoning: null, reasoningDurationMs: null, isSelected: true },
      { variantIndex: 1, content: "", reasoning: null, reasoningDurationMs: null, isSelected: false },
    ];
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeSlotMessage("m1", [slotAttachment()], variants)]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    // VariantControls' counter renders inside the slot action row.
    expect(view.getByText("1/2")).toBeTruthy();
  });

  test("IF-4a: the slot image row rides the variant-slide wrapper and swaps assets with the variant (IG-CF10 optimistic set)", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    const first = slotAttachment();
    const second = slotAttachment({ id: "att-2", assetId: "asset-2", name: "imagegen-asset-2" });
    const variants = [
      { variantIndex: 0, content: "", reasoning: null, reasoningDurationMs: null, isSelected: true, attachmentsJson: JSON.stringify([first]) },
      { variantIndex: 1, content: "", reasoning: null, reasoningDurationMs: null, isSelected: false, attachmentsJson: JSON.stringify([second]) },
    ];
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeSlotMessage("m1", [first], variants)]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    const img = view.getByTestId("image-block-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("asset-1");
    // The text body's slide idiom wrapper (relative overflow-hidden clipping
    // box) owns the slot row on the assistant path (framer-motion is mocked
    // to a plain div in this harness — the wrapper is the wiring pin).
    expect(img.closest(".overflow-hidden")).toBeTruthy();

    // The swipe: store-driven variant select swaps the optimistic
    // attachments set (IG-CF10) — the row re-renders with the other asset.
    // R10: park on the SWAPPED state (waitFor re-queries until the src
    // flips), never on the first frame that still shows the old asset.
    snapshotStore.useSnapshotStore.getState().selectVariant("m1", 1, 1);
    await waitFor(() => {
      const swapped = view.getByTestId("image-block-img") as HTMLImageElement;
      expect(swapped.getAttribute("src")).toContain("asset-2");
    });
  });

  test("IF-4b: slot arrows stay live while the message is busy (swipeWhileBusy path); text arrows keep the busy lock", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    const slotVariants = [
      { variantIndex: 0, content: "", reasoning: null, reasoningDurationMs: null, isSelected: true },
      { variantIndex: 1, content: "", reasoning: null, reasoningDurationMs: null, isSelected: false },
    ];
    const textVariants = [
      { variantIndex: 0, content: "First take.", reasoning: null, reasoningDurationMs: null, isSelected: true },
      { variantIndex: 1, content: "Second take.", reasoning: null, reasoningDurationMs: null, isSelected: false },
    ];
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([
      makeSlotMessage("m-slot", [slotAttachment()], slotVariants),
      { ...makeAssistantMessage("m-text", "Hello there."), variants: textVariants, selectedVariantIndex: 0 } as unknown as AppMessage,
    ]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);
    // A busy message = an in-flight action holds its id (isBusy in MessageBlock).
    chatStore.useChatStore.setState({ messageActionId: "m-slot" });

    // Slot: arrows enabled while busy. The counter text sits in its OWN
    // inner span — the arrow pair lives on the VariantControls root span one
    // level up. The action row may mount the controls in more than one
    // responsive instance — every ARMED instance must show the same state.
    const armedArrowStates = (view: ReturnType<typeof render>): boolean[][] =>
      view.getAllByText("1/2")
        .map((counter) => {
          const root = counter.closest("span")!.parentElement!;
          return [...root.querySelectorAll("button")].map((button) => button.disabled);
        })
        .filter((arrows) => arrows.length === 2);
    const slotView = render(<MessageBlock messageId="m-slot" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    const slotStates = armedArrowStates(slotView);
    expect(slotStates.length).toBeGreaterThan(0);
    // Selected variant 0: prev is POSITIONALLY off, but next is live while
    // busy — the ungate. (Before IF-4b every state here was [true, true].)
    for (const arrows of slotStates) expect(arrows).toEqual([true, false]);

    chatStore.useChatStore.setState({ messageActionId: "m-text" });
    // dom-env renders into a SHARED container within a test — unmount the
    // slot view BEFORE querying the text view, or the slot's live-arrow row
    // pollutes the text assertions.
    slotView.unmount();
    const textView = render(<MessageBlock messageId="m-text" index={1} isFirstAssistant={false} isLast prevRole={null} />);
    const textStates = armedArrowStates(textView);
    expect(textStates.length).toBeGreaterThan(0);
    for (const arrows of textStates) expect(arrows).toEqual([true, true]);
  });

  test("text message control: text actions + token meta DO render (the gate is slot-shaped, not global)", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", "The tavern is warm tonight.")]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    expect(view.getByText("copy")).toBeTruthy();
    expect(view.getByText("edit")).toBeTruthy();
    expect(view.getByText(/^\d+ tokens_label$/)).toBeTruthy();
    expect(view.queryByTestId("image-gen-slot-regenerate")).toBeNull();
    expect(view.queryByTestId("image-slot-delete")).toBeNull();
  });

  test("mixed message (text content + imageGen attachment) is NOT a pure slot — text actions stay, image still renders", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore
      .getState()
      .ingestSnapshot(seed([makeAssistantMessage("m1", "Look what I made:", [slotAttachment()])]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    expect(view.getByText("copy")).toBeTruthy();
    expect(view.getByText(/^\d+ tokens_label$/)).toBeTruthy();
    // The generated image still renders through the justified row.
    expect(view.getAllByTestId("image-block-img").length).toBe(1);
    // No slot control row (the message is a text message now).
    expect(view.queryByTestId("image-gen-slot-regenerate")).toBeNull();
  });

  test("empty-content message WITHOUT imageGen attachments is not a slot (no controls, text surface)", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", "")]));
    chatStore.useChatStore.getState().setActiveChatId(CHAT);

    const view = render(<MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    expect(view.getByText("copy")).toBeTruthy();
    expect(view.getByText(/^\d+ tokens_label$/)).toBeTruthy();
  });
});

afterAll(() => {
  cleanup();
});
