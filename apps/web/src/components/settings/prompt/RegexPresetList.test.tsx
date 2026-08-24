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

// useMasterDetail is context-bound; stub it so the list renders standalone.
mock.module("../../shared/MasterDetailModal.js", () => ({
    ...realMasterDetailModal,
    MasterDetailMobileDrillDown: ({ onSelect, className }: { onSelect: () => void; className?: string }) => (
      <button onClick={onSelect} className={className}>drill</button>
    ),
}));

// CustomTooltip wraps Radix's Tooltip (needs TooltipProvider) — bare wrapper.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ content, children }: { content?: string; children: React.ReactNode }) => <>{children}</>,
}));

// Stub useSortable so dnd-kit works without a real DOM sensor setup.
mock.module("@dnd-kit/sortable", () => ({
  ...realSortable,
  useSortable,
}));

let RegexPresetList: typeof import("./RegexPresetList.js").RegexPresetList;
beforeAll(async () => {
  ({ RegexPresetList } = await import("./RegexPresetList.js"));
});

const basePresets = [
  { id: "r1", name: "Alpha", disabled: false },
  { id: "r2", name: "Beta", disabled: false },
  { id: "r3", name: "Gamma", disabled: true },
];

function baseProps(overrides: Partial<Parameters<typeof RegexPresetList>[0]> = {}) {
  return {
    presets: basePresets,
    activePresetId: "r2",
    onSelect: mock(),
    onAdd: mock(),
    onRename: mock(),
    onReorder: mock(),
    ...overrides,
  };
}

describe("RegexPresetList", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("renders presets with names and drag handles", () => {
    render(<RegexPresetList {...baseProps()} />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.getAllByLabelText("drag")).toHaveLength(3);
  });

  it("dims disabled presets", () => {
    render(<RegexPresetList {...baseProps()} />);
    const gammaRow = screen.getByText("Gamma").closest("div")!;
    const nameSpan = within(gammaRow).getByText("Gamma");
    expect(nameSpan.className).toContain("opacity-50");
  });

  it("shows empty state when the list is empty", () => {
    render(<RegexPresetList {...baseProps({ presets: [] })} />);
    expect(screen.getByText("promptManager.regex.emptyTitle")).toBeTruthy();
    expect(screen.getByText("promptManager.regex.emptySub")).toBeTruthy();
  });

  it("hides drag handles while a search filter is active", async () => {
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps()} />);
    const searchInput = screen.getByPlaceholderText("search_presets");
    await user.type(searchInput, "Beta");
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByLabelText("drag")).toBeNull();
  });

  it("calls onAdd with the entered name when creating a new preset", async () => {
    const onAdd = mock();
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps({ onAdd })} />);
    await user.click(screen.getByText("promptManager.regex.newPreset"));
    const input = screen.getByPlaceholderText("promptManager.regex.newNamePlaceholder") as HTMLInputElement;
    await user.type(input, "Delta{enter}");
    expect(onAdd).toHaveBeenCalledWith("Delta");
  });

  it("enters rename mode on edit button click and calls onRename on save", async () => {
    const onRename = mock();
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps({ onRename })} />);
    const alphaRow = screen.getByText("Alpha").closest("div.group") as HTMLElement;
    const editBtn = within(alphaRow).getAllByRole("button")[1]; // skip drag handle
    await user.click(editBtn);
    const input = screen.getByDisplayValue("Alpha") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed{enter}");
    expect(onRename).toHaveBeenCalledWith("r1", "Renamed");
  });
});
