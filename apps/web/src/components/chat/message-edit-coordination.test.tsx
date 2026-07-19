/**
 * SCN-13 — Scene-generation edit coordination.
 *
 * Pins the MessageBlock ↔ MessageShell ↔ scene-generation-store boundary that
 * locks the Edit affordance while a variant's Scene record is generating:
 *
 *   • local mark  — scene-generation-store has the variant → Edit disabled.
 *   • preflight   — when Tracker is ON and the variant isn't locally locked, a
 *                   click-time getSceneStatusAction catches a job started in
 *                   another tab / before hydration; the editor stays closed and
 *                   a warning toast is shown. A preflight network failure does
 *                   NOT block editing (best-effort cross-tab safety).
 *   • cancel      — clearing the generation flag re-enables Edit.
 *   • variant     — the lock is per-variant: switching to a non-generating
 *                   variant re-enables Edit for that variant alone.
 *   • delete      — deleting a generating variant (or its message) cancels the
 *                   in-flight Scene job FIRST, freeing the coordinator slot.
 *   • screen reader — a locked desktop Edit carries aria-disabled + a title hint.
 *
 * Plus a focused unit test on the shared ActionSheet's new `disabled` item flag
 * (the mobile Edit affordance): a disabled row renders a native disabled button
 * (non-interactive, removed from tab order, announced unavailable).
 *
 * Runner: vitest (apps/web). The real MessageBlock is mounted (its subscription
 * graph is the subject under test); chat-controller / chat-actions / i18n /
 * sonner / mobile hook are mocked at the module boundary. The snapshot +
 * scene-generation stores are real and seeded directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { AppMessage, AppSnapshot, AppCharacter } from "../../app-client.js";
import type { SceneTrackerRecord } from "@vibe-tavern/domain";

// ── Hoisted spies ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  startEdit: vi.fn(),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteVariant: vi.fn().mockResolvedValue(undefined),
  getSceneStatus: vi.fn().mockResolvedValue({ generating: false, record: null }),
  cancelScene: vi.fn().mockResolvedValue(undefined),
  toastWarning: vi.fn(),
}));

vi.mock("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => ({
    handleStartEdit: mocks.startEdit,
    handleSaveMessageEdit: vi.fn(),
    handleCancelEdit: vi.fn(),
    handleDeleteMessage: mocks.deleteMessage,
    handleDeleteVariant: mocks.deleteVariant,
    handleFork: vi.fn(),
    handleRegenerateMessage: vi.fn(),
    handleResend: vi.fn(),
    handleSelectMessageVariant: vi.fn(),
    handleSend: vi.fn(),
    handleCancelGeneration: vi.fn(),
    handleSwitchChat: vi.fn(),
    handleActivateBranch: vi.fn(),
    handleDeleteActiveBranch: vi.fn(),
    handleRenameBranch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { warning: mocks.toastWarning, error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../hooks/use-mobile.js", () => ({ useIsMobile: () => false }));

// Scene/Objective zones render CustomTooltip (icon buttons); presentational here —
// passthrough so no Radix TooltipProvider is needed.
vi.mock("../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// ActionSheet renders into the shared BottomSheet; stub it to render children so
// the item→button mapping (the `disabled` flag under test) is drivable without
// the BottomSheet's portal/swipe chrome (which doesn't mount in happy-dom).
vi.mock("../shared/BottomSheet.js", () => ({
  BottomSheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement("div", { "data-testid": "sheet" }, children) : null,
}));

// SAFE chat-actions mock: spread `...actual` so every other export stays intact
// (the render graph imports more than the two Scene funcs), override only the
// two MessageBlock touches — getSceneStatusAction (preflight) + cancelSceneAction
// (delete-cancel) — so no network call escapes the test.
vi.mock("../../stores/api-actions/chat-actions.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getSceneStatusAction: mocks.getSceneStatus,
    cancelSceneAction: mocks.cancelScene,
  };
});

// ── Dynamic import (after mocks register) ──────────────────────────────────

const MessageBlockModule = import("./MessageBlock.js");
const SnapshotModule = import("../../stores/snapshot-store.js");
const ChatStoreModule = import("../../stores/index.js");
const SceneGenModule = import("../../stores/scene-generation-store.js");
const ActionSheetModule = import("../shared/ActionSheet.js");

async function load() {
  const [{ MessageBlock }, snapshot, chatStore, sceneGen, actionSheet] = await Promise.all([
    MessageBlockModule as Promise<{ MessageBlock: React.ComponentType<{ messageId: string; index: number; isFirstAssistant: boolean; isLast: boolean; prevRole: string | null }> }>,
    SnapshotModule,
    ChatStoreModule,
    SceneGenModule,
    ActionSheetModule,
  ]);
  return { MessageBlock, snapshot, chatStore, sceneGen, actionSheet };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SCHEMA = { mood: { $type: "string" as const } };
const SCHEMA_HASH = "h1";
const REVISION = 1;

function record(variantId: string): SceneTrackerRecord {
  return {
    variantId: variantId as never,
    schemaHash: SCHEMA_HASH,
    configRevision: REVISION,
    sourceHash: "s1",
    sceneState: { mood: "calm" },
    modelId: null,
    generatedAt: "2026-01-01T00:00:00.000Z" as never,
  };
}

function makeCharacter(): AppCharacter {
  return {
    id: "c1", name: "Char", avatarExt: null, avatarFullExt: null, description: "",
    scenario: "", systemPrompt: "", subtitle: "", firstMessage: null, mesExample: null,
    mesExampleMode: "always", mesExampleDepth: 4, alternateGreetings: [],
    postHistoryInstructions: null, creatorNotes: null, depthPrompt: null,
    depthPromptDepth: null, depthPromptRole: null, tags: [], avatarAssetId: null,
    avatarFullAssetId: null, avatarCropJson: null, personalitySummary: null,
    includeGalleryInPrompt: false, includeAvatarInPrompt: false,
    avatarDescription: null, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Assistant message with one selected variant + a current Scene record. */
function sceneMessage(id: string, variantId: string): AppMessage {
  return {
    id, role: "assistant", content: `content ${id}`,
    chatId: "chat-1", branchId: "b1",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [{ id: variantId, messageId: id, variantIndex: 0, content: `content ${id}`, isSelected: true } as unknown as AppMessage["variants"][number]],
    selectedVariantIndex: 0, modelId: null,
    sceneTracker: record(variantId),
  } as unknown as AppMessage;
}

/** Assistant message with TWO variants (variantIndex 0 + 1). Used for the
 *  variant-switch + delete-variant scenarios. */
function twoVariantMessage(id: string, v0: string, v1: string): AppMessage {
  return {
    id, role: "assistant", content: "c0",
    chatId: "chat-1", branchId: "b1",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [
      { id: v0, messageId: id, variantIndex: 0, content: "c0", isSelected: true } as unknown as AppMessage["variants"][number],
      { id: v1, messageId: id, variantIndex: 1, content: "c1", isSelected: false } as unknown as AppMessage["variants"][number],
    ],
    selectedVariantIndex: 0, modelId: null,
    sceneTracker: record(v0),
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[], trackerEnabled = true): void {
  // Always append a trailing latest assistant (no record) so the message under
  // test is NEVER the latest — the scene zone status-hydrates ONLY the latest
  // on mount, and that call would race the edit-coordination assertions (and
  // double-count getSceneStatus). The latest message is never rendered, so its
  // own zone never mounts either.
  const msgs = [...messages, sceneMessage("__latest", "__latest_v")];
  const snap: AppSnapshot = {
    chats: [],
    allCharacters: [],
    activeChat: {
      id: "chat-1", title: "Chat 1", characterId: "c1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled, tracker: { schema: SCHEMA, schemaHash: SCHEMA_HASH, revision: REVISION } as never },
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [], messages: msgs, summaries: [], promptTrace: null,
    character: makeCharacter(), persona: null,
  } as unknown as AppSnapshot;
  useSnapshotStore.getState().ingestSnapshot(snap);
}

// useSnapshotStore is imported at the top of the file via the mock boundary; but
// we need the REAL store. Import it directly (vitest hoists vi.mock, so the real
// module is what loads — the mock above is for chat-actions only).
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useSceneGenerationStore } from "../../stores/scene-generation-store.js";

beforeEach(async () => {
  const { snapshot, chatStore, sceneGen } = await load();
  snapshot.useSnapshotStore.getState().clear();
  sceneGen.useSceneGenerationStore.getState().clearAll();
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
  mocks.startEdit.mockClear();
  mocks.deleteMessage.mockClear();
  mocks.deleteVariant.mockClear();
  mocks.getSceneStatus.mockReset();
  mocks.getSceneStatus.mockResolvedValue({ generating: false, record: null });
  mocks.cancelScene.mockReset();
  mocks.cancelScene.mockResolvedValue(undefined);
  mocks.toastWarning.mockClear();
});

afterEach(() => {
  cleanup();
});

/** Mount MessageBlock (desktop, not-last so the scene zone's mount status
 *  hydration doesn't race the manually-set generation flag). Returns the Edit
 *  affordance span + helpers. */
async function mountBlock(messageId: string) {
  const { MessageBlock, chatStore } = await load();
  chatStore.useChatStore.getState().setActiveChatId("chat-1" as never);
  const utils = render(
    createElement(MessageBlock, { messageId, index: 0, isFirstAssistant: false, isLast: false, prevRole: null }),
  );
  return utils;
}

// ────────────────────────────────────────────────────────────────────────────
// Edit is never blocked by Scene generation
// ────────────────────────────────────────────────────────────────────────────

describe("Edit is never blocked by Scene generation", () => {
  it("Tracker ON or OFF: Edit is always clickable, fires handleStartEdit, with NO status preflight", async () => {
    seed([sceneMessage("m1", "v1")]);
    const { getByText } = await mountBlock("m1");
    fireEvent.click(getByText("edit"));
    await waitFor(() => expect(mocks.startEdit).toHaveBeenCalledTimes(1));
    // The edit path no longer consults the Scene status at all.
    expect(mocks.getSceneStatus).not.toHaveBeenCalled();
  });

  it("a local generation mark does NOT disable Edit; clicking still opens the editor", async () => {
    seed([sceneMessage("m1", "v1")]);
    useSceneGenerationStore.getState().markGenerating("v1");
    const { getByText } = await mountBlock("m1");
    const edit = getByText("edit");
    // Edit is fully enabled — no aria-disabled, no dimming title.
    expect(edit.getAttribute("aria-disabled")).not.toBe("true");
    expect(edit.getAttribute("title")).toBeFalsy();
    fireEvent.click(edit);
    await waitFor(() => expect(mocks.startEdit).toHaveBeenCalledTimes(1));
  });

  it("clicking Edit during an in-flight generation issues NO preflight and NO warning toast", async () => {
    seed([sceneMessage("m1", "v1")]);
    // Even if a server would report generating, MessageBlock no longer asks.
    mocks.getSceneStatus.mockResolvedValue({ generating: true, record: null });
    const { getByText } = await mountBlock("m1");
    fireEvent.click(getByText("edit"));
    await waitFor(() => expect(mocks.startEdit).toHaveBeenCalledTimes(1));
    expect(mocks.getSceneStatus).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it("switching variants during generation keeps Edit enabled on every variant", async () => {
    seed([twoVariantMessage("m1", "vA", "vB")]);
    act(() => { useSceneGenerationStore.getState().markGenerating("vA"); });
    const utils = await mountBlock("m1");
    expect(utils.getByText("edit").getAttribute("aria-disabled")).not.toBe("true");
    act(() => { useSnapshotStore.getState().selectVariant("m1", 1, 1); });
    await waitFor(() => expect(utils.getByText("edit").getAttribute("aria-disabled")).not.toBe("true"));
    act(() => { useSnapshotStore.getState().selectVariant("m1", 0, -1); });
    await waitFor(() => expect(utils.getByText("edit").getAttribute("aria-disabled")).not.toBe("true"));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Delete coordination
// ────────────────────────────────────────────────────────────────────────────

describe("SCN-13 — delete cancels an in-flight Scene job first", () => {
  it("deleting a generating MESSAGE cancels its variant's Scene job before the delete", async () => {
    seed([sceneMessage("m1", "v1")]);
    useSceneGenerationStore.getState().markGenerating("v1");
    const { container } = await mountBlock("m1");
    // Open the destructive-confirm modal via the trash affordance.
    fireEvent.click(container.querySelector("span.absolute")!);
    // Confirm whole-message delete (1 variant → confirm label is "delete").
    fireEvent.click(Array.from(container.ownerDocument.body.querySelectorAll("button")).find((b) => b.textContent === "delete")!);
    await waitFor(() => expect(mocks.cancelScene).toHaveBeenCalledTimes(1));
    expect(mocks.cancelScene).toHaveBeenCalledWith("chat-1", expect.objectContaining({ variantId: "v1", messageId: "m1", branchId: "b1" }));
    // Cancel happened BEFORE the message delete.
    expect(mocks.cancelScene.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteMessage.mock.invocationCallOrder[0]);
    expect(mocks.deleteMessage).toHaveBeenCalledWith("m1");
  });

  it("deleting a generating VARIANT cancels its Scene job before the variant delete", async () => {
    seed([twoVariantMessage("m1", "vA", "vB")]);
    useSceneGenerationStore.getState().markGenerating("vA"); // selected variant generating
    const { container } = await mountBlock("m1");
    fireEvent.click(container.querySelector("span.absolute")!);
    // 2 variants → secondary button "delete_swipe_btn" deletes only the variant.
    fireEvent.click(Array.from(container.ownerDocument.body.querySelectorAll("button")).find((b) => b.textContent === "delete_swipe_btn")!);
    await waitFor(() => expect(mocks.cancelScene).toHaveBeenCalledTimes(1));
    expect(mocks.cancelScene.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteVariant.mock.invocationCallOrder[0]);
    expect(mocks.deleteVariant).toHaveBeenCalledWith("m1", expect.any(Number));
  });

  it("deleting a non-generating message issues NO cancel", async () => {
    seed([sceneMessage("m1", "v1")]);
    const { container } = await mountBlock("m1");
    fireEvent.click(container.querySelector("span.absolute")!);
    fireEvent.click(Array.from(container.ownerDocument.body.querySelectorAll("button")).find((b) => b.textContent === "delete")!);
    await waitFor(() => expect(mocks.deleteMessage).toHaveBeenCalledTimes(1));
    expect(mocks.cancelScene).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ActionSheet disabled item (the mobile Edit affordance)
// ────────────────────────────────────────────────────────────────────────────

describe("SCN-13 — ActionSheet disabled item (mobile Edit affordance)", () => {
  it("a disabled item renders a native disabled button (non-interactive, announced)", async () => {
    const { actionSheet } = await load();
    const { ActionSheet } = actionSheet;
    const action = vi.fn();
    const { container } = render(
      createElement(
        ActionSheet,
        {
          open: true,
          title: "actions",
          onClose: () => {},
          items: [
            { icon: createElement("span", {}, "📝"), label: "Edit", action, disabled: true },
            { icon: createElement("span", {}, "📋"), label: "Copy", action: () => {} },
          ],
        },
      ),
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const editBtn = buttons.find((b) => b.textContent?.includes("Edit"))!;
    expect(editBtn).toBeTruthy();
    expect(editBtn.disabled).toBe(true);
    // Clicking a disabled button must not fire the action or close.
    fireEvent.click(editBtn);
    expect(action).not.toHaveBeenCalled();
    // The Copy row stays enabled.
    const copyBtn = buttons.find((b) => b.textContent?.includes("Copy"))!;
    expect(copyBtn.disabled).toBe(false);
  });
});
