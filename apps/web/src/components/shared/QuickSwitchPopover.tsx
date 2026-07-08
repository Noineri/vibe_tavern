// Responsive dual-mode quick-switch — the shared primitive for value-pickers
// whose popover also carries a **footer action that opens a modal** (persona
// "manage personas", co-author module "manage modules").
//
// - **desktop** → Radix Popover (modal=false by default, so it does NOT lock
//   <body> pointer-events).
// - **mobile** → shared `BottomSheet` (vaul Drawer, thumb-friendly 52px rows,
//   swipe-to-dismiss). Per the project rule every mobile popover surfaces as a
//   bottom sheet.
//
// ## Why this exists separately from `ToolbarSelect`
//
// `ToolbarSelect` is built on Radix **Select**, whose `Select.Content`
// hardcodes `<DismissableLayer disableOutsidePointerEvents>` (see
// @radix-ui/react-select index.mjs — Select never received the `modal` prop
// PR #700 gave Dialog/Popover/ContextMenu/DropdownMenu). That layer
// save/restores `body.style.pointerEvents`, and because Select wraps its
// content in `<Presence>`, an exit animation keeps the layer mounted ~150ms
// after `setOpen(false)`. If a footer in that Select opens a Dialog in the
// same commit, the Dialog's own DismissableLayer snapshots a stale
// `pointer-events: none` and restores it on unmount — freezing the whole UI.
// (Pinned via a body-style MutationObserver trace; see the fix commit that
// introduced this split.)
//
// Popover's `modal` defaults to `false`, so `PopoverContentNonModal` renders
// `disableOutsidePointerEvents: false` — body is never touched, the
// save/restore contract is never in play, and the footer can mount a Dialog
// freely. Exit animations are therefore safe to keep (and do — Select's had
// to be stripped).
//
// ## When to use which
//
// - **QuickSwitchPopover** — small value-picker + a footer that opens another
//   overlay (modal/dialog). Use for: persona switch, co-author module switch.
// - **ToolbarSelect** — pure value-picker with no secondary action. Use for:
//   favorite/starred-model pills.
//
// Keyboard parity with Select is preserved manually: ArrowUp/Down/Home/End
// rove focus across the item buttons, Enter activates the focused one
// (native <button>). First-letter type-ahead is the only Select feature not
// carried over — these lists are tiny (≤ a handful), so type-ahead buys
// nothing and the roving focus already covers keyboard users.

import {
	cloneElement,
	isValidElement,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { Icons } from "./icons.js";
import { CustomTooltip } from "./Tooltip.js";
import { BottomSheet } from "./BottomSheet.js";
import { popoverMaxHeight } from "./popover-constants.js";
import { useT } from "../../i18n/context.js";

export interface QuickSwitchItem {
	/** Stable unique id; becomes the item's key and `data-active` match. Must be
	 *  a non-empty string. */
	value: string;
	/** Row text/content. */
	label: ReactNode;
	/** Optional leading node (avatar, icon) rendered before the label. */
	leading?: ReactNode;
}

interface QuickSwitchPopoverProps {
	/** Fork selector. Resolve with `useIsMobile()` in the router and pass the
	 *  result down — the desktop shell renders `<QuickSwitchPopover>` (default)
	 *  and the mobile shell renders `<QuickSwitchPopover mobile>`. Mirrors
	 *  ToolbarSelect / VariantJump. */
	mobile?: boolean;
	/** Optional controlled open state. The footer's modal-launch handler uses
	 *  this to dismiss the popover before opening the modal (`setOpen(false)` +
	 *  `setSomeModal(true)`). Unlike Select, this is NOT a body-lock leak
	 *  workaround here — Popover never locks body — but it is still the clean
	 *  way for an external footer action to close the popover. When omitted,
	 *  the primitive manages its own open state. */
	open?: boolean;
	/** Companion to `open`. Ignored when `open` is omitted. */
	onOpenChange?: (open: boolean) => void;
	/** A single `<button type="button">` element, WITHOUT an `onClick` — the
	 *  primitive attaches the open handler on both halves (Popover.Trigger on
	 *  desktop, the BottomSheet opener on mobile). Its `className` and any
	 *  `data-testid` are preserved verbatim, so each call site keeps its exact
	 *  chrome and the characterization tests keep resolving the trigger testid. */
	trigger: ReactElement;
	/** Desktop-only: wraps the trigger in a CustomTooltip. Ignored on mobile. */
	triggerTooltip?: string;
	/** Builds the per-row testid from the item value. The trigger testid stays
	 *  on the caller's own button (see `trigger`). */
	itemTestId?: (value: string) => string;
	/** Header shown above the list (desktop popover header / BottomSheet title). */
	title: ReactNode;
	/** The options. When empty, `emptyText` is rendered instead. */
	items: QuickSwitchItem[];
	/** Currently-selected value, or null for "nothing selected". */
	value: string | null;
	/** Fired with the chosen `value`. */
	onSelect: (value: string) => void;
	/** Shown in place of the list when `items` is empty. */
	emptyText?: ReactNode;
	/** Optional trailing row under the list (e.g. the "manage personas" /
	 *  "manage modules" link). Rendered inside the popover/sheet, above the
	 *  mobile cancel button. This is the slot that distinguishes this primitive
	 *  from ToolbarSelect — its onClick typically closes this popover and opens
	 *  a full modal (safe here because Popover holds no body lock). */
	footer?: ReactNode;
	/** Desktop popover geometry. Defaults reproduce the ToolbarSelect placement
	 *  (upward, end-aligned). Ignored on mobile. */
	side?: "top" | "bottom";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	/** Desktop popover width in px. Ignored on mobile (mobile sheet is full-width). */
	contentWidth?: number;
}

export function QuickSwitchPopover({
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
}: QuickSwitchPopoverProps) {
	// Controlled-or-uncontrolled open state. Resolved `open` / `setOpen` are
	// passed to BOTH halves so desktop (Popover.Root) and mobile (BottomSheet)
	// stay in sync. See the `open` prop doc for why a footer action uses this.
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = openProp !== undefined;
	const open = isControlled ? openProp : internalOpen;
	const setOpen = (next: boolean) => {
		if (!isControlled) setInternalOpen(next);
		onOpenChange?.(next);
	};

	if (mobile) {
		return (
			<QuickSwitchPopoverMobile
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

	const contentRef = useRef<HTMLDivElement>(null);

	// Roving focus across the item buttons — keyboard parity with Radix Select
	// (ArrowUp/Down/Home/End). Enter/Space are handled natively by the <button>s.
	// Type-ahead is intentionally NOT reimplemented (see the file header).
	function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		const nodes = contentRef.current?.querySelectorAll<HTMLElement>("[data-qsw-item]");
		if (!nodes || nodes.length === 0) return;
		const list = Array.from(nodes);
		const currentIndex = list.findIndex((el) => el === document.activeElement);
		if (e.key === "ArrowDown") {
			e.preventDefault();
			list[currentIndex === -1 ? 0 : (currentIndex + 1) % list.length].focus();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			list[currentIndex === -1 ? list.length - 1 : (currentIndex - 1 + list.length) % list.length].focus();
		} else if (e.key === "Home") {
			e.preventDefault();
			list[0].focus();
		} else if (e.key === "End") {
			e.preventDefault();
			list[list.length - 1].focus();
		}
	}

	// Nested asChild chain: CustomTooltip (when requested) → Popover.Trigger →
	// caller's button. Radix Slot composes, so ref / onClick / aria-expanded /
	// data-testid all flow through to the underlying <button>.
	const popoverTrigger = <Popover.Trigger asChild>{trigger}</Popover.Trigger>;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			{triggerTooltip ? (
				<CustomTooltip content={triggerTooltip}>{popoverTrigger}</CustomTooltip>
			) : (
				popoverTrigger
			)}
			<Popover.Portal>
				<Popover.Content
					ref={contentRef}
					side={side}
					sideOffset={sideOffset}
					align={align}
					onKeyDown={handleKeyDown}
					// Exit animation KEPT — Popover (modal=false) holds no body lock, so
					// Presence keeping content mounted ~150ms after close cannot leak
					// `pointer-events: none` the way Select's DismissableLayer does.
					className="glass-blur z-[220] overflow-hidden rounded-lg border border-border2 bg-glass-bg py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
					style={{ width: contentWidth }}
				>
					<div className="mb-1 border-b border-border px-4 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
						{title}
					</div>
					<div className="overflow-y-auto">
						{items.length > 0 ? (
							<div className="overflow-y-auto" style={{ maxHeight: popoverMaxHeight("singleLine") }}>
								{items.map((item) => (
									<button
										type="button"
										key={item.value}
										data-qsw-item
										data-testid={itemTestId?.(item.value)}
										data-active={value === item.value}
										onClick={() => {
											onSelect(item.value);
											setOpen(false);
										}}
										className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left font-ui text-[13px] text-t1 outline-none transition-colors hover:bg-s2 focus-visible:bg-s2 data-[active=true]:bg-accent-dim"
									>
										<span className="flex w-4 shrink-0 justify-center text-accent-t">
											{value === item.value && <Icons.Check />}
										</span>
										{item.leading && <span className="shrink-0">{item.leading}</span>}
										<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
											{item.label}
										</span>
									</button>
								))}
							</div>
						) : (
							<div className="px-4 py-2 font-ui text-[12px] text-t3">{emptyText}</div>
						)}
					</div>
					{footer && <div className="mt-1 border-t border-border px-2 pt-1">{footer}</div>}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function QuickSwitchPopoverMobile({
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
}: Pick<QuickSwitchPopoverProps, "trigger" | "itemTestId" | "title" | "items" | "value" | "onSelect" | "emptyText" | "footer"> & {
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
