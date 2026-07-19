/**
 * useReorderableList — the single-container drag-reorder orchestration shared
 * by Script, Lore, and (planned) Provider-profile / Prompt-preset DnD lists.
 *
 * The hook owns the MECHANICS that every single-container reorderable list
 * duplicates today: the dnd-kit sensor bundle (`useDndSensors`), the
 * `activeDragId` state that drives the `<DragOverlay>`, the
 * optimistic-then-reconcile round-trip, and the error-rollback (clear the
 * optimistic override when the commit rejects so the dragged item returns to
 * its real slot instead of sticking in the dropped position).
 *
 * The CONSUMER owns the SEMANTICS — what "reorder" means for its data and how
 * it persists. It supplies an `onReorder(activeId, overId)` callback that
 * returns the optimistic array to show during the async round-trip PLUS a
 * `persist()` that commits. Script plugs in flat `sortOrder` diffing (with
 * dnd-kit's `arrayMove`); Lore plugs in position-aware `buildReorderUpdates`.
 * The hook never touches `sortOrder`, `position`, or persistence shape.
 *
 * The hook deliberately does NOT render `<DndContext>` / `<SortableContext>` /
 * the sortable card — those stay in the consumer so it owns its own children,
 * collision detection, and overlay markup. The hook only feeds the consumer
 * `sensors`, `displayItems`, `activeDragItem`, and the three drag handlers.
 *
 * Cross-container drag (e.g. `InjectionTable`, which uses multiple
 * `SortableContext`s) is a fundamentally different shape and is NOT covered —
 * a future cross-container variant would be a separate hook.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useDndSensors } from "./use-dnd-sensors.js";

/** What a consumer's `onReorder` returns: the optimistic array to render while
 *  the commit is in flight, and the commit itself. */
export interface ReorderResult<T> {
	optimisticItems: T[];
	/** Commit the reorder. Rejection rolls back the optimistic override. */
	persist: () => Promise<unknown> | unknown;
}

export interface UseReorderableListOptions<T> {
	/** The committed (store/source) items. The hook renders `optimistic ?? items`. */
	items: T[];
	/** Stable identity extractor (e.g. `(s) => s.id`). Drives `activeDragItem`
	 *  lookup and the default equality signature. */
	getId: (item: T) => string;
	/** Compute the optimistic array + commit for dropping `activeId` onto
	 *  `overId`. Called only for real drops (never active === over). Receives
	 *  the current `displayItems` (the hook's `optimistic ?? items`) so the
	 *  consumer can derive its own view (sorted / section-grouped) without a
	 *  forward-reference closure — the reorder math must operate on the exact
	 *  flat order the user just dragged. */
	onReorder: (activeId: string, overId: string, displayItems: T[]) => ReorderResult<T>;
	/** Equality used to clear the optimistic override once `items` catches up.
	 *  Defaults to a signature over `getId` + array order. Override when the
	 *  reconcile must also match a derived field (Lore matches `position`
	 *  section, not just order, via `entryOrderSignature`). */
	itemsEqual?: (a: T[], b: T[]) => boolean;
}

export interface UseReorderableListResult<T> {
	/** `optimisticItems ?? items` — what the list renders. */
	displayItems: T[];
	sensors: ReturnType<typeof useDndSensors>;
	/** The item being dragged, for the consumer's `<DragOverlay>`. */
	activeDragItem: T | null;
	handleDragStart: (event: DragStartEvent) => void;
	handleDragEnd: (event: DragEndEvent) => void;
	handleDragCancel: () => void;
}

/** Default equality: same length and same `getId` at every index (order matters). */
function defaultItemsEqual<T>(a: T[], b: T[], getId: (item: T) => string): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (getId(a[i]) !== getId(b[i])) return false;
	}
	return true;
}

export function useReorderableList<T>({
	items,
	getId,
	onReorder,
	itemsEqual,
}: UseReorderableListOptions<T>): UseReorderableListResult<T> {
	const sensors = useDndSensors();
	const [activeDragId, setActiveDragId] = useState<string | null>(null);
	const [optimisticItems, setOptimisticItems] = useState<T[] | null>(null);

	const displayItems = optimisticItems ?? items;

	// Latest displayItems for the stable handleDragEnd (read via ref so the
	// handler identity never changes yet always sees the current list).
	const displayItemsRef = useRef(displayItems);
	displayItemsRef.current = displayItems;

	// Hold the latest callbacks without re-creating the drag handlers (the
	// useEvent pattern: assign during render, read from the ref inside the
	// stable handler). This keeps `handleDragEnd` identity stable while still
	// seeing the consumer's freshest `onReorder` (which closes over its derived
	// view — sorted scripts / section-grouped lore — recomputed each render).
	const onReorderRef = useRef(onReorder);
	onReorderRef.current = onReorder;
	const getIdRef = useRef(getId);
	getIdRef.current = getId;
	const equalRef = useRef(itemsEqual);
	equalRef.current = itemsEqual;

	// Clear the optimistic override once the committed items catch up to the
	// optimistic array. The comparison function is read from the ref so this
	// effect's identity (and thus its re-run schedule) depends only on the two
	// arrays, not on the consumer's callback identity.
	useEffect(() => {
		if (!optimisticItems) return;
		const custom = equalRef.current;
		const equal = custom
			? custom(items, optimisticItems)
			: defaultItemsEqual(items, optimisticItems, getIdRef.current);
		if (equal) setOptimisticItems(null);
	}, [items, optimisticItems]);

	const activeDragItem = activeDragId
		? displayItems.find((it) => getId(it) === activeDragId) ?? null
		: null;

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);

	const handleDragEnd = useCallback((event: DragEndEvent) => {
		const { active, over } = event;
		setActiveDragId(null);
		if (!over || active.id === over.id) return;
		const { optimisticItems: optimistic, persist } = onReorderRef.current(
			String(active.id),
			String(over.id),
			displayItemsRef.current,
		);
		setOptimisticItems(optimistic);
		Promise.resolve(persist()).catch((error) => {
			// Rollback: drop the optimistic override so the list reflects the
			// real (unchanged) order instead of the dropped position.
			// eslint-disable-next-line no-console
			console.error("Failed to reorder items", error);
			setOptimisticItems(null);
		});
	}, []);

	const handleDragCancel = useCallback(() => {
		setActiveDragId(null);
	}, []);

	return { displayItems, sensors, activeDragItem, handleDragStart, handleDragEnd, handleDragCancel };
}
