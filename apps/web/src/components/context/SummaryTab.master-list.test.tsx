import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realMasterDetailModal = await import("../shared/MasterDetailModal.js");
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;

import type { ChatSummaryRecord } from "../../api/types.js";

function makeSummary(overrides: Partial<ChatSummaryRecord> = {}): ChatSummaryRecord {
  return {
    id: "s1",
    chatId: "chat",
    branchId: "b",
    label: "First",
    content: "first content",
    summarizedFrom: 1,
    summarizedTo: 3,
    includeInContext: true,
    excludeSummarized: true,
    source: "manual",
    sortOrder: 0,
    contentHash: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// In-memory archive: the reorder action stores the order and returns the
// fresh server-ordered list (the SUM-3b contract the master list commits).
let server: ChatSummaryRecord[] = [];
const listMock = mock(async (_chatId: ChatId): Promise<ChatSummaryRecord[]> => [...server]);
const reorderMock = mock(async (_chatId: ChatId, orderedIds: string[]): Promise<ChatSummaryRecord[]> => {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  server = [...server].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...server];
});
const updateMock = mock(async (_chatId: ChatId, summaryId: string, patch: Partial<ChatSummaryRecord>): Promise<ChatSummaryRecord> => {
  const current = server.find((s) => s.id === summaryId);
  if (!current) throw new Error("not found");
  const updated = { ...current, ...patch };
  server = server.map((s) => (s.id === summaryId ? updated : s));
  return updated;
});

mock.module("../shared/MasterDetailModal.js", () => ({
  ...realMasterDetailModal,
  useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));
mock.module("../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  listChatSummariesAction: listMock,
  reorderChatSummariesAction: reorderMock,
  updateChatSummaryAction: updateMock,
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

let useSummaryTab: typeof import("./SummaryTab.js").useSummaryTab;
beforeAll(async () => {
  ({ useSummaryTab } = await import("./SummaryTab.js"));
});

const harnessProps = {
  isOpen: true,
  onClose: () => {},
  activeChatId: "chat" as ChatId,
  providers: [],
  contextWindow: { used: 0, limit: 1 },
  currentSummary: "",
  messageCount: 12,
  messageHistoryLimit: 0,
  autoSummaryConfig: undefined,
  onSummarize: async () => "",
  onSaveSummary: async () => "",
  onFetchModelsForProfile: async () => [],
};

function Harness() {
  const tab = useSummaryTab(harnessProps);
  return <>{tab.masterContent}</>;
}

function rowOrder(view: ReturnType<typeof render>): string[] {
  return Array.from(view.baseElement.querySelectorAll('[data-testid^="summary-row-"]')).map(
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

describe("SummaryTab master list (ML-4 primitive)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    dndHandlers = null;
    server = [
      makeSummary({ id: "s1", label: "First", sortOrder: 0 }),
      makeSummary({ id: "s2", label: "Second", summarizedFrom: 4, summarizedTo: 6, source: "auto", sortOrder: 1 }),
    ];
    listMock.mockImplementation(async () => [...server]);
    reorderMock.mockImplementation(async (_chatId: ChatId, orderedIds: string[]) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      server = [...server].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      return [...server];
    });
    updateMock.mockImplementation(async (_chatId: ChatId, summaryId: string, patch: Partial<ChatSummaryRecord>) => {
      const current = server.find((s) => s.id === summaryId);
      if (!current) throw new Error("not found");
      const updated = { ...current, ...patch };
      server = server.map((s) => (s.id === summaryId ? updated : s));
      return updated;
    });
  });

  test("archive rows render on the primitive with handles, wrapping titles, and source second lines", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(view.getByTestId("summary-row-s2")).toBeTruthy());
    expect(rowOrder(view)).toEqual(["summary-row-s1", "summary-row-s2"]);
    for (const id of ["summary-row-s1", "summary-row-s2"]) {
      const row = view.getByTestId(id);
      expect(within(row).getAllByLabelText("drag")).toHaveLength(1);
      // Row rules: the title wraps (break-words), never truncates.
      expect(row.querySelector(".break-words")).toBeTruthy();
      expect(row.querySelector(".truncate")).toBeNull();
    }
    expect(view.getByTestId("summary-row-s2").textContent).toContain("summary_source_auto");
    expect(view.getByTestId("summary-row-s1").textContent).toContain("summary_source_manual");
    view.unmount();
  });

  test("dragging a summary persists the reordered ids and commits the fresh list", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(view.getByTestId("summary-row-s2")).toBeTruthy());

    dragEnd("s1", "s2");
    await act(async () => {});
    expect(reorderMock).toHaveBeenCalledTimes(1);
    expect(String(reorderMock.mock.calls[0]?.[0])).toBe("chat");
    expect(reorderMock.mock.calls[0]?.[1]).toEqual(["s2", "s1"]);
    await waitFor(() => expect(rowOrder(view)).toEqual(["summary-row-s2", "summary-row-s1"]));
    view.unmount();
  });

  test("toggling include-in-context never moves the selection", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(view.getByTestId("summary-row-s2")).toBeTruthy());
    // The loader auto-selects the first summary.
    expect(view.getByTestId("summary-row-s1").className).toContain("bg-accent-dim");

    const toggle = within(view.getByTestId("summary-row-s2")).getByRole("switch");
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]?.[1]).toBe("s2");
    // Selection stays on the first row; the toggled row is not selected.
    expect(view.getByTestId("summary-row-s1").className).toContain("bg-accent-dim");
    expect(view.getByTestId("summary-row-s2").className).not.toContain("bg-accent-dim");
    view.unmount();
  });

  test("tapping a row selects it and the delete affordance stays on the row", async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(view.getByTestId("summary-row-s2")).toBeTruthy());

    await act(async () => { fireEvent.pointerDown(view.getByTestId("summary-row-s2")); });
    await waitFor(() => expect(view.getByTestId("summary-row-s2").className).toContain("bg-accent-dim"));
    expect(view.getByTestId("summary-row-s1").className).not.toContain("bg-accent-dim");
    for (const id of ["summary-row-s1", "summary-row-s2"]) {
      expect(within(view.getByTestId(id)).getByLabelText("delete")).toBeTruthy();
    }
    view.unmount();
  });
});
