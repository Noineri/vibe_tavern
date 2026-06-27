/**
 * LoreEntryList — drag-and-drop list of lore entries grouped by prompt position.
 *
 * Desktop: entire card is draggable (mouse sensor with distance constraint
 * preserves click). Visual indicator: centered grab bar at top edge.
 * Mobile: ≡ handle on the left is the drag trigger, 44px touch target.
 * Cross-section drag changes position + sortOrder.
 *
 * DnD mechanics: `@dnd-kit/core` + `@dnd-kit/sortable` + `<DragOverlay>`,
 * mirroring the prompt-preset canvas (PromptOrderCanvas). The `<DragOverlay>`
 * is registered with the DndContext, so dnd-kit's built-in autoscroll tracks
 * it (the cursor) to scroll-container edges — this is what makes autoscroll
 * work on desktop. The source node stays in place as an opacity-0 placeholder
 * (autoscroll keys off the DragOverlay, not the source, so that is fine).
 *
 * Data model (see lore-entry-reorder.ts): `sortOrder` is a GLOBAL flat index.
 * The list renders one flat sequence visually grouped by `position`; a single
 * SortableContext over the flat list preserves the global-order semantics.
 */

import { useState, useMemo, useCallback, useEffect, type CSSProperties, type HTMLAttributes } from "react";
import { useDndSensors } from "../../../hooks/use-dnd-sensors.js";
import {
	DndContext,
	DragOverlay,
	closestCenter,
	type DragStartEvent,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { cn } from "../../../lib/cn.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { Toggle } from "../../shared/Toggle.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import type { LoreEntryRecord } from "../../../app-client.js";
import {
	POSITION_SECTIONS,
	getSection,
	entryOrderSignature,
	buildReorderUpdates,
} from "./lore-entry-reorder.js";

// ── Entry Card (presentational, drag-agnostic) ──────────────────────────

interface EntryCardVisualProps {
	entry: LoreEntryRecord;
	isActive: boolean;
	isMobile: boolean;
	t: (key: string) => string;
	onClick?: () => void;
	rootRef?: (node: HTMLElement | null) => void;
	mobileHandleRef?: (node: HTMLElement | null) => void;
	style?: CSSProperties;
	rootProps?: HTMLAttributes<HTMLDivElement>;
	mobileHandleProps?: HTMLAttributes<HTMLDivElement>;
	draggingPlaceholder?: boolean;
	overlay?: boolean;
	/** When provided, an enabled-toggle renders at the row's right edge.
	 *  Omitted in the drag-overlay copy (display-only, pointer-events-none). */
	onToggleEnabled?: (entryId: string, enabled: boolean) => void;
}

function EntryCardVisual({
	entry,
	isActive,
	isMobile,
	t,
	onClick,
	rootRef,
	mobileHandleRef,
	style,
	rootProps,
	mobileHandleProps,
	draggingPlaceholder = false,
	overlay = false,
	onToggleEnabled,
}: EntryCardVisualProps) {
	return (
		<div
			ref={rootRef}
			data-lore-dnd={overlay ? "overlay" : "source"}
			data-lore-entry-id={entry.id}
			style={style}
			className={cn(
				"relative rounded-lg border transition-shadow min-h-[44px]",
				isMobile && "flex",
				!isMobile && !overlay && "cursor-grab active:cursor-grabbing",
				isActive
					? "border-accent bg-accent-dim"
					: "border-border bg-surface hover:bg-s2",
				draggingPlaceholder && "opacity-0",
				overlay && "pointer-events-none shadow-lg"
			)}
			{...rootProps}
		>
			{/* Desktop: centered under the card's top edge, visual only. */}
			{!isMobile && (
				<div className="pointer-events-none absolute left-1/2 top-1.5 z-10 -translate-x-1/2">
					<div className="h-[4px] w-11 rounded-full bg-t3/25 shadow-sm" />
				</div>
			)}

			{/* Mobile: left-side dedicated drag handle. */}
			{isMobile && (
				<div
					ref={mobileHandleRef}
					className={cn(
						"flex w-12 shrink-0 select-none items-center justify-center rounded-l-lg text-t3",
						!overlay && "cursor-grab touch-none active:cursor-grabbing active:bg-s2"
					)}
					style={{ touchAction: "none" }}
					onClick={(e) => e.stopPropagation()}
					{...mobileHandleProps}
				>
					<span className="text-xl leading-none">≡</span>
				</div>
			)}

			{/* Card content */}
			<div className="min-w-0 flex-1 px-3.5 pt-3 pb-2.5">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"flex-1 truncate text-[13px] font-medium",
							entry.enabled ? "text-t1" : "text-t3 line-through"
						)}
						onClick={(e) => {
							e.stopPropagation();
							onClick?.();
						}}
					>
						{entry.title || t("lore_no_entries")}
					</span>

					{/* ── Status badges (only the non-default flags) ── */}
					{entry.constant && (
						<CustomTooltip content={t("constant_hint")} align="start">
							<span className="flex h-5 shrink-0 items-center rounded bg-accent-dim px-1.5 text-[10px] font-bold uppercase leading-none text-accent-t">C</span>
						</CustomTooltip>
					)}
					{entry.ignoreBudget && (
						<CustomTooltip content={t("ignore_budget_hint")} align="start">
							<span className="flex h-5 shrink-0 items-center rounded bg-warning-dim px-1.5 text-[10px] font-bold leading-none text-warning-text">∞</span>
						</CustomTooltip>
					)}
					{entry.groupName && (
						<CustomTooltip content={`${t("lore_group_name")}: ${entry.groupName}`} align="start">
							<span className="flex h-5 max-w-[80px] shrink-0 items-center truncate rounded bg-s3 px-1.5 text-[10px] leading-none text-t3">{entry.groupName}</span>
						</CustomTooltip>
					)}

					{/* ── Enabled toggle ──
              Stop pointerdown so dnd-kit's MouseSensor (whole-card activator on
              desktop) never starts a drag from here; stop click so the card
              doesn't navigate into the editor. The drag-overlay copy passes no
              callback and is pointer-events-none anyway. */}
					<div
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => e.stopPropagation()}
						className="flex h-5 shrink-0 items-center"
					>
						<Toggle
							checked={entry.enabled}
							onChange={(v) => onToggleEnabled?.(entry.id, v)}
						/>
					</div>
				</div>

				{/* Clickable content area below title */}
				<div className={cn(onClick && "cursor-pointer")} onClick={onClick}>
					<div className="mt-1 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
						{entry.keys.length > 0
							? `keys: ${entry.keys.join(", ")}`
							: t("lore_no_entries")}
					</div>
					{entry.content && (
						<div
							className="mt-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
							style={{
								display: "-webkit-box",
								WebkitLineClamp: 2,
								WebkitBoxOrient: "vertical",
								overflow: "hidden",
							}}
						>
							{entry.content}
						</div>
					)}
					{entry.content && (
						<TokenCounter
							text={entry.content}
							className="mt-1 flex justify-end font-ui text-[11px] tabular-nums text-t3/50"
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Sortable Entry Card ─────────────────────────────────────────────────

function SortableEntryCard({
	entry,
	isActive,
	isMobile,
	t,
	onClick,
	onToggleEnabled,
}: {
	entry: LoreEntryRecord;
	isActive: boolean;
	isMobile: boolean;
	t: (key: string) => string;
	onClick: () => void;
	onToggleEnabled?: (entryId: string, enabled: boolean) => void;
}) {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
		id: entry.id,
	});

	const handleRootRef = useCallback(
		(node: HTMLElement | null) => {
			setNodeRef(node);
		},
		[setNodeRef],
	);

	// On mobile the handle is the activator; on desktop the whole card is the
	// activator (setActivatorNodeRef is left uncalled). EntryCardVisual only
	// mounts the handle (and thus only invokes this ref) when isMobile.
	const handleMobileHandleRef = useCallback(
		(node: HTMLElement | null) => {
			setActivatorNodeRef(node);
		},
		[setActivatorNodeRef],
	);

	const style: CSSProperties = {
		transform: CSS.Translate.toString(transform),
		transition,
		// The DragOverlay carries the visible preview; the source becomes an
		// invisible in-place placeholder while dragging.
		...(isDragging ? { opacity: 0 } : {}),
	};

	return (
		<EntryCardVisual
			entry={entry}
			isActive={isActive}
			isMobile={isMobile}
			t={t}
			onClick={onClick}
			onToggleEnabled={onToggleEnabled}
			rootRef={handleRootRef}
			style={style}
			rootProps={!isMobile ? { ...attributes, ...listeners } : undefined}
			mobileHandleRef={handleMobileHandleRef}
			mobileHandleProps={isMobile ? { ...attributes, ...listeners } : undefined}
		/>
	);
}

// ── Main Component ──────────────────────────────────────────────────────

interface LoreEntryListProps {
	entries: LoreEntryRecord[];
	activeEntryId: string | null;
	isMobile: boolean;
	isRu: boolean;
	t: (key: string) => string;
	onEntryClick: (entryId: string) => void;
	onReorder: (updates: Array<{ id: string; sortOrder: number; position?: string }>) => void | Promise<unknown>;
	onToggleEnabled?: (entryId: string, enabled: boolean) => void | Promise<void>;
}

export function LoreEntryList({
	entries,
	activeEntryId,
	isMobile,
	isRu,
	t,
	onEntryClick,
	onReorder,
	onToggleEnabled,
}: LoreEntryListProps) {
	const [activeDragId, setActiveDragId] = useState<string | null>(null);
	const [optimisticEntries, setOptimisticEntries] = useState<LoreEntryRecord[] | null>(null);

	const sensors = useDndSensors();

	const displayEntries = optimisticEntries ?? entries;

	// Clear the optimistic override once the store-confirmed entries catch up.
	useEffect(() => {
		if (!optimisticEntries) return;
		if (entryOrderSignature(entries) === entryOrderSignature(optimisticEntries)) {
			setOptimisticEntries(null);
		}
	}, [entries, optimisticEntries]);

	// Group entries by position for rendering (memoized).
	const grouped = useMemo(() => {
		const map = new Map<string, LoreEntryRecord[]>();
		for (const sec of POSITION_SECTIONS) {
			map.set(sec.value, []);
		}
		for (const entry of displayEntries) {
			const key = getSection(entry.position).value;
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(entry);
		}
		return map;
	}, [displayEntries]);

	// The single flat order the SortableContext and the commit logic operate on.
	const renderedEntries = useMemo(
		() => POSITION_SECTIONS.flatMap((sec) => grouped.get(sec.value) ?? []),
		[grouped],
	);

	const activeEntry = useMemo(
		() => displayEntries.find((entry) => entry.id === activeDragId) ?? null,
		[activeDragId, displayEntries],
	);

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			setActiveDragId(null);
			if (!over || active.id === over.id) return;

			const updates = buildReorderUpdates(renderedEntries, String(active.id), String(over.id));
			if (!updates) return;

			// Optimistic: reflect the drop immediately, before the store responds,
			// so the dragged card does not snap back to its old slot during the
			// async round-trip. Cleared by the effect above once entries catch up.
			const byId = new Map(displayEntries.map((e) => [e.id, e]));
			const optimistic = updates
				.map((u) => {
					const e = byId.get(u.id);
					return e ? (u.position ? { ...e, position: u.position } : e) : null;
				})
				.filter((e): e is LoreEntryRecord => e !== null);
			setOptimisticEntries(optimistic);

			void Promise.resolve(onReorder(updates)).catch((error) => {
				// eslint-disable-next-line no-console
				console.error("Failed to reorder lore entries", error);
				setOptimisticEntries(null);
			});
		},
		[renderedEntries, displayEntries, onReorder],
	);

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragCancel={() => setActiveDragId(null)}
		>
			<SortableContext items={renderedEntries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
				{POSITION_SECTIONS.map((sec) => {
					const sectionEntries = grouped.get(sec.value) ?? [];
					if (sectionEntries.length === 0) return null;

					return (
						<div key={sec.value} className="mb-2">
							{/* Section divider */}
							<div className="mb-1.5 flex items-center gap-2 px-1">
								<div className="h-px flex-1 bg-border" />
								<span className="shrink-0 font-ui text-[11px] uppercase tracking-wider text-t3/60">
									{isRu ? sec.labelRu : sec.label}
								</span>
								<div className="h-px flex-1 bg-border" />
							</div>

							<div className="flex flex-col gap-1.5">
								{sectionEntries.map((entry) => (
									<SortableEntryCard
										key={entry.id}
										entry={entry}
										isActive={entry.id === activeEntryId}
										isMobile={isMobile}
										t={t}
										onClick={() => onEntryClick(entry.id)}
										onToggleEnabled={onToggleEnabled}
									/>
								))}
							</div>
						</div>
					);
				})}

				{/* Empty state */}
				{displayEntries.length === 0 && (
					<div className="py-3 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
						{t("lore_no_entries")}
					</div>
				)}
			</SortableContext>

			<DragOverlay dropAnimation={null}>
				{activeEntry ? (
					<EntryCardVisual
						entry={activeEntry}
						isActive={activeEntry.id === activeEntryId}
						isMobile={isMobile}
						t={t}
						overlay
					/>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}
