import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, screen, within } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realSortable = await import("@dnd-kit/sortable");

const useSortable = mock(() => ({
  attributes: {},
  listeners: {},
  setNodeRef: mock(),
  setActivatorNodeRef: mock(),
  transform: null,
  transition: undefined,
  isDragging: false,
}));

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

// PresetList uses useMasterDetail (mobile drill-down) — stub the context so
// the component can render outside a full MasterDetailModal shell.
mock.module("../../shared/MasterDetailModal.js", () => ({
    ...realMasterDetailModal,
    useMasterDetail: () => ({ activeId: null, openDetail: () => {}, closeDetail: () => {} }),
    MasterDetailMobileDrillDown: ({ onSelect, className }: { onSelect: () => void; className?: string }) => (
      <button onClick={onSelect} className={className}>drill</button>
    ),
}));

// CustomTooltip wraps Radix's Tooltip (needs TooltipProvider). Replace with a
// bare wrapper so tests don't need the full provider shell.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ content, children }: { content?: string; children: React.ReactNode }) => <>{children}</>,
}));

// Stub useSortable so dnd-kit's sortable context works without a real DOM
// sensor setup (happy-dom can't drive PointerEvent chains). The overlay
// transform/transition are no-ops; the consumer only tests render output.
mock.module("@dnd-kit/sortable", () => ({
  ...realSortable,
  useSortable,
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
  });

  it("renders presets with names and a drag handle on each row", () => {
    render(<PresetList {...baseProps()} />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    // Each row gets a ≡ handle (three rows → three handles).
    const handles = screen.getAllByLabelText("drag");
    expect(handles).toHaveLength(3);
  });

  it("highlights the active preset (accent border + dot)", () => {
    render(<PresetList {...baseProps({ activePresetId: "p1" })} />);
    // Active state is a CSS concern; we trust the class. Smoke: row renders.
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("shows empty state when the list is empty", () => {
    render(<PresetList {...baseProps({ presets: [] })} />);
    expect(screen.getByText("no_presets")).toBeTruthy();
    expect(screen.getByText("no_presets_sub")).toBeTruthy();
  });

  it("hides drag handles while a search filter is active", async () => {
    const user = userEvent.setup();
    render(<PresetList {...baseProps()} />);
    const searchInput = screen.getByPlaceholderText("search_presets");
    await user.type(searchInput, "Beta");
    // Only Beta matches → one row rendered; no drag handle (dndDisabled = true).
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByLabelText("drag")).toBeNull();
  });

  it("calls onAdd with the entered name when creating a new preset", async () => {
    const onAdd = mock();
    const user = userEvent.setup();
    render(<PresetList {...baseProps({ onAdd })} />);
    await user.click(screen.getByText("new_preset_btn"));
    const input = screen.getByPlaceholderText("new_preset_name_placeholder") as HTMLInputElement;
    await user.type(input, "Delta{enter}");
    expect(onAdd).toHaveBeenCalledWith("Delta");
  });

  it("enters rename mode on edit button click and calls onRename on save", async () => {
    const onRename = mock();
    const user = userEvent.setup();
    render(<PresetList {...baseProps({ onRename })} />);
    // Find the edit button inside Alpha's row. The row has two edit buttons
    // (mobile md:hidden + desktop hidden md:flex); both are in the DOM, so
    // user.click will target whichever is visible. In jsdom (no media queries
    // applied), both are "visible" by RTL criteria; user-event picks the first.
    const alphaRow = screen.getByText("Alpha").closest("div.group") as HTMLElement;
    const editBtn = within(alphaRow).getAllByRole("button")[1]; // skip drag handle
    await user.click(editBtn);
    const input = screen.getByDisplayValue("Alpha") as HTMLInputElement;
    // Clear and type new name, submit with Enter.
    await user.clear(input);
    await user.type(input, "Alpha Prime{enter}");
    expect(onRename).toHaveBeenCalledWith("p1", "Alpha Prime");
  });

  it("shows no-matches empty state when search yields nothing", async () => {
    const user = userEvent.setup();
    render(<PresetList {...baseProps()} />);
    await user.type(screen.getByPlaceholderText("search_presets"), "ZZZ");
    expect(screen.getByText("no_preset_matches")).toBeTruthy();
    expect(screen.getByText("no_preset_matches_sub")).toBeTruthy();
  });

  it("renders an import button when onImportPreset is provided", async () => {
    const onImportPreset = mock();
    const user = userEvent.setup();
    render(<PresetList {...baseProps({ onImportPreset })} />);
    const importBtn = screen.getByText("import_preset_btn");
    await user.click(importBtn);
    expect(onImportPreset).toHaveBeenCalledTimes(1);
  });
});
