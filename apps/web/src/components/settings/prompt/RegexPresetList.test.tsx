import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ComponentProps } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";

useDomEnv();
const { act, render, within } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realSortable = await import("@dnd-kit/sortable");
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

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
mock.module("@dnd-kit/core", () => ({
  ...realDndKit,
  DndContext: (props: RealDndContextProps) => {
    dndHandlers = props;
    return <RealDndContext {...props} />;
  },
}));

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
  beforeEach(() => {
    mock.clearAllMocks();
    dndHandlers = null;
  });

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

  it("shows the standalone target only while dragging a member Rule", () => {
    const view = render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} />);
    const start = (id: string) => ({ active: { id } }) as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    const end = (id: string) => ({ active: { id }, over: null }) as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];

    expect(view.queryByTestId("regex-standalone-drop")).toBeNull();
    act(() => { dndHandlers!.onDragStart!(start("rule:r1")); });
    expect(view.queryByTestId("regex-standalone-drop")).toBeNull();
    act(() => { dndHandlers!.onDragEnd!(end("rule:r1")); });
    act(() => { dndHandlers!.onDragStart!(start("rule:r2")); });
    expect(view.getByTestId("regex-standalone-drop")).toBeTruthy();
    act(() => { dndHandlers!.onDragEnd!(end("rule:r2")); });
    expect(view.queryByTestId("regex-standalone-drop")).toBeNull();
  });

  it("detaches a member through the standalone target with no standalone Rules", () => {
    const onDetach = mock();
    const onlyProfile = profile("p1", "Only profile");
    const view = render(<RegexPresetList {...baseProps({
      presets: [rule("r1", "Only member", { profileId: onlyProfile.id })],
      profiles: [onlyProfile],
      expandedProfileIds: ["p1"],
      onDetach,
    })} />);
    const start = { active: { id: "rule:r1" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    const over = { active: { id: "rule:r1" }, over: { id: "regex:standalone" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragOver"]>>[0];
    const end = { active: { id: "rule:r1" }, over: { id: "regex:standalone" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];

    act(() => { dndHandlers!.onDragStart!(start); });
    const target = view.getByTestId("regex-standalone-drop");
    expect(target.className).toContain("border border-dashed border-border2");
    act(() => { dndHandlers!.onDragOver!(over); });
    expect(target.className).toContain("border-accent");
    expect(target.className).toContain("bg-accent-dim");
    act(() => { dndHandlers!.onDragEnd!(end); });
    expect(onDetach).toHaveBeenCalledWith("r1");
    expect(view.queryByTestId("regex-standalone-drop")).toBeNull();
  });

  it("preserves top-level reorder, attachment, within-Profile reorder, and invalid-drop no-op", () => {
    const topLevelReorder = mock();
    render(<RegexPresetList {...baseProps({ onReorder: topLevelReorder })} />);
    const topLevelEnd = { active: { id: "rule:r1" }, over: { id: "rule:r2" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragEnd!(topLevelEnd); });
    expect(topLevelReorder).toHaveBeenCalledWith([
      { id: "r2", sortOrder: 0 },
      { id: "r1", sortOrder: 1 },
      { id: "r3", sortOrder: 2 },
    ]);

    const onAttach = mock();
    const attachReorder = mock();
    render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} onAttach={onAttach} onReorder={attachReorder} />);
    const attachEnd = { active: { id: "rule:r1" }, over: { id: "profile:p1" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragEnd!(attachEnd); });
    expect(onAttach).toHaveBeenCalledWith("p1", "r1");
    expect(attachReorder).toHaveBeenCalledWith([
      { id: "r1", sortOrder: 0 },
      { id: "r2", sortOrder: 1 },
      { id: "r3", sortOrder: 2 },
    ]);

    const memberReorder = mock();
    render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} onReorder={memberReorder} />);
    const memberEnd = { active: { id: "rule:r2" }, over: { id: "rule:r3" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragEnd!(memberEnd); });
    expect(memberReorder).toHaveBeenCalledWith([
      { id: "r3", sortOrder: 0 },
      { id: "r2", sortOrder: 1 },
    ]);

    const invalidReorder = mock();
    render(<RegexPresetList {...baseProps({ onReorder: invalidReorder })} />);
    const invalidEnd = { active: { id: "rule:r1" }, over: null } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragEnd!(invalidEnd); });
    expect(invalidReorder).not.toHaveBeenCalled();
  });
});
