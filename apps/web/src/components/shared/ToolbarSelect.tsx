// Responsive dual-mode toolbar selector — the shared primitive for the
// chat-bar quick-selects (co-author module, tool-filtered model favorites; RP
// starred models). Pins one logical "pick a value from a small list" selector
// that is **dual-mode by viewport**, both halves on shared primitives:
//
// - **desktop** → Radix Select (compact upward popper, arrow-key + first-letter
//   type-ahead, focus restore — all free).
// - **mobile** → shared `BottomSheet` (vaul Drawer, thumb-friendly 52px rows,
//   swipe-to-dismiss). Per the project rule every mobile popover surfaces as a
//   bottom sheet — ToolbarSelect does NOT collapse mobile onto a Popover.
//
// This mirrors the dual-mode `VariantJump` shape (step 3 of the overlay
// primitive audit, commit 27d22174): `Select` on desktop, `BottomSheet` on
// mobile, forked by an explicit `mobile` prop the caller resolves per shell.
// The value of centralising it here is removing the duplicated rows markup
// (leading + label + active check) that was previously copy-pasted between the
// desktop absolute popover and the mobile BottomSheet of every chat-bar select.
//
// Why Radix Select (not cmdk/Popover like DropdownSelect): these selects are
// pure value-pickers from a small known list with the current value highlighted
// — Radix Select's native `<select>` ARIA contract is the semantically correct
// and lighter primitive (DropdownSelect's cmdk carries a search state machine
// these sites do not need). See overlay-primitive-audit.md diagnosis table.

import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import { Icons } from "./icons.js";
import { CustomTooltip } from "./Tooltip.js";
import { BottomSheet } from "./BottomSheet.js";
import { getModalPortal } from "./modal-helpers.js";
import { useT } from "../../i18n/context.js";

export interface ToolbarSelectItem {
	/** Stable unique id; becomes Radix Select's `value`. Must be a non-empty
	 *  string (Radix treats "" as "no value"). */
	value: string;
	/** Row text/content. Rendered via Select.ItemText on desktop (so first-
	 *  letter type-ahead matches against it) and as a plain span on mobile. */
	label: ReactNode;
	/** Optional leading node (avatar, icon) rendered before the label. */
	leading?: ReactNode;
}

interface ToolbarSelectProps {
	/** Fork selector. Resolve with `useIsMobile()` in the router and pass the
	 *  result down — the desktop shell renders `<ToolbarSelect>` (default) and
	 *  the mobile shell renders `<ToolbarSelect mobile>`. Mirrors VariantJump. */
	mobile?: boolean;
	/** Optional controlled open state. When provided, the caller owns the
	 *  open/close lifecycle (and the internal state is bypassed). Needed for the
	 *  persona switch, whose footer opens a modal: the caller must `setOpen(false)`
	 *  BEFORE launching the modal, or the orphaned Select content leaks
	 *  `pointer-events: none` onto <body> and freezes the UI (the freeze bug
	 *  fixed in 108bd2b1). When omitted, the primitive manages its own open
	 *  state internally (the existing chat-bar selects use this). */
	open?: boolean;
	/** Companion to `open` — called when Radix/BottomSheet requests a close
	 *  (outside click, Escape, item select) or open (trigger click). Ignored
	 *  when `open` is omitted. */
	onOpenChange?: (open: boolean) => void;
	/** A single `<button type="button">` element. WITHOUT an `onClick` — the
	 *  primitive attaches the open handler on both halves (Select.Trigger on
	 *  desktop, the BottomSheet opener on mobile). Its `className` and any
	 *  `data-testid` are preserved verbatim (Radix Slot / cloneElement merge),
	 *  so each call site keeps its exact chrome and the characterization tests
	 *  keep resolving the trigger testid. */
	trigger: ReactElement;
	/** Desktop-only: wraps the trigger in a CustomTooltip. Ignored on mobile
	 *  (tooltips are hover-only; touch gets the visible sheet title instead). */
	triggerTooltip?: string;
	/** Builds the per-row testid from the item value (e.g.
	 *  `coauthor-module-option-${v}`, `coauthor-fav-model-${v}`). The trigger
	 *  testid stays on the caller's own button (see `trigger`). */
	itemTestId?: (value: string) => string;
	/** Header shown above the list (desktop popover header / BottomSheet title). */
	title: ReactNode;
	/** The options. When empty, `emptyText` is rendered instead. */
	items: ToolbarSelectItem[];
	/** Currently-selected value, or null for "nothing selected". */
	value: string | null;
	/** Fired with the chosen `value`. */
	onSelect: (value: string) => void;
	/** Shown in place of the list when `items` is empty (e.g. no starred models). */
	emptyText?: ReactNode;
	/** Optional trailing row under the list (e.g. the "manage personas" link).
	 *  Rendered inside the popover/sheet, above the mobile cancel button. */
	footer?: ReactNode;
	/** Desktop popover geometry. Defaults reproduce the prior absolute-positioned
	 *  placement (upward, end-aligned). Ignored on mobile. */
	side?: "top" | "bottom";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	/** Desktop popover width in px. Ignored on mobile (mobile sheet is full-width). */
	contentWidth?: number;
}

export function ToolbarSelect({
	mobile = false,
	open: openProp,
	onOpenChange,
	trigger,
	triggerTooltip,
	itemTestId,
	title,
	items,
	value,
	onSelect,
	emptyText,
	footer,
	side = "top",
	align = "end",
	sideOffset = 8,
	contentWidth = 220,
}: ToolbarSelectProps) {
	// Controlled-or-uncontrolled open state. When the caller passes `open`,
	// they own the lifecycle (needed for the persona footer → modal path — see
	// the prop doc). Otherwise the primitive manages its own state, and the
	// existing chat-bar selects keep their exact behavior. Resolved `open` /
	// `setOpen` are passed to BOTH halves so desktop (Select.Root) and mobile
	// (BottomSheet) stay in sync.
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = openProp !== undefined;
	const open = isControlled ? openProp : internalOpen;
	const setOpen = (next: boolean) => {
		if (!isControlled) setInternalOpen(next);
		onOpenChange?.(next);
	};

	if (mobile) {
		return (
			<ToolbarSelectMobile
				open={open}
				setOpen={setOpen}
				trigger={trigger}
				itemTestId={itemTestId}
				title={title}
				items={items}
				value={value}
				onSelect={onSelect}
				emptyText={emptyText}
				footer={footer}
			/>
		);
	}

	// Nested asChild chain: CustomTooltip (when requested) → Select.Trigger →
	// caller's button. Radix Slot composes, so ref / onClick / aria-expanded /
	// data-testid all flow through to the underlying <button>.
	const selectTrigger = <Select.Trigger asChild>{trigger}</Select.Trigger>;

	return (
		<Select.Root open={open} onOpenChange={setOpen} value={value ?? undefined} onValueChange={onSelect}>
			{triggerTooltip ? (
				<CustomTooltip content={triggerTooltip}>{selectTrigger}</CustomTooltip>
			) : (
				selectTrigger
			)}
			<Select.Portal container={getModalPortal() ?? undefined}>
				<Select.Content
					position="popper"
					side={side}
					sideOffset={sideOffset}
					align={align}
					className="glass-blur z-[220] overflow-hidden rounded-lg border border-border2 bg-glass-bg py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]"
					style={{ width: contentWidth }}
				>
					<div className="mb-1 border-b border-border px-4 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
						{title}
					</div>
					<Select.Viewport className="overflow-y-auto">
						{items.length > 0 ? (
							<div className="max-h-[200px] overflow-y-auto">
								{items.map((item) => (
									<Select.Item
										key={item.value}
										value={item.value}
										data-testid={itemTestId?.(item.value)}
										className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left font-ui text-[13px] text-t1 outline-none transition-colors data-[highlighted]:bg-s2 data-[state=checked]:bg-accent-dim"
									>
										<span className="flex w-4 shrink-0 justify-center text-accent-t">
											<Select.ItemIndicator>
												<Icons.Check />
											</Select.ItemIndicator>
										</span>
										{item.leading && <span className="shrink-0">{item.leading}</span>}
										<Select.ItemText asChild>
											<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
												{item.label}
											</span>
										</Select.ItemText>
									</Select.Item>
								))}
							</div>
						) : (
							<div className="px-4 py-2 font-ui text-[12px] text-t3">{emptyText}</div>
						)}
					</Select.Viewport>
					{footer && <div className="mt-1 border-t border-border px-2 pt-1">{footer}</div>}
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}

function ToolbarSelectMobile({
	open,
	setOpen,
	trigger,
	itemTestId,
	title,
	items,
	value,
	onSelect,
	emptyText,
	footer,
}: Pick<ToolbarSelectProps, "trigger" | "itemTestId" | "title" | "items" | "value" | "onSelect" | "emptyText" | "footer"> & {
	open: boolean;
	setOpen: (open: boolean) => void;
}) {
	const { t } = useT();

	if (!isValidElement(trigger)) return null;

	// Clone the caller's button so it opens the sheet. We do NOT overwrite its
	// className or data-testid — Slot/cloneElement merge, so the caller's own
	// chrome and trigger testid are preserved exactly.
	const mobileTrigger = cloneElement(trigger, {
		onClick: () => setOpen(true),
	} as Record<string, unknown>);

	return (
		<>
			{mobileTrigger}
			<BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
				{items.length > 0 ? (
					<div className="max-h-[50vh] overflow-y-auto">
						{items.map((item) => (
							<button
								type="button"
								key={item.value}
								data-testid={itemTestId?.(item.value)}
								className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3"
								onClick={() => {
									onSelect(item.value);
									setOpen(false);
								}}
							>
								<div className="w-5 shrink-0 flex justify-center text-accent-t">
									{value === item.value && <Icons.Check />}
								</div>
								{item.leading}
								<div className="min-w-0 truncate">{item.label}</div>
							</button>
						))}
					</div>
				) : (
					<div className="px-5 py-4 text-[calc(var(--ui-fs)-1px)] text-t3">{emptyText}</div>
				)}
				{footer && <div className="mt-1 border-t border-border px-3 pt-1">{footer}</div>}
				<div className="mx-4 mt-2 h-px bg-border" />
				<button
					type="button"
					className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3"
					onClick={() => setOpen(false)}
				>
					{t("cancel")}
				</button>
			</BottomSheet>
		</>
	);
}
