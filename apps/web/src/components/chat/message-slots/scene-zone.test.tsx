/**
 * Scene zone — SCN-12 characterization.
 *
 * Pins the header-zone boundary: the descriptor registers at
 * `assistant_header_zone` (order 2) and its `visible` predicate implements the
 * persisted-record-header contract — the LATEST assistant always mounts (Generate
 * with no record, Update with one); an OLDER assistant mounts whenever it carries
 * a persisted Scene record of ANY schema (rendered read-only — a historical
 * snapshot, never auto-hidden by a config/schema/model change), and Tracker OFF is
 * true zero DOM. The component then renders Generate/Update/Edit/Delete/Cancel
 * (LLM Generate/Update is latest-only) and the recursive read view,
 * hydrates the generating flag from the server status on mount (latest only),
 * and preserves cross-message isolation (a mutation for message A yields 0
 * commits for message B).
 *
 * Runner: bun:test + happy-dom. The snapshot store + generation store are REAL
 * (seeded via ingestSnapshot); the Scene actions + i18n + mobile hook +
 * Modal/BottomSheet chrome are mocked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { brandId, normalizeInsightsConfig, type ChatBranchId, type MessageVariantId } from "@vibe-tavern/domain";
import { wireBranch, wireChat, wireMessage, wireVariant } from "../../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { createElement, type ReactNode } from "react";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useSceneGenerationStore } from "../../../stores/scene-generation-store.js";
import { useHeaderZoneExpansionStore } from "../../../stores/header-zone-expansion.js";
import { useSceneRenderStore } from "../../../stores/scene-render-store.js";
import { resolveMessageSlots, type MessageSlotContext } from "../../../lib/message-slot-registry.js";
import type { AppMessage, AppSnapshot } from "../../../api/types.js";
import type { SceneTrackerDsl } from "@vibe-tavern/domain";

const mocks = {
  generateSceneAction: mock(),
  editSceneAction: mock(),
  deleteSceneAction: mock(),
  cancelSceneAction: mock(),
  getSceneStatusAction: mock(async () => ({ generating: false, record: null })),
  startInsightsCompletionRefresh: mock(),
};
let isMobile = false;
const realMobileHook = await import("../../../hooks/use-mobile.js");
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
const realCompletionActions = await import("../../../stores/api-actions/insights-completion-actions.js");
const realModal = await import("../../shared/Modal.js");
const realBottomSheet = await import("../../shared/BottomSheet.js");
const realTooltip = await import("../../shared/Tooltip.js");

installI18nContextSeam();

mock.module("../../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => isMobile }));

mock.module("../../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  generateSceneAction: mocks.generateSceneAction,
  editSceneAction: mocks.editSceneAction,
  deleteSceneAction: mocks.deleteSceneAction,
  cancelSceneAction: mocks.cancelSceneAction,
  getSceneStatusAction: mocks.getSceneStatusAction,
}));

mock.module("../../../stores/api-actions/insights-completion-actions.js", () => ({
  ...realCompletionActions,
  startInsightsCompletionRefresh: mocks.startInsightsCompletionRefresh,
}));

// Stub Modal + BottomSheet chrome (Radix Dialog is heavy in happy-dom); both
// just render their children so the editor body is drivable.
mock.module("../../shared/Modal.js", () => ({
  ...realModal,
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement("div", { "data-testid": "modal" }, children) : null,
}));
mock.module("../../shared/BottomSheet.js", () => ({
  ...realBottomSheet,
  BottomSheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? createElement("div", { "data-testid": "sheet" }, children) : null,
}));

// CustomTooltip is presentational; these tests verify zone button behavior, not
// tooltip rendering. Passthrough children so no Radix TooltipProvider is needed.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let SceneZone: typeof import("./scene-zone.js").SceneZone;
beforeAll(async () => {
  ({ SceneZone } = await import("./scene-zone.js"));
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const SCHEMA = { mood: { $type: "string" as const }, tension: { $type: "number" as const, min: 0, max: 10 } };
const REVISION = 1;
// SCN-12 (the 7a derivation): the tracker config derives through the domain's
// persisted-column seam — normalizeInsightsConfig recomputes `schemaHash` from
// the schema and never accepts it as input, so the erased literal's
// self-consistent "h1" hash was fake on BOTH sides; the sceneTracker records
// below read the derived hash so the zone's freshness match (scene-zone.tsx:92)
// is real.
const TRACKER_CONFIG = normalizeInsightsConfig({
  objectiveEnabled: false,
  trackerEnabled: true,
  tracker: { schema: SCHEMA, revision: REVISION },
});
const SCHEMA_HASH = TRACKER_CONFIG.tracker?.schemaHash ?? "";

const ROSTER_SCHEMA: SceneTrackerDsl = {
  applicantRoster: {
    $type: "array",
    items: {
      $type: "object",
      properties: {
        condition: { $type: "string" },
        sector: { $type: "string" },
        applicant: { $type: "string" },
        badgeShield: { $type: "string" },
      },
    },
  },
};

function rosterRecord(): SceneTrackerRecord {
  return {
    ...record("v1", {
      applicantRoster: Array.from({ length: 12 }, (_, i) => ({
        condition: `condition ${i + 1}`, sector: `sector ${i + 1}`,
        applicant: `applicant ${i + 1}`, badgeShield: `shield ${i + 1}`,
      })),
    }),
    schema: ROSTER_SCHEMA,
  };
}

type SceneTrackerRecord = NonNullable<AppMessage["sceneTracker"]>;

function record(variantId: string, sceneState: SceneTrackerRecord["sceneState"], opts?: { stale?: boolean }): SceneTrackerRecord {
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
  return wireMessage(id, {
    role: opts.role ?? "assistant",
    branchId: brandId<ChatBranchId>(opts.branchId ?? "b1"),
    content: `content ${id}`,
    variants: [wireVariant(id, 0, { id: brandId<MessageVariantId>(variantId), content: `content ${id}`, isSelected: true })],
    selectedVariantIndex: 0,
    sceneTracker: opts.rec === undefined ? null : opts.rec,
  });
}

function seed(messages: AppMessage[], trackerEnabled = true): void {
  const snap: AppSnapshot = {
    chats: [],
    allCharacters: [],
    activeChat: wireChat({ insightsConfig: { ...TRACKER_CONFIG, trackerEnabled } }),
    activeBranch: wireBranch(),
    branches: [], messages, summaries: [], promptTrace: null,
    character: undefined, persona: null,
  };
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
  isMobile = false;
  useSceneGenerationStore.getState().clearAll();
  // The expansion store persists across tests (separate zustand store); reset it
  // so each test starts collapsed.
  useHeaderZoneExpansionStore.setState({ open: {} });
  // Reset the shared render-variant preference so each test starts at rich.
  useSceneRenderStore.setState({ variant: "rich" });
});

afterEach(() => {
  isMobile = false;
  useSnapshotStore.getState().clear();
  mocks.generateSceneAction.mockReset();
  mocks.editSceneAction.mockReset();
  mocks.deleteSceneAction.mockReset();
  mocks.cancelSceneAction.mockReset();
  mocks.startInsightsCompletionRefresh.mockReset();
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

  it("older assistant with a STALE (different-schema) record STILL mounts (persisted fact, never auto-hidden)", () => {
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "calm" }, { stale: true }) }), msg("m2", { variantId: "v2" })]);
    // A config/schema change never hides a historical record — it renders read-only.
    expect(visible("m1")).toBe(true);
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

  it("an OLDER record renders read-only — no LLM Generate/Update; Edit + Delete remain", () => {
    seed([
      msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense", tension: 7 }) }),
      msg("m2", { variantId: "v2" }), // m2 is latest; m1 is older.
    ]);
    const { getByLabelText, queryByLabelText } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    // LLM Generate/Update is latest-only → neither button renders for an older record.
    expect(queryByLabelText("scn_zone_update")).toBeNull();
    expect(queryByLabelText("scn_zone_generate")).toBeNull();
    // Manual Edit (same-schema record) + Delete remain available on older records.
    expect(getByLabelText("scn_zone_edit")).toBeTruthy();
    expect(getByLabelText("scn_zone_delete")).toBeTruthy();
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
    await waitFor(() => expect(mocks.generateSceneAction).toHaveBeenCalledTimes(1));
    const [, target] = mocks.generateSceneAction.mock.calls[0];
    expect(target).toEqual({ branchId: "b1", messageId: "m1", variantId: "v1" });
  });

  it("while generating, shows a Cancel control that fires cancelSceneAction", async () => {
    seed([msg("m1", { variantId: "v1" })]);
    useSceneGenerationStore.getState().markGenerating("v1");
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_cancel"));
    await waitFor(() => expect(mocks.cancelSceneAction).toHaveBeenCalledTimes(1));
  });

  it("Delete opens a confirm, then fires deleteSceneAction", async () => {
    mocks.deleteSceneAction.mockResolvedValue({ target: { chatId: "chat-1", branchId: "b1", messageId: "m1", variantId: "v1" }, message: msg("m1", { variantId: "v1", rec: null }) });
    seed([msg("m1", { variantId: "v1", rec: record("v1", { mood: "tense" }) })]);
    const { getByText, getByLabelText, container } = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(getByLabelText("scn_zone_expand"));
    fireEvent.click(getByLabelText("scn_zone_delete"));
    // Confirm dialog appears.
    fireEvent.click(container.querySelector("button.bg-danger")!);
    await waitFor(() => expect(mocks.deleteSceneAction).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(mocks.editSceneAction).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(mocks.getSceneStatusAction).toHaveBeenCalledWith("chat-1", expect.objectContaining({ variantId: "v2" })));
    // A positive hydration (server-owned job in flight) joins the completion-refresh
    // so the generation flag clears when the job settles (step 6).
    await waitFor(() => expect(mocks.startInsightsCompletionRefresh).toHaveBeenCalledWith("chat-1", expect.objectContaining({ variantId: "v2" })));
  });

  it("desktop roster keeps Save and Cancel outside the fields scroll region", () => {
    seed([msg("m1", { variantId: "v1", rec: rosterRecord() })]);
    const view = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(view.getByLabelText("scn_zone_expand"));
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    const panel = view.getByTestId("modal").firstElementChild!;
    expect(panel.classList.contains("flex-col")).toBe(true);
    expect(panel.classList.contains("overflow-hidden")).toBe(true);
    expect(panel.classList.contains("overflow-y-auto")).toBe(false);
    // CNR-8p: the fields scroller is the shared thin ScrollArea lane (3px
    // rest / 5px hover) instead of the native overflow-y-auto fallback.
    const fields = panel.querySelector('[data-scroll-area="thin"]:not([data-scroll-editor])')!;
    expect(fields).not.toBeNull();
    expect(fields.classList.contains("min-h-0")).toBe(true);
    expect(fields.querySelectorAll("textarea").length).toBe(48);
    const save = view.getByRole("button", { name: "scn_edit_save" });
    const cancel = view.getByRole("button", { name: "scn_edit_cancel" });
    expect(fields.contains(save)).toBe(false);
    expect(fields.contains(cancel)).toBe(false);
    expect(save.parentElement?.classList.contains("shrink-0")).toBe(true);
    expect(fields.parentElement).toBe(save.parentElement!.parentElement);
    fireEvent.change(view.getByDisplayValue("applicant 1"), { target: { value: "edited applicant" } });
    fireEvent.click(cancel);
    expect(view.queryByTestId("modal")).toBeNull();
    expect(mocks.editSceneAction).not.toHaveBeenCalled();
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    expect(view.getByDisplayValue("applicant 1")).toBeTruthy();
    fireEvent.change(view.getByDisplayValue("applicant 1"), { target: { value: "edited applicant" } });
    fireEvent.click(view.getByRole("button", { name: "scn_edit_save" }));
    const expected = rosterRecord().sceneState;
    (expected.applicantRoster as Record<string, unknown>[])[0].applicant = "edited applicant";
    expect(mocks.editSceneAction).toHaveBeenCalledWith("chat-1", { branchId: "b1", messageId: "m1", variantId: "v1" }, expected);
    expect(useSnapshotStore.getState().messagesById.m1.sceneTracker?.sceneState).toEqual(rosterRecord().sceneState);
  });

  it("mobile roster bounds the sheet content and keeps the footer outside scrolling fields", () => {
    isMobile = true;
    seed([msg("m1", { variantId: "v1", rec: rosterRecord() })]);
    const view = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(view.getByLabelText("scn_zone_expand"));
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    expect(view.queryByTestId("modal")).toBeNull();
    const cap = view.getByTestId("sheet").firstElementChild!;
    expect(cap.classList.contains("max-h-[80dvh]")).toBe(true);
    expect(cap.classList.contains("flex-col")).toBe(true);
    expect(cap.classList.contains("overflow-hidden")).toBe(true);
    // CNR-8p: same thin lane under the sheet (the lane chrome hides on
    // phones per the CNR-7g policy; the native viewport keeps scrolling).
    const fields = cap.querySelector('[data-scroll-area="thin"]:not([data-scroll-editor])')!;
    expect(fields).not.toBeNull();
    expect(fields.querySelectorAll("textarea").length).toBe(48);
    const save = view.getByRole("button", { name: "scn_edit_save" });
    const cancel = view.getByRole("button", { name: "scn_edit_cancel" });
    expect(fields.contains(save)).toBe(false);
    expect(fields.contains(cancel)).toBe(false);
    expect(fields.parentElement).toBe(save.parentElement!.parentElement);
    expect(save.parentElement?.classList.contains("shrink-0")).toBe(true);
    fireEvent.click(cancel);
    expect(view.queryByTestId("sheet")).toBeNull();
    expect(mocks.editSceneAction).not.toHaveBeenCalled();
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    fireEvent.click(view.getByRole("button", { name: "scn_edit_save" }));
    expect(mocks.editSceneAction).toHaveBeenCalledWith("chat-1", { branchId: "b1", messageId: "m1", variantId: "v1" }, rosterRecord().sceneState);
  });

  it("object array items are numbered groups with header-local removal and preserve neighboring values", () => {
    seed([msg("m1", { variantId: "v1", rec: rosterRecord() })]);
    const view = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(view.getByLabelText("scn_zone_expand"));
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    const panel = view.getByTestId("modal");
    const groups = panel.querySelectorAll("fieldset");
    expect(groups.length).toBe(12);
    for (const [i, group] of Array.from(groups).entries()) {
      expect(group.classList.contains("border-border")).toBe(true);
      expect(group.querySelector("legend")?.textContent).toBe(`applicantRoster ${i + 1}`);
      expect(group.querySelectorAll("textarea").length).toBe(4);
      const remove = group.querySelector('legend button[aria-label="scn_edit_remove_item"]')!;
      expect(remove).not.toBeNull();
      expect(remove.querySelector("svg")).not.toBeNull();
      expect(remove.textContent).not.toContain("✕");
    }
    fireEvent.change(view.getByDisplayValue("applicant 2"), { target: { value: "kept edit" } });
    fireEvent.click(view.getAllByRole("button", { name: "scn_edit_remove_item" })[0]);
    expect(view.queryByDisplayValue("applicant 1")).toBeNull();
    expect(view.getByDisplayValue("kept edit")).toBeTruthy();
    expect(panel.querySelectorAll("fieldset").length).toBe(11);
    expect(panel.querySelector("legend")?.textContent).toBe("applicantRoster 1");
    fireEvent.click(view.getByRole("button", { name: "+ scn_edit_add_item" }));
    expect(panel.querySelectorAll("fieldset").length).toBe(12);
    const expected = rosterRecord().sceneState.applicantRoster as Record<string, unknown>[];
    expected.shift();
    expected[0].applicant = "kept edit";
    expected.push({});
    fireEvent.click(view.getByRole("button", { name: "scn_edit_save" }));
    expect(mocks.editSceneAction).toHaveBeenCalledWith("chat-1", { branchId: "b1", messageId: "m1", variantId: "v1" }, { applicantRoster: expected });
  });

  it("leaf arrays keep compact rows and add, edit, remove, and save without object cards", () => {
    const rec = { ...record("v1", { tags: ["first", "second"] }), schema: { tags: { $type: "array", items: { $type: "string" } } } satisfies SceneTrackerDsl };
    seed([msg("m1", { variantId: "v1", rec })]);
    const view = render(createElement(SceneZone, { chatId: "chat-1", messageId: "m1" }));
    fireEvent.click(view.getByLabelText("scn_zone_expand"));
    fireEvent.click(view.getByLabelText("scn_zone_edit"));
    const panel = view.getByTestId("modal");
    expect(panel.querySelector("fieldset")).toBeNull();
    const remove = view.getAllByRole("button", { name: "scn_edit_remove_item" })[0];
    expect(remove.parentElement?.classList.contains("items-center")).toBe(true);
    fireEvent.click(remove);
    fireEvent.change(view.getByDisplayValue("second"), { target: { value: "edited" } });
    fireEvent.click(view.getByRole("button", { name: "+ scn_edit_add_item" }));
    expect(panel.querySelectorAll("textarea").length).toBe(2);
    expect(panel.querySelector("fieldset")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "scn_edit_save" }));
    expect(mocks.editSceneAction).toHaveBeenCalledWith("chat-1", { branchId: "b1", messageId: "m1", variantId: "v1" }, { tags: ["edited", ""] });
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
