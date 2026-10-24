import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ComponentProps } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render, within } = await import("@testing-library/react");
const realI18n = await import("../../../i18n/context.js");
const realMasterDetailModal = await import("../../shared/MasterDetailModal.js");
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
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
  // ProviderProfileList.test.tsx (co-load contract: last-write-wins).
  DragOverlay: (props: RealDragOverlayProps) => <>{props.children}</>,
}));

let MasterList: typeof import("./master-list.js").MasterList;
let MasterListRow: typeof import("./master-list-row.js").MasterListRow;
let SortableMasterListRow: typeof import("./master-list-row.js").SortableMasterListRow;
let MasterListPhoneRow: typeof import("./master-list-phone-row.js").MasterListPhoneRow;
let SortableMasterListPhoneRow: typeof import("./master-list-phone-row.js").SortableMasterListPhoneRow;
let MasterListDragOverlayRow: typeof import("./master-list-overlay-row.js").MasterListDragOverlayRow;
beforeAll(async () => {
  ({ MasterList } = await import("./master-list.js"));
  ({ MasterListRow, SortableMasterListRow } = await import("./master-list-row.js"));
  ({ MasterListPhoneRow, SortableMasterListPhoneRow } = await import("./master-list-phone-row.js"));
  ({ MasterListDragOverlayRow } = await import("./master-list-overlay-row.js"));
});

interface Item {
  id: string;
  name: string;
}

const items: Item[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

function listProps(overrides: Record<string, unknown> = {}) {
  const persisted: Array<Array<{ id: string; sortOrder: number }>> = [];
  const onSelect = mock();
  const props = {
    items,
    getId: (item: Item) => item.id,
    onReorderItems: (activeId: string, overId: string, current: Item[]) => {
      const fromIdx = current.findIndex((item) => item.id === activeId);
      const toIdx = current.findIndex((item) => item.id === overId);
      const reordered = [...current];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved!);
      return {
        optimisticItems: reordered,
        persist: () => {
          persisted.push(reordered.map((item, i) => ({ id: item.id, sortOrder: i })));
        },
      };
    },
    header: <div data-testid="list-header">header</div>,
    search: <div data-testid="list-search">search</div>,
    footer: <div data-testid="list-footer">footer</div>,
    renderRow: (item: Item) => (
      <SortableMasterListPhoneRow
        sortableId={item.id}
        selected={item.id === "a"}
        active={item.id === "a"}
        status={<div data-testid={`dot-${item.id}`} className="test-dot" />}
        title={item.name}
        secondLine={`second-${item.id}`}
        onSelect={() => onSelect(item.id)}
        rowTestId={`row-${item.id}`}
      />
    ),
    renderOverlayRow: (item: Item) => <MasterListDragOverlayRow title={item.name} active={item.id === "a"} />,
    ...overrides,
  };
  return { props, persisted, onSelect };
}

describe("master-list primitive", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    dndHandlers = null;
  });

  it("wraps long titles instead of ellipsizing them", () => {
    const { props } = listProps();
    const view = render(<MasterList {...props} />);

    const title = view.getByText("Alpha");
    expect(title.classList.contains("truncate")).toBe(false);
    expect(title.classList.contains("break-words")).toBe(true);
    // No ellipsis machinery anywhere up the row chain.
    let el: HTMLElement | null = title;
    while (el && el.getAttribute("data-testid") !== "row-a") {
      expect(el.classList.contains("whitespace-nowrap")).toBe(false);
      expect(el.classList.contains("text-ellipsis")).toBe(false);
      expect(el.classList.contains("overflow-hidden")).toBe(false);
      el = el.parentElement;
    }
    if (!el) throw new Error("Row root missing");
  });

  it("marks the selected row by background + accent border; unselected rows stay text-t2", () => {
    const { props } = listProps();
    const view = render(<MasterList {...props} />);

    const selected = view.getByTestId("row-a");
    expect(selected.classList.contains("border-l-accent")).toBe(true);
    expect(selected.classList.contains("bg-accent-dim")).toBe(true);
    expect(selected.classList.contains("text-accent-t")).toBe(true);

    const plain = view.getByTestId("row-b");
    expect(plain.classList.contains("border-l-transparent")).toBe(true);
    expect(plain.classList.contains("text-t2")).toBe(true);
    // «In use» is a ★ in the status cluster, never a whole-row color.
    expect(within(selected).getByText("★")).toBeTruthy();
    expect(within(plain).queryByText("★")).toBeNull();
  });

  it("starts drag from the handle only; tapping the row selects", () => {
    const { props, persisted, onSelect } = listProps();
    const view = render(<MasterList {...props} />);

    const row = view.getByTestId("row-a");
    const handles = within(row).getAllByLabelText("drag");
    expect(handles).toHaveLength(1);
    // dnd-kit wires the activator role onto the handle, not the row root.
    expect(handles[0]!.getAttribute("role")).toBe("button");

    fireEvent.pointerDown(row);
    expect(onSelect).toHaveBeenCalledWith("a");

    expect(dndHandlers).toBeTruthy();
    const endEvent = { active: { id: "a" }, over: { id: "b" } } as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragEnd"]>
    >[0];
    act(() => {
      dndHandlers!.onDragEnd!(endEvent);
    });
    expect(persisted).toEqual([[{ id: "b", sortOrder: 0 }, { id: "a", sortOrder: 1 }]]);
  });

  it("renders a pinned row without a handle inside the same list", () => {
    const { props } = listProps({
      items: [{ id: "builtin", name: "Built-in" }, ...items],
      renderRow: (item: Item) =>
        item.id === "builtin" ? (
          <MasterListRow title={item.name} rowTestId="row-builtin" />
        ) : (
          <SortableMasterListRow
            sortableId={item.id}
            title={item.name}
            onSelect={() => {}}
            rowTestId={`row-${item.id}`}
          />
        ),
    });
    const view = render(<MasterList {...props} />);

    const pinned = view.getByTestId("row-builtin");
    expect(within(pinned).queryByLabelText("drag")).toBeNull();
    expect(within(pinned).getByText("Built-in")).toBeTruthy();
    expect(within(view.getByTestId("row-a")).getAllByLabelText("drag")).toHaveLength(1);
  });

  it("renders the phone row with a drill-down caret that selects and opens detail", () => {
    const onSelect = mock();
    const view = render(
      <MasterListPhoneRow title="Alpha" secondLine="second-a" onSelect={onSelect} rowTestId="phone-row" />,
    );

    const row = view.getByTestId("phone-row");
    // The drill-down caret is the mobile shape; the handle stays (no hiding
    // drag on the phone).
    expect(within(row).getByLabelText("master_detail_open")).toBeTruthy();
    fireEvent.pointerDown(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByLabelText("master_detail_open"));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("renders header, search, and footer slots around the sortable rows", () => {
    const { props } = listProps();
    const view = render(<MasterList {...props} />);

    expect(view.getByTestId("list-header")).toBeTruthy();
    expect(view.getByTestId("list-search")).toBeTruthy();
    expect(view.getByTestId("list-footer")).toBeTruthy();
    expect(view.getAllByLabelText("drag")).toHaveLength(2);
  });

  it("renders the drag overlay for the active item while dragging", () => {
    const { props } = listProps();
    const view = render(<MasterList {...props} />);

    expect(view.getAllByText("Beta")).toHaveLength(1);
    expect(dndHandlers).toBeTruthy();
    const startEvent = { active: { id: "b" } } as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragStart"]>
    >[0];
    act(() => {
      dndHandlers!.onDragStart!(startEvent);
    });
    // The dragged row keeps its place in the list; the overlay previews it.
    expect(view.getAllByText("Beta")).toHaveLength(2);
    // The overlay previews the ACTIVE item only — Alpha gains no preview.
    expect(view.getAllByText("Alpha")).toHaveLength(1);
  });

  it("supports a sortable-id override, drag extras, and a drag flow slot", () => {
    // ML-2 slots: `sortableIds` (transiently non-sortable rows), the
    // drag-start/over/cancel extras, and `renderDragSlot` (a droppable flow
    // slot inside the scroll container, e.g. a standalone-drop target).
    const seen: Array<string> = [];
    const { props } = listProps({
      sortableIds: ["a", "b", "slot"],
      onDragStartExtra: () => { seen.push("start"); },
      onDragOver: () => { seen.push("over"); },
      onDragCancelExtra: () => { seen.push("cancel"); },
      renderDragSlot: (active: { id: string; name: string } | null) => active ? <div data-testid="flow-slot">slot:{active.id}</div> : null,
    });
    const view = render(<MasterList {...props} />);
    expect(view.queryByTestId("flow-slot")).toBeNull();
    expect(dndHandlers).toBeTruthy();
    const startEvent = { active: { id: "b" } } as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragStart"]>
    >[0];
    act(() => { dndHandlers!.onDragStart!(startEvent); });
    expect(seen).toEqual(["start"]);
    const slot = view.getByTestId("flow-slot");
    expect(slot.textContent).toBe("slot:b");
    // The slot lives in the same scroll container, before the rows.
    const row = view.getByText("Alpha").closest("div.group") as HTMLElement;
    const scroll = row.parentElement?.parentElement;
    expect(scroll).toBeTruthy();
    expect(slot.parentElement).toBe(scroll!);
    expect(slot.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const overEvent = { active: { id: "b" }, over: null } as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragOver"]>
    >[0];
    act(() => { dndHandlers!.onDragOver!(overEvent); });
    expect(seen).toEqual(["start", "over"]);
    const cancelEvent = {} as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragCancel"]>
    >[0];
    act(() => { dndHandlers!.onDragCancel!(cancelEvent); });
    expect(seen).toEqual(["start", "over", "cancel"]);
    expect(view.queryByTestId("flow-slot")).toBeNull();
  });

  it("renders no drag overlay while dragging when renderOverlayRow is absent", () => {
    const { props } = listProps({ renderOverlayRow: undefined });
    const view = render(<MasterList {...props} />);

    expect(dndHandlers).toBeTruthy();
    const startEvent = { active: { id: "b" } } as unknown as Parameters<
      NonNullable<RealDndContextProps["onDragStart"]>
    >[0];
    act(() => {
      dndHandlers!.onDragStart!(startEvent);
    });
    expect(view.getAllByText("Beta")).toHaveLength(1);
  });
});
