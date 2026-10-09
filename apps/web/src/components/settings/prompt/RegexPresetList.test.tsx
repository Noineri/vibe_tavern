import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";

useDomEnv();
const { render, within } = await import("@testing-library/react");
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
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetailModal,
  MasterDetailMobileDrillDown: ({ onSelect, className }: { onSelect: () => void; className?: string }) => (
    <button type="button" onClick={onSelect} className={className}>drill</button>
  ),
}));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("@dnd-kit/sortable", () => ({ ...realSortable, useSortable }));

let RegexPresetList: typeof import("./RegexPresetList.js").RegexPresetList;
beforeAll(async () => {
  ({ RegexPresetList } = await import("./RegexPresetList.js"));
});

function rule(id: string, name: string, overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>(id),
    name,
    findRegex: "/foo/g",
    replaceString: "bar",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: true,
    sortOrder: 0,
    profileId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function profile(id: string, name: string, overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>(id),
    name,
    disabled: false,
    isGlobal: true,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const basePresets = [rule("r1", "Alpha"), rule("r2", "Beta", { sortOrder: 1 }), rule("r3", "Gamma", { disabled: true, sortOrder: 2 })];

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

function nestedProps() {
  const first = profile("p1", "First profile");
  const second = profile("p2", "Second profile", { sortOrder: 1 });
  return baseProps({
    presets: [
      rule("r1", "Standalone", { sortOrder: 2 }),
      rule("r2", "Member needle", { profileId: first.id }),
      rule("r3", "Other member", { profileId: first.id, sortOrder: 1 }),
      rule("r4", "Second member", { profileId: second.id }),
    ],
    profiles: [first, second],
  });
}

describe("RegexPresetList", () => {
  beforeEach(() => mock.clearAllMocks());

  it("keeps manual expand/collapse and drag handles available without a filter", async () => {
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...nestedProps()} />);
    expect(view.queryByText("Member needle")).toBeNull();
    expect(view.getAllByLabelText("promptManager.regex.dragAria")).toHaveLength(3);
    await user.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]!);
    expect(view.getByText("Member needle")).toBeTruthy();
  });

  it("uses the shared grip icon in a 44px mobile target", () => {
    const view = render(<RegexPresetList {...baseProps()} />);
    const handle = view.getAllByLabelText("promptManager.regex.dragAria")[0]!;
    expect(handle.className).toContain("h-11");
    expect(handle.className).toContain("w-11");
    expect(handle.querySelector("svg")).toBeTruthy();
  });

  it("reveals a matching member with its parent while hiding non-matching members", async () => {
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...nestedProps()} />);
    await user.type(view.getByPlaceholderText("promptManager.regex.searchPlaceholder"), "needle");
    expect(view.getByText("First profile")).toBeTruthy();
    expect(view.getByText("Member needle")).toBeTruthy();
    expect(view.queryByText("Other member")).toBeNull();
    expect(view.queryByText("Second profile")).toBeNull();
  });

  it("reveals every member for a matching profile", async () => {
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...nestedProps()} />);
    await user.type(view.getByPlaceholderText("promptManager.regex.searchPlaceholder"), "first");
    expect(view.getByText("Member needle")).toBeTruthy();
    expect(view.getByText("Other member")).toBeTruthy();
    expect(view.queryByText("Second member")).toBeNull();
  });

  it("clearing search restores an empty manual expansion set", async () => {
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...nestedProps()} />);
    const search = view.getByPlaceholderText("promptManager.regex.searchPlaceholder");
    await user.type(search, "needle");
    expect(view.getByText("Member needle")).toBeTruthy();
    await user.clear(search);
    expect(view.queryByText("Member needle")).toBeNull();
  });

  it("clearing search restores every manually expanded profile", async () => {
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...nestedProps()} />);
    const expand = view.getAllByLabelText("promptManager.regex.expandProfile");
    await user.click(expand[0]!);
    await user.click(view.getByLabelText("promptManager.regex.expandProfile"));
    const search = view.getByPlaceholderText("promptManager.regex.searchPlaceholder");
    await user.type(search, "needle");
    await user.clear(search);
    expect(view.getByText("Member needle")).toBeTruthy();
    expect(view.getByText("Second member")).toBeTruthy();
  });

  it("disables reordering while filtering", async () => {
    const onReorder = mock();
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...baseProps({ onReorder })} />);
    await user.type(view.getByPlaceholderText("promptManager.regex.searchPlaceholder"), "Beta");
    expect(view.queryByLabelText("promptManager.regex.dragAria")).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("renames a rule from its row", async () => {
    const onRename = mock();
    const user = userEvent.setup();
    const view = render(<RegexPresetList {...baseProps({ onRename })} />);
    const row = view.getByText("Alpha").closest("div.group") as HTMLElement;
    const buttons = within(row).getAllByRole("button");
    await user.click(buttons[1]!);
    const input = view.getByDisplayValue("Alpha") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed{enter}");
    expect(onRename).toHaveBeenCalledWith("r1", "Renamed");
  });
});
