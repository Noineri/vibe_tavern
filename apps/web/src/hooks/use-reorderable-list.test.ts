/**
 * useReorderableList — unit tests for the optimistic/reconcile/rollback
 * contract, the orchestration that Script + Lore each inlined (and that
 * neither had a test for) before this hook extracted it.
 *
 * No DOM / no dnd-kit gesture here: the handlers are driven with synthetic
 * DragStart/DragEnd events and the hook is exercised at its state-machine
 * boundary (optimistic set → reconcile clear / reject rollback). The
 * signature-compare reconcile is asserted via array reference identity: while
 * the optimistic override is active `displayItems` IS the optimistic array the
 * consumer returned; once the committed `items` catch up and the equality
 * check passes, `displayItems` becomes the `items` prop again.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

let act: typeof import("@testing-library/react").act;
let renderHook: typeof import("@testing-library/react").renderHook;

let useReorderableList: typeof import("./use-reorderable-list.js").useReorderableList;

beforeAll(async () => {
	({ act, renderHook } = await import("@testing-library/react"));
	({ useReorderableList } = await import("./use-reorderable-list.js"));
});

interface Item {
	id: string;
}
const A: Item = { id: "a" };
const B: Item = { id: "b" };
const C: Item = { id: "c" };

function drop(result: { handleDragEnd: (e: DragEndEvent) => void }, activeId: string, overId: string) {
	act(() => {
		result.handleDragEnd({ active: { id: activeId }, over: { id: overId } } as unknown as DragEndEvent);
	});
}

describe("useReorderableList", () => {
	test("sets the optimistic array on drop, then clears once items catch up", () => {
		const optimisticArr = [A, C, B];
		const onReorder = mock(() => ({
			optimisticItems: optimisticArr,
			persist: () => Promise.resolve(),
		}));
		const initial = [A, B, C];
		const { result, rerender } = renderHook(
			({ items }) => useReorderableList({ items, getId: (i) => i.id, onReorder }),
			{ initialProps: { items: initial } },
		);

		// Before any drop: renders the committed items.
		expect(result.current.displayItems).toBe(initial);
		expect(result.current.activeDragItem).toBeNull();

		drop(result.current, "b", "c");

		expect(onReorder).toHaveBeenCalledTimes(1);
		expect(onReorder).toHaveBeenCalledWith("b", "c", initial);
		// Optimistic override active: display IS the optimistic array, not `initial`.
		expect(result.current.displayItems).toBe(optimisticArr);

		// Store catches up to the new order → reconcile effect clears the override.
		const caught = [A, C, B];
		act(() => {
			rerender({ items: caught });
		});
		expect(result.current.displayItems).toBe(caught);
	});

	test("rolls back the optimistic override when persist rejects", async () => {
		const optimisticArr = [A, C, B];
		const onReorder = mock(() => ({
			optimisticItems: optimisticArr,
			persist: () => Promise.reject(new Error("boom")),
		}));
		const initial = [A, B, C];
		const { result } = renderHook(
			({ items }) => useReorderableList({ items, getId: (i) => i.id, onReorder }),
			{ initialProps: { items: initial } },
		);

		await act(async () => {
			result.current.handleDragEnd({
				active: { id: "b" },
				over: { id: "c" },
			} as unknown as DragEndEvent);
			// Flush the rejected-persist microtask that triggers the rollback.
			await Promise.resolve();
			await Promise.resolve();
		});

		// Rolled back: the committed items are shown again, not the dropped order.
		expect(result.current.displayItems).toBe(initial);
	});

	test("no-op drop (active === over) calls neither onReorder nor persist", () => {
		const persist = mock(() => Promise.resolve());
		const onReorder = mock(() => ({ optimisticItems: [A, C, B], persist }));
		const initial = [A, B, C];
		const { result } = renderHook(
			({ items }) => useReorderableList({ items, getId: (i) => i.id, onReorder }),
			{ initialProps: { items: initial } },
		);

		drop(result.current, "b", "b");

		expect(onReorder).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(result.current.displayItems).toBe(initial);
	});

	test("dragStart exposes the dragged item as activeDragItem; dragEnd/cancel clear it", () => {
		const onReorder = mock(() => ({ optimisticItems: [A, C, B], persist: () => Promise.resolve() }));
		const initial = [A, B, C];
		const { result } = renderHook(
			({ items }) => useReorderableList({ items, getId: (i) => i.id, onReorder }),
			{ initialProps: { items: initial } },
		);

		act(() => {
			result.current.handleDragStart({ active: { id: "b" } } as unknown as DragStartEvent);
		});
		expect(result.current.activeDragItem).toBe(B);

		// Cancel returns to the rest state without committing.
		act(() => {
			result.current.handleDragCancel();
		});
		expect(result.current.activeDragItem).toBeNull();

		// Start again, then a real drop also clears the overlay item (and commits).
		act(() => {
			result.current.handleDragStart({ active: { id: "c" } } as unknown as DragStartEvent);
		});
		expect(result.current.activeDragItem).toBe(C);
		drop(result.current, "c", "a");
		expect(result.current.activeDragItem).toBeNull();
		expect(onReorder).toHaveBeenCalledWith("c", "a", initial);
	});

	test("the custom itemsEqual gates the reconcile clear (Lore's position-section case)", () => {
		const optimisticArr = [A, C, B];
		const onReorder = mock(() => ({
			optimisticItems: optimisticArr,
			persist: () => Promise.resolve(),
		}));
		// Custom equal that refuses to match — models a semantic (e.g. position
		// section) that the caught-up order alone does not satisfy.
		const itemsEqual = mock(() => false);
		const initial = [A, B, C];
		const { result, rerender } = renderHook(
			({ items }) => useReorderableList({ items, getId: (i) => i.id, onReorder, itemsEqual }),
			{ initialProps: { items: initial } },
		);

		drop(result.current, "b", "c");
		expect(result.current.displayItems).toBe(optimisticArr);

		// Store "caught up" by order, but the custom equal still says no → stays optimistic.
		act(() => {
			rerender({ items: [A, C, B] });
		});
		expect(itemsEqual).toHaveBeenCalled();
		expect(result.current.displayItems).toBe(optimisticArr);

		// Now the semantic matches → reconcile clears. Pass a fresh items reference
		// (a real store always produces a new array) so the effect re-runs.
		itemsEqual.mockReturnValue(true);
		const caught = [A, C, B];
		act(() => {
			rerender({ items: caught });
		});
		expect(result.current.displayItems).toBe(caught);
	});
});
