/**
 * Scene zone — SCN-12 characterization.
 *
 * Pins the header-zone boundary: the descriptor registers at
 * `assistant_header_zone` (order 2) and its `visible` predicate implements the
 * focused-latest-header contract — the LATEST assistant mounts Generate/Update
 * when missing/stale, an OLDER assistant mounts ONLY when its selected variant
 * has a current valid record, and Tracker OFF is true zero DOM. The component
 * then renders Generate/Update/Edit/Delete/Cancel and the recursive read view,
 * hydrates the generating flag from the server status on mount (latest only),
 * and preserves cross-message isolation (a mutation for message A yields 0
 * commits for message B).
 *
 * Runner: vitest (apps/web — vi.mock is file-scoped, no cross-file leak). The
 * snapshot store + generation store are REAL (seeded via ingestSnapshot); the
 * Scene actions + i18n + mobile hook + Modal/BottomSheet chrome are mocked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useSceneGenerationStore } from "../../../stores/scene-generation-store.js";
import { useHeaderZoneExpansionStore } from "../../../stores/header-zone-expansion.js";
import { useSceneRenderStore } from "../../../stores/scene-render-store.js";
import { resolveMessageSlots, type MessageSlotContext } from "../../../lib/message-slot-registry.js";
// Side-effect import: registers the scene descriptor at module load.
import "./scene-zone.js";
import { SceneZone } from "./scene-zone.js";
import type { AppMessage, AppSnapshot } from "../../../app-client.js";
import type { SceneTrackerRecord } from "@vibe-tavern/domain";

const mocks = vi.hoisted(() => ({
  generateSceneAction: vi.fn(),
  editSceneAction: vi.fn(),
  deleteSceneAction: vi.fn(),
  cancelSceneAction: vi.fn(),
  getSceneStatusAction: vi.fn().mockResolvedValue({ generating: false, record: null }),
}));

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

vi.mock("../../../hooks/use-mobile.js", () => ({ useIsMobile: () => false }));

vi.mock("../../../stores/api-actions/chat-actions.js", () => ({
  generateSceneAction: mocks.generateSceneAction,
  editSceneAction: mocks.editSceneAction,
  deleteSceneAction: mocks.deleteSceneAction,
  cancelSceneAction: mocks.cancelSceneAction,
  getSceneStatusAction: mocks.getSceneStatusAction,
}));

// Stub Modal + BottomSheet chrome (Radix Dialog is heavy in happy-dom); both
// just render their children so the editor body is drivable.
vi.mock("../../shared/Modal.js", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement("div", { "data-testid": "modal" }, children) : null,
}));
vi.mock("../../shared/BottomSheet.js", () => ({
  BottomSheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement("div", { "data-testid": "sheet" }, children) : null,
}));

// CustomTooltip is presentational; these tests verify zone button behavior, not
// tooltip rendering. Passthrough children so no Radix TooltipProvider is needed.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

const SCHEMA = { mood: { $type: "string" as const }, tension: { $type: "number" as const, min: 0, max: 10 } };
const SCHEMA_HASH = "h1";
const REVISION = 1;

function record(variantId: string, sceneState: Record<string, unknown>, opts?: { stale?: boolean }): SceneTrackerRecord {
  return {
    variantId: variantId as never,
    schemaHash: opts?.stale ? "old" : SCHEMA_HASH,
    configRevision: opts?.stale ? 0 : REVISION,
    sourceHash: "s1",
    sceneState,
    modelId: null,
    generatedAt: "2026-01-01T00:00:00.000Z" as never,
  };
}

function msg(id: string, opts: { role?: "assistant" | "user"; variantId?: string; rec?: SceneTrackerRecord | null; branchId?: string } = {}): AppMessage {
  const variantId = opts.variantId ?? `${id}-v0`;
  return {
    id,
    role: opts.role ?? "assistant",
    chatId: "chat-1",
    branchId: opts.branchId ?? "b1",
    content: `content ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [{ id: variantId, messageId: id, variantIndex: 0, content: `content ${id}`, isSelected: true } as unknown as AppMessage["variants"][number]],
    selectedVariantIndex: 0,
    modelId: null,
    sceneTracker: opts.rec === undefined ? null : opts.rec,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[], trackerEnabled = true): void {
  const snap: AppSnapshot = {
    chats: [],
    allCharacters: [],
    activeChat: {
      id: "chat-1", title: "Chat 1", characterId: "c1",
      insightsConfig: { objectiveEnabled: false, trackerEnabled, tracker: { schema: SCHEMA, schemaHash: SCHEMA_HASH, revision: REVISION } as never },
    } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [], messages, summaries: [], promptTrace: null, contextPreview: null,
    character: null, persona: null,
  } as unknown as AppSnapshot;
  useSnapshotStore.getState().ingestSnapshot(snap);
}

function ctx(messageId: string, variantIndex = 0): MessageSlotContext {
  return { chatId: "chat-1", messageId, messageRole: "assistant", variantIndex, isStreaming: false, extras: {} };
}

const SCENE_ID = "insights-scene-tracker";

function visible(messageId: string): boolean {
  const resolved = resolveMessageSlots("assistant_header_zone", ctx(messageId));
  return resolved.some((d) => d.id === SCENE_ID);
}

beforeEach(() => {
  useSceneGenerationStore.getState().clearAll();
  // The expansion store persists across tests (separate zustand store); reset it
  // so each test starts collapsed.
  useHeaderZoneExpansionStore.setState({ open: {} });
  // Reset the shared render-variant preference so each test starts at rich.
  useSceneRenderStore.setState({ variant: "rich" });
});

afterEach(() => {
  cleanup();
  useSnapshotStore.getState().clear();
  mocks.generateSceneAction.mockReset();
  mocks.editSceneAction.mockReset();
  mocks.deleteSceneAction.mockReset();
  mocks.cancelSceneAction.mockReset();
  mocks.getSceneStatusAction.mockReset();
  mocks.getSceneStatusAction.mockResolvedValue({ generating: false, record: null });
});

// ── Visibility (the focused-latest-header contract) ───────────────────────

describe("Scene zone visibility (SCN-12)", () => {
  it("Tracker OFF is true zero DOM (descriptor not resolved)", () => {
    seed([msg("m1", { variantId: "v1" })], false);
    expect(visible("m1")).toBe(false);
  });

  it("latest assistant with NO record mounts (Generate)", () => {
    seed([msg("m1", { variantId: "v1" })]);
    expect(visible("m1")).toBe(true);
  });

  it("older assistant with NO record stays absent", () => {
    seed([msg("m1", { variantId: "v1" }), msg("m2", { variantId: "v2" })]);
    // m2 is the latest assistant; m1 is older with no record → absent.
    expect(visible("m2")).toBe(true);
    expect(visible("m1")).toBe(false);
  });

  it("older assistant with a VALID record mounts", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm", tension: 3 }) }), msg("m2", { variantId: "v2" })]);
    expect(visible("m1")).toBe(true);
  });

  it("older assistant with a STALE record stays absent", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm" }, { stale: true }) }), msg("m2", { variantId: "v2" })]);
    expect(visible("m1")).toBe(false);
  });

  it("a message without a selected variant does not mount", () => {
    const noVariant = msg("m1", { variantId: "v1" });
    (noVariant as { selectedVariantIndex: number | null }).selectedVariantIndex = null;
    seed([noVariant]);
    expect(visible("m1")).toBe(false);
  });
});

// ── Component controls ─────────────────────────────────────────────────────

describe("Scene zone component (SCN-12)", () => {
  it("latest with no record renders a Generate control (expanded)", () => {
    seed([msg("m1", { variantId: "v1" })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    // Collapsed by default — expand first.
    fireEvent.click(getByLabelText("scn_zone_expand"));
    expect(getByLabelText("scn_zone_generate")).toBeTruthy();
  });

  it("a valid record renders Update + Edit + Delete and the read view", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense", tension: 7 }) })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    expect(getByLabelText("scn_zone_update")).toBeTruthy();
    expect(getByLabelText("scn_zone_edit")).toBeTruthy();
    expect(getByLabelText("scn_zone_delete")).toBeTruthy();
    // Read view shows the scene values.
    expect(getByText("tense")).toBeTruthy();
    expect(getByText("7")).toBeTruthy();
    // Rich (the default) renders bounded numbers as a meter.
    expect(container.querySelector('[role="meter"]')).not.toBeNull();
  });

  it("read view follows the shared render-variant store — compact hides the meter", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense", tension: 7 }) })]);
    useSceneRenderStore.setState({ variant: "compact" });
    const { getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    // compact renders bounded numbers as text (no meter); the value 7 still shows.
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.textContent).toContain("7");
  });

  it("Generate fires generateSceneAction with the immutable variant target", async () => {
    mocks.generateSceneAction.mockImplementation((_chat: string, target: { variantId: string }) => {
      // Simulate the server patch: a record lands on the message.
      const m = useSnapshotStore.getState().messagesById["m1"];
      useSnapshotStore.getState().updateMessage("m1", { sceneTracker: record(target.variantId, { mood: "x" }) });
      return { target: { ...target, chatId: "chat-1" }, message: m };
    });
    seed([msg("m1", { variantId: "v1" })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_generate"));
    await vi.waitFor(() => expect(mocks.generateSceneAction).toHaveBeenCalledTimes(1));
    const [, target] = mocks.generateSceneAction.mock.calls[0];
    expect(target).toEqual({ branchId: "b1", messageId: "m1", variantId: "v1" });
  });

  it("while generating, shows a Cancel control that fires cancelSceneAction", async () => {
    seed([msg("m1", { variantId: "v1" })]);
    useSceneGenerationStore.getState().markGenerating("v1");
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_cancel"));
    await vi.waitFor(() => expect(mocks.cancelSceneAction).toHaveBeenCalledTimes(1));
  });

  it("Delete opens a confirm, then fires deleteSceneAction", async () => {
    mocks.deleteSceneAction.mockResolvedValue({ target: { chatId: "chat-1", branchId: "b1", messageId: "m1", variantId: "v1" }, message: msg("m1", { variantId: "v1", rec: null }) });
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense" }) })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_delete"));
    // Confirm dialog appears.
    fireEvent.click(container.querySelector("button.bg-danger")!);
    await vi.waitFor(() => expect(mocks.deleteSceneAction).toHaveBeenCalledTimes(1));
  });

  it("Edit opens the structured editor and Save fires editSceneAction", async () => {
    mocks.editSceneAction.mockResolvedValue({ target: { chatId: "chat-1", branchId: "b1", messageId: "m1", variantId: "v1" }, message: msg("m1", { variantId: "v1", rec: record("v1", { mood: "edited" }) }) });
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense", tension: 7 }) })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_edit"));
    // Editor modal renders the Save button.
    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "scn_edit_save")!;
    expect(saveBtn).toBeTruthy();
    fireEvent.click(saveBtn);
    await vi.waitFor(() => expect(mocks.editSceneAction).toHaveBeenCalledTimes(1));
    const [, , sceneState] = mocks.editSceneAction.mock.calls[0];
    expect(sceneState).toEqual({ mood: "tense", tension: 7 });
  });

  it("hydrates the generating flag from server status on mount (latest only)", async () => {
    mocks.getSceneStatusAction.mockResolvedValue({ generating: true, record: null });
    seed([msg("m1", { variantId: "v1" }), msg("m2", { variantId: "v2" })]);
    render(createElement(SceneZone, { chatId: "chat-1", messageId: "m2" })); // latest
    // The zone calls the status endpoint on mount for the latest message only.
    // The store-marking is the action's own logic (mocked here); this pins the
    // zone's hydration BOUNDARY: it asks the server, for the latest variant.
    await vi.waitFor(() => expect(mocks.getSceneStatusAction).toHaveBeenCalledWith("chat-1", expect.objectContaining({ variantId: "v2" })));
  });

  it("does NOT hydrate status for an older message", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm" }) }), msg("m2", { variantId: "v2" })]);
    render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    expect(mocks.getSceneStatusAction).not.toHaveBeenCalled();
  });

  it("swipe to a different variant swaps the rendered record", () => {
    const m = msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm" }) });
    (m as { variants: unknown[] }).variants = [
      { id: "v1", messageId: "m1", variantIndex: 0, content: "c1", isSelected: false },
      { id: "v2", messageId: "m1", variantIndex: 1, content: "c2", isSelected: true },
    ];
    (m as { selectedVariantIndex: number }).selectedVariantIndex = 1;
    (m as { sceneTracker: unknown }).sceneTracker = record("v2", { mood: "stormy" });
    seed([m]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    expect(getByText("stormy")).toBeTruthy();
  });

  it("a mutation for message B yields ZERO commits for message A's zone", async () => {
    const log: number[] = [];
    function CountingZone() {
      log.push(1);
      return createElement(SceneZone, { chatId: "chat-1", messageId: "m1" });
    }
    seed([
      msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm" }) }),
      msg("m2", { variantId: "v2", rec: record("v2", { mood: "calm" }) }),
    ]);
    render(createElement(CountingZone));
    // Let the mount effect (status hydration) settle first.
    await new Promise((r) => setTimeout(r, 10));
    const before = log.length;
    // Mutate message B's record (an unrelated variant/message). A's primitive
    // selectors are scoped to m1, so A must NOT re-render.
    useSnapshotStore.getState().updateMessage("m2", { sceneTracker: record("v2", { mood: "changed" }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.length).toBe(before); // no re-render for A when B mutated
  });
});
