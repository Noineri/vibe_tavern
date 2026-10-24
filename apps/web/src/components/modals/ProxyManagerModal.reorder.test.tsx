import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const realProxyApi = await import("../../api/proxy-api.js");
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

import type { ProxyRecord } from "../../api/types.js";

function makeProxy(overrides: Partial<ProxyRecord> = {}): ProxyRecord {
  return {
    id: "p1",
    name: "Office",
    url: "https://proxy.example:8443",
    username: "",
    hasStoredPassword: false,
    sortOrder: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

// In-memory server: reorderProxies stores the order, list reads come from the
// caller re-rendering with the persisted array (the AppShell refreshProxies
// shape) — the remount phase below proves the order survives a reload.
let server: ProxyRecord[] = [];
function applyReorder(updates: Array<{ id: string; sortOrder: number }>): ProxyRecord[] {
  const rank = new Map(updates.map((u) => [u.id, u.sortOrder]));
  server = [...server]
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((p, i) => ({ ...p, sortOrder: i }));
  return [...server];
}
const reorderMock = mock(async (updates: Array<{ id: string; sortOrder: number }>): Promise<ProxyRecord[]> => applyReorder(updates));

mock.module("../../api/proxy-api.js", () => ({
  ...realProxyApi,
  reorderProxies: reorderMock,
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

let ProxyManagerModal: typeof import("./ProxyManagerModal.js").ProxyManagerModal;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useModalStore: typeof import("../../stores/modal-store.js").useModalStore;

beforeAll(async () => {
  ({ ProxyManagerModal } = await import("./ProxyManagerModal.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useModalStore } = await import("../../stores/modal-store.js"));
});

beforeEach(() => {
  mock.clearAllMocks();
  dndHandlers = null;
  server = [
    makeProxy({ id: "p1", name: "Office", url: "https://office.example:8443", sortOrder: 0 }),
    makeProxy({ id: "p2", name: "Home", url: "https://home.example:8443", sortOrder: 1 }),
    makeProxy({ id: "p3", name: "Mobile", url: "https://mobile.example:8443", sortOrder: 2 }),
  ];
  reorderMock.mockImplementation(async (updates: Array<{ id: string; sortOrder: number }>) => applyReorder(updates));
  useModalStore.setState({ isProxyManagerOpen: true });
});

afterAll(() => useModalStore.setState({ isProxyManagerOpen: false }));

function renderModal(proxies: ProxyRecord[], onRefresh: () => Promise<void>) {
  return render(
    <TooltipProvider>
      <ProxyManagerModal
        proxies={proxies}
        defaultProxyId={null}
        onCreate={async () => proxies[0]!}
        onUpdate={async () => proxies[0]!}
        onDelete={async () => {}}
        onRefresh={onRefresh}
        onProvidersChanged={async () => {}}
      />
    </TooltipProvider>,
  );
}

function rowOrder(view: ReturnType<typeof render>): string[] {
  return Array.from(view.baseElement.querySelectorAll('[data-testid^="proxy-row-"]')).map(
    (el) => el.getAttribute("data-testid")!,
  );
}

function dragEnd(activeId: string, overId: string): void {
  expect(dndHandlers).toBeTruthy();
  const endEvent = { active: { id: activeId }, over: { id: overId } } as unknown as Parameters<
    NonNullable<RealDndContextProps["onDragEnd"]>
  >[0];
  act(() => {
    dndHandlers!.onDragEnd!(endEvent);
  });
}

describe("ProxyManagerModal reorder", () => {
  test("dragging a proxy persists the reordered payload and the order survives a remount", async () => {
    const view = renderModal([...server], async () => {});
    await waitFor(() => expect(view.getByTestId("proxy-row-p3")).toBeTruthy());
    expect(rowOrder(view)).toEqual(["proxy-row-p1", "proxy-row-p2", "proxy-row-p3"]);

    dragEnd("p1", "p3");
    await act(async () => {});
    expect(reorderMock).toHaveBeenCalledTimes(1);
    expect(reorderMock.mock.calls[0]?.[0]).toEqual([
      { id: "p2", sortOrder: 0 },
      { id: "p3", sortOrder: 1 },
      { id: "p1", sortOrder: 2 },
    ]);
    // Optimistic order shows immediately (the parent list has not refreshed yet).
    expect(rowOrder(view)).toEqual(["proxy-row-p2", "proxy-row-p3", "proxy-row-p1"]);
    view.unmount();

    // Reload: a fresh mount reads back the server-persisted order.
    const reloaded = renderModal([...server], async () => {});
    await waitFor(() => expect(reloaded.getByTestId("proxy-row-p1")).toBeTruthy());
    expect(rowOrder(reloaded)).toEqual(["proxy-row-p2", "proxy-row-p3", "proxy-row-p1"]);
    reloaded.unmount();
  });

  test("a rejected persist rolls back to the committed order", async () => {
    reorderMock.mockImplementationOnce(async () => { throw new Error("nope"); });
    const view = renderModal([...server], async () => {});
    await waitFor(() => expect(view.getByTestId("proxy-row-p3")).toBeTruthy());

    dragEnd("p1", "p3");
    await waitFor(() => expect(reorderMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rowOrder(view)).toEqual(["proxy-row-p1", "proxy-row-p2", "proxy-row-p3"]));
    view.unmount();
  });

  test("every proxy row carries a drag handle and tapping a row still selects it", async () => {
    const view = renderModal([...server], async () => {});
    await waitFor(() => expect(view.getByTestId("proxy-row-p3")).toBeTruthy());
    expect(view.getAllByLabelText("drag")).toHaveLength(3);

    await act(async () => { fireEvent.pointerDown(view.getByTestId("proxy-row-p2")); });
    await waitFor(() => expect(view.getByDisplayValue("Home")).toBeTruthy());
    view.unmount();
  });
});
