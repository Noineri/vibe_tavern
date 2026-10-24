import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ComponentProps } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render, within } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
const realMobileHook = await import("../../../hooks/use-mobile.js");
// Co-load contract (master-list.test.tsx + ProviderProfileList.test.tsx
// register the SAME mock for @dnd-kit/core; Bun's mock.module is
// process-global, last-write-wins — the factories must stay shape-identical
// so either registration order is safe). @dnd-kit/sortable is NOT mocked:
// ML-2 moved the sortable wiring into the primitive, so this suite renders
// the real useSortable through SortableMasterListPhoneRow (only `arrayMove`
// is consumed here, for the reorder payload math).
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;
const mobileState = { isMobile: false };

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => mobileState.isMobile,
}));

// The rows render the REAL MasterDetailMobileDrillDown (ML-1 precedent: a
// label-less `drill` stub diverged from master-list.test.tsx's mock and
// poisoned its co-load run). The hook mock carries the full context shape so
// either registration order renders the same caret. Shape-identical with
// master-list.test.tsx (co-load contract: last-write-wins).
mock.module("../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetailModal,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));

mock.module("@dnd-kit/core", () => ({
  ...realDndKit,
  // Preserve dnd-kit's provider while exposing the exact drag-end boundary
  // without fragile pointer simulation in happy-dom.
  DndContext: (props: RealDndContextProps) => {
    dndHandlers = props;
    return <RealDndContext {...props} />;
  },
  // DragOverlay mounts children only while dnd-kit's INTERNAL active state
  // is set; the captured-handler pattern drives the hook state, never the
  // internal one — so the preview renders inline here. Shape-identical with
  // master-list.test.tsx (co-load contract: last-write-wins).
  DragOverlay: (props: RealDragOverlayProps) => <>{props.children}</>,
}));

let PresetList: typeof import("./PresetList.js").PresetList;
beforeAll(async () => {
  ({ PresetList } = await import("./PresetList.js"));
});

const basePresets = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
  { id: "p3", name: "Gamma" },
];

function baseProps(overrides: Partial<Parameters<typeof PresetList>[0]> = {}) {
  return {
    presets: basePresets,
    activePresetId: "p2",
    onSelect: mock(),
    onAdd: mock(),
    onRename: mock(),
    onReorder: mock(),
    ...overrides,
  };
}

describe("PresetList", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    dndHandlers = null;
  });

  afterEach(() => {
    mobileState.isMobile = false;
  });

  it("renders presets with names and a drag handle on each row", () => {
    const view = render(<PresetList {...baseProps()} />);
    expect(view.getByText("Alpha")).toBeTruthy();
    expect(view.getByText("Beta")).toBeTruthy();
    expect(view.getByText("Gamma")).toBeTruthy();
    // Each row gets a ≡ handle (three rows → three handles).
    const handles = view.getAllByLabelText("drag");
    expect(handles).toHaveLength(3);
  });

  it("marks the active preset with the status-slot star (never a whole-row color)", () => {
    // Behavior change (was: an active-only dot + accent row; now: ★ lives in
    // the primitive's status slot per MASTER_LIST_PRIMITIVE_PLAN row rules,
    // selection stays the primitive's accent look).
    const view = render(<PresetList {...baseProps({ activePresetId: "p1" })} />);
    expect(view.getByText("Alpha")).toBeTruthy();
    expect(view.getByText("★")).toBeTruthy();
  });

  it("wraps the title instead of truncating it", () => {
    // Behavior change (was: `truncate` title in a tooltip; now: `break-words`
    // wrap per MASTER_LIST_PRIMITIVE_PLAN row rules — authored names are UI
    // copy, and UI copy is never truncated).
    const view = render(<PresetList {...baseProps()} />);
    const title = view.getByText("Alpha");
    expect(title.classList.contains("truncate")).toBe(false);
    expect(title.classList.contains("break-words")).toBe(true);
  });

  it("renders the drag preview through the primitive overlay", () => {
    const view = render(<PresetList {...baseProps()} />);
    expect(view.getAllByText("Alpha")).toHaveLength(1);
    const start = { active: { id: "p1" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    const end = { active: { id: "p1" }, over: null } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragStart!(start); });
    // Row + inline overlay preview (the DragOverlay mock renders inline —
    // the ML-1 rework-2 lesson: the preview must exist during a drag).
    expect(view.getAllByText("Alpha")).toHaveLength(2);
    act(() => { dndHandlers!.onDragEnd!(end); });
  });

  it("shows empty state when the list is empty", () => {
    const view = render(<PresetList {...baseProps({ presets: [] })} />);
    expect(view.getByText("no_presets")).toBeTruthy();
    expect(view.getByText("no_presets_sub")).toBeTruthy();
  });

  it("hides drag handles while a search filter is active", async () => {
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps()} />);
    const searchInput = view.getByPlaceholderText("search_presets");
    await user.type(searchInput, "Beta");
    // Only Beta matches → one row rendered; no drag handle (dndDisabled = true).
    expect(view.getByText("Beta")).toBeTruthy();
    expect(view.queryByLabelText("drag")).toBeNull();
  });

  it("calls onAdd with the entered name when creating a new preset", async () => {
    const onAdd = mock();
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps({ onAdd })} />);
    await user.click(view.getByText("new_preset_btn"));
    const input = view.getByPlaceholderText("new_preset_name_placeholder") as HTMLInputElement;
    await user.type(input, "Delta{enter}");
    expect(onAdd).toHaveBeenCalledWith("Delta");
  });

  it("enters rename mode on edit button click and calls onRename on save", async () => {
    const onRename = mock();
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps({ onRename })} />);
    // Find the edit button inside Alpha's row. The row has two edit buttons
    // (mobile md:hidden + desktop hidden md:flex); both are in the DOM, so
    // user.click will target whichever is visible. In jsdom (no media queries
    // applied), both are "visible" by RTL criteria; user-event picks the first.
    const alphaRow = view.getByText("Alpha").closest("div.group") as HTMLElement;
    const editBtn = within(alphaRow).getAllByRole("button")[1]; // skip drag handle
    await user.click(editBtn);
    const input = view.getByDisplayValue("Alpha") as HTMLInputElement;
    // Clear and type new name, submit with Enter.
    await user.clear(input);
    await user.type(input, "Alpha Prime{enter}");
    expect(onRename).toHaveBeenCalledWith("p1", "Alpha Prime");
  });

  it("shows no-matches empty state when search yields nothing", async () => {
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps()} />);
    await user.type(view.getByPlaceholderText("search_presets"), "ZZZ");
    expect(view.getByText("no_preset_matches")).toBeTruthy();
    expect(view.getByText("no_preset_matches_sub")).toBeTruthy();
  });

  it("renders an import button when onImportPreset is provided", async () => {
    const onImportPreset = mock();
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps({ onImportPreset })} />);
    const importBtn = view.getByText("import_preset_btn");
    await user.click(importBtn);
    expect(onImportPreset).toHaveBeenCalledTimes(1);
  });

  it("opens the native picker and forwards its file from the mobile import action", async () => {
    mobileState.isMobile = true;
    const onImportPreset = mock();
    const user = userEvent.setup();
    const view = render(<PresetList {...baseProps({ onImportPreset })} />);
    const input = view.container.querySelector("input[type='file']");
    if (!(input instanceof HTMLInputElement)) throw new Error("preset import input missing");
    const click = mock(() => {});
    input.click = click;

    await user.click(view.getByText("import_preset_btn"));
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(["{}"], "preset.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    expect(onImportPreset).toHaveBeenCalledWith(file);
  });
});
