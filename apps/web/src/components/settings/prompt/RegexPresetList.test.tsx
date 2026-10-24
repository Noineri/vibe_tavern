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
// Co-load contract (master-list.test.tsx + ProviderProfileList.test.tsx +
// PresetList.test.tsx register the SAME mock for @dnd-kit/core; Bun's
// mock.module is process-global, last-write-wins — the factories must stay
// shape-identical so either registration order is safe). @dnd-kit/sortable
// is NOT mocked: ML-2 moved the sortable wiring into the primitive, so this
// suite renders the real useSortable through SortableMasterListPhoneRow
// (only `arrayMove` is consumed here, for the reorder payload math).
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === "promptManager.regex.availabilityActiveRules"
        ? `${key}:${options?.count ?? 0}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
// The rows render the REAL MasterDetailMobileDrillDown (ML-1 precedent: a
// label-less `drill` stub diverged from master-list.test.tsx's mock and
// poisoned its co-load run). Shape-identical with master-list.test.tsx
// (co-load contract: last-write-wins).
mock.module("../../shared/MasterDetailModal.js", () => ({
  ...realMasterDetailModal,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    // Accordion semantics (owner ruling 2026-10-09): collapsed members stay
    // MOUNTED inside the grid-rows wrapper — hidden via 0fr + aria-hidden,
    // not unmounted (that is what makes the height animation possible).
    const collapsed = view.getByTestId("regex-members-p1");
    expect(collapsed.getAttribute("aria-hidden")).toBe("true");
    expect((collapsed as HTMLElement).style.gridTemplateRows).toBe("0fr");
    // All six rows' handles stay mounted (3 top-level + 3 hidden members);
    // expanding must NOT duplicate them.
    // (Behavior change: the handle is the primitive's ≡, aria "drag" — not
    // the old translated grip label — per MASTER_LIST_PRIMITIVE_PLAN row rules.)
    expect(view.getAllByLabelText("drag")).toHaveLength(6);
    await user.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]!);
    const open = view.getByTestId("regex-members-p1");
    expect(open.getAttribute("aria-hidden")).toBe("false");
    expect((open as HTMLElement).style.gridTemplateRows).toBe("1fr");
    expect(view.getByText("Member needle")).toBeTruthy();
    expect(view.getAllByLabelText("drag")).toHaveLength(6);
  });

  it("uses the primitive handle (≡, drag-only) on every row", () => {
    // Behavior change (was: a translated-label grip icon in a 44px mobile
    // target; now: the primitive's ≡ handle per MASTER_LIST_PRIMITIVE_PLAN
    // row rules — reorder works with the handle only, tapping selects).
    const view = render(<RegexPresetList {...baseProps()} />);
    const handles = view.getAllByLabelText("drag");
    expect(handles).toHaveLength(3);
    for (const handle of handles) expect(handle.textContent).toBe("≡");
  });

  it("wraps rule titles instead of truncating them", () => {
    // Behavior change (was: `truncate` title in a tooltip; now: `break-words`
    // wrap per MASTER_LIST_PRIMITIVE_PLAN row rules — authored names are UI
    // copy, and UI copy is never truncated).
    const view = render(<RegexPresetList {...baseProps()} />);
    const title = view.getByText("Alpha");
    expect(title.classList.contains("truncate")).toBe(false);
    expect(title.classList.contains("break-words")).toBe(true);
  });

  it("renders the drag preview through the primitive overlay", () => {
    const view = render(<RegexPresetList {...baseProps()} />);
    expect(view.getAllByText("Alpha")).toHaveLength(1);
    const start = { active: { id: "rule:r1" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    const end = { active: { id: "rule:r1" }, over: null } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => { dndHandlers!.onDragStart!(start); });
    // Row + inline overlay preview (the DragOverlay mock renders inline —
    // the ML-1 rework-2 lesson: the preview must exist during a drag).
    expect(view.getAllByText("Alpha")).toHaveLength(2);
    act(() => { dndHandlers!.onDragEnd!(end); });
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
    const wrapper = view.getByTestId("regex-members-p1");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect((wrapper as HTMLElement).style.gridTemplateRows).toBe("0fr");
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
    expect(view.queryByLabelText("drag")).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("uses one dot-only indicator with a full accessible name for every Profile status", () => {
    const statuses: Array<{
      name: string;
      profile: RegexProfileRecord;
      presets: RegexPresetRecord[];
      linkCount?: number;
      label: string;
    }> = [
      {
        name: "disabled",
        profile: profile("p-disabled", "Disabled Profile", { disabled: true, isGlobal: false }),
        presets: [],
        linkCount: 0,
        label: "promptManager.regex.availabilityDisabled",
      },
      {
        name: "unbound",
        profile: profile("p-unbound", "Unbound Profile", { isGlobal: false }),
        presets: [],
        linkCount: 0,
        label: "promptManager.regex.availabilityUnbound",
      },
      {
        name: "no enabled Rules",
        profile: profile("p-empty", "Empty Profile"),
        presets: [],
        label: "promptManager.regex.availabilityNoEnabledRules",
      },
      {
        name: "active",
        profile: profile("p-active", "Active Profile"),
        presets: [rule("r-active", "Active member", { profileId: brandId<RegexProfileId>("p-active") })],
        label: "promptManager.regex.availabilityActiveRules:1",
      },
    ];

    for (const status of statuses) {
      const view = render(<RegexPresetList {...baseProps({
        presets: status.presets,
        profiles: [status.profile],
        regexProfileLinkCounts: status.linkCount === undefined ? {} : { [status.profile.id]: status.linkCount },
      })} />);
      const indicator = view.getByRole("img", { name: status.label });
      expect(indicator.textContent).toBe("");
      expect(indicator.querySelector("span")?.className).toContain("h-[6px]");
    }
  });

  it("keeps Rule-row availability dot-only too", () => {
    const view = render(<RegexPresetList {...baseProps({ presets: [rule("r-dot", "Dot Rule")] })} />);
    const indicator = view.getByRole("img", { name: "promptManager.regex.availabilityActive" });
    expect(indicator.textContent).toBe("");
    expect(indicator.className).toContain("shrink-0");
  });

  it("keeps a Russian narrow Profile row to one visible member count plus a dot", () => {
    const name = "Очень длинный профиль правил";
    const profileRow = profile("p-ru", name);
    const view = render(<RegexPresetList {...baseProps({
      presets: [rule("r-ru", "Участник", { profileId: profileRow.id })],
      profiles: [profileRow],
    })} />);
    const row = view.getByText(name).closest("div.group") as HTMLElement;
    expect(row.textContent?.match(/\(1\)/g)).toHaveLength(1);
    expect(within(row).getByRole("img", { name: "promptManager.regex.availabilityActiveRules:1" }).textContent).toBe("");
    expect(within(row).queryByText("promptManager.regex.availabilityActiveRules:1")).toBeNull();
  });

  it("renders NO nested quick-create slot (owner ruling 2026-10-09: the Profile pane owns rule creation)", () => {
    const view = render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} />);
    expect(view.queryByRole("button", { name: "promptManager.regex.memberNewRule" })).toBeNull();
    // Members render directly under their profile inside the accordion wrapper.
    const profileName = view.getByText("First profile");
    const member = view.getByText("Member needle");
    expect(profileName.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses and expands the member section with the grid-rows accordion idiom", () => {
    const collapsed = render(<RegexPresetList {...nestedProps()} expandedProfileIds={[]} />);
    const wrapperCollapsed = collapsed.getByTestId("regex-members-p1");
    expect(wrapperCollapsed.getAttribute("aria-hidden")).toBe("true");
    expect(wrapperCollapsed.className).toContain("transition-[grid-template-rows,opacity]");
    collapsed.unmount();
    const expanded = render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} />);
    const wrapperOpen = expanded.getByTestId("regex-members-p1");
    expect(wrapperOpen.getAttribute("aria-hidden")).toBe("false");
    expect((wrapperOpen as HTMLElement).style.gridTemplateRows).toBe("1fr");
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

  it("places the standalone drop flow slot in the same scroll container before list rows", () => {
    // Behavior change (was: rows and the slot were direct siblings in the
    // scroll container; now: the primitive wraps each row in a key div and
    // owns the droppable wrapper — the slot content keeps its look/testid).
    const view = render(<RegexPresetList {...nestedProps()} expandedProfileIds={["p1"]} />);
    const start = { active: { id: "rule:r2" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    act(() => { dndHandlers!.onDragStart!(start); });

    const target = view.getByTestId("regex-standalone-drop");
    const profileRow = view.getByText("First profile").closest("div.group") as HTMLElement;
    const scroll = target.parentElement;
    expect(scroll?.contains(profileRow)).toBe(true);
    expect(target.compareDocumentPosition(profileRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const content = target.firstElementChild as HTMLElement;
    expect(content.className).toContain("border border-dashed border-border2");
    expect(content.className).not.toContain("absolute");
    expect(content.className).not.toContain("fixed");
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
    // The testid sits on the primitive's droppable wrapper; the dashed look
    // lives on the consumer's content (props carry data, never classes).
    const content = target.firstElementChild as HTMLElement;
    expect(content.className).toContain("border border-dashed border-border2");
    act(() => { dndHandlers!.onDragOver!(over); });
    expect(content.className).toContain("border-accent");
    expect(content.className).toContain("bg-accent-dim");
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
