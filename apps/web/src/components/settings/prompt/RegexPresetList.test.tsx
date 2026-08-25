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
  { id: "r1", name: "Alpha", disabled: false, notApplied: null },
  { id: "r2", name: "Beta", disabled: false, notApplied: null },
  { id: "r3", name: "Gamma", disabled: true, notApplied: null },
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

// ── R-7 owner follow-up: status dot (green/red/gray) instead of the text
// badge that overlapped names; reason rides in the tooltip / aria-label. ──
describe("RegexPresetList — status dot (R-7)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("renders a green dot for in-effect presets and no text badge", () => {
    render(<RegexPresetList {...baseProps()} />);
    // useT is mocked to keys — labels come back as the key strings.
    const dot = screen.getAllByLabelText("promptManager.regex.badgeWorking")[0];
    expect(dot.querySelector("span")!.className).toContain("bg-success");
    // The text badge is gone from the list (it overlapped names) — the
    // «Не применяется» label now lives in the EDITOR only.
    expect(screen.queryByText("promptManager.regex.badgeNotApplied")).toBeNull();
  });

  it("renders a gray dot for disabled and a red dot for unbound presets", () => {
    render(
      <RegexPresetList
        {...baseProps({
          presets: [
            { id: "r1", name: "Alpha", disabled: false, notApplied: null },
            { id: "r2", name: "Beta", disabled: true, notApplied: "disabled" },
            { id: "r3", name: "Gamma", disabled: false, notApplied: "unbound" },
          ],
        })}
      />,
    );
    const gray = screen.getByLabelText("promptManager.regex.badgeDisabledReason");
    expect(gray.querySelector("span")!.className).toContain("bg-t4");
    const red = screen.getByLabelText("promptManager.regex.badgeUnboundReason");
    expect(red.querySelector("span")!.className).toContain("bg-danger");
    // Reasons stay in tooltips, not visible text.
    expect(screen.queryByText("promptManager.regex.badgeDisabledReason")).toBeNull();
    expect(screen.queryByText("promptManager.regex.badgeUnboundReason")).toBeNull();
  });
});

// ── R-12 → footer: per-row Copy & Export REMOVED (owner correction) ────────
// Copy/export now live in the regex-tab footer acting on the SELECTED rule —
// exactly like the presets tab's duplicate/export (the new boundary is pinned
// in PromptManagerModal.test.tsx). This block pins the removal: no per-row
// affordances may creep back into the list rows.
describe("RegexPresetList — no per-row copy/export (R-12 → footer)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("renders no copy/export buttons in rows", () => {
    render(<RegexPresetList {...baseProps()} />);
    expect(screen.queryByLabelText("promptManager.regex.copy")).toBeNull();
    expect(screen.queryByLabelText("promptManager.regex.export")).toBeNull();
  });
});

// ── R-13b: profiles, expand/collapse, shadowed dot, triad, create blocks ──
describe("RegexPresetList — profiles (R-13b)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  const profileA: any = { id: "p1", name: "Profa", disabled: false, isGlobal: true, sortOrder: 0, notApplied: null, memberCount: 1 };
  const profileB: any = { id: "p2", name: "Profb", disabled: true, notApplied: "disabled", isGlobal: false, sortOrder: 1, memberCount: 0 };
  const memberPresets: any = [
    { id: "r1", name: "Stand", disabled: false, notApplied: null, profileId: null, sortOrder: 1 },
    { id: "r2", name: "Mem", disabled: false, notApplied: null, profileId: "p1", sortOrder: 0, shadowed: true },
  ];

  it("renders profiles interleaved with standalone rules", () => {
    render(<RegexPresetList {...baseProps({ presets: memberPresets, profiles: [profileA, profileB] })} />);
    expect(screen.getByText("Profa")).toBeTruthy();
    expect(screen.getByText("Profb")).toBeTruthy();
    expect(screen.getByText("Stand")).toBeTruthy();
    // member hidden when collapsed
    expect(screen.queryByText("Mem")).toBeNull();
  });

  it("expand shows members and + rule", async () => {
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps({ presets: memberPresets, profiles: [profileA] })} />);
    expect(screen.queryByText("Mem")).toBeNull();
    const expandBtn = screen.getByLabelText("promptManager.regex.expandProfile");
    await user.click(expandBtn);
    expect(screen.getByText("Mem")).toBeTruthy();
    expect(screen.getByText("promptManager.regex.memberNewRule")).toBeTruthy();
    const collapseBtn = screen.getByLabelText("promptManager.regex.collapseProfile");
    await user.click(collapseBtn);
    expect(screen.queryByText("Mem")).toBeNull();
  });

  it("renders shadowed red dot for member with own binding", async () => {
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps({ presets: memberPresets, profiles: [profileA] })} />);
    await user.click(screen.getByLabelText("promptManager.regex.expandProfile"));
    const dot = screen.getByLabelText("promptManager.regex.memberShadowed");
    expect(dot.querySelector("span")!.className).toContain("bg-danger");
  });

  it("renders triad dots for profiles (green/gray)", () => {
    render(<RegexPresetList {...baseProps({ presets: [], profiles: [profileA, profileB] })} />);
    const green = screen.getAllByLabelText("promptManager.regex.badgeWorking")[0];
    expect(green.querySelector("span")!.className).toContain("bg-success");
    const gray = screen.getByLabelText("promptManager.regex.badgeDisabledReason");
    expect(gray.querySelector("span")!.className).toContain("bg-t4");
  });

  it("renders two create blocks", () => {
    render(<RegexPresetList {...baseProps({ presets: memberPresets, profiles: [profileA] })} />);
    expect(screen.getByText("promptManager.regex.newPreset")).toBeTruthy();
    expect(screen.getByText("promptManager.regex.newProfile")).toBeTruthy();
  });

  it("renames a profile", async () => {
    const onRenameProfile = mock();
    const user = userEvent.setup();
    render(<RegexPresetList {...baseProps({ presets: memberPresets, profiles: [profileA], onRenameProfile })} />);
    const row = screen.getByText("Profa").closest("div.group") as HTMLElement;
    const editBtn = within(row).getAllByRole("button").find((b) => b.textContent === "" || b.querySelector("svg"))!;
    // Find edit button (second button after drag+caret) - use getAll and pick edit
    const buttons = within(row).getAllByRole("button");
    // profile row: drag, caret, edit, drill -> edit is index 2
    await user.click(buttons[2]);
    const input = screen.getByDisplayValue("Profa") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed{enter}");
    expect(onRenameProfile).toHaveBeenCalledWith("p1", "Renamed");
  });
});

