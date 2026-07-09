/**
 * Flyout positioning — the shared layout effect that computes where the
 * collapsed-sidebar character flyout (the chat popover that opens on avatar
 * hover) should sit, flipping it above the avatar when there isn't enough room
 * below.
 *
 * Extracted verbatim from `Sidebar.tsx` and `CoauthorSidebar.tsx`, where it was
 * byte-for-byte identical (SIDEBAR_GOD_OBJECT_AUDIT step 1). Both desktop
 * sidebars feed it the same four inputs — the open flyout character id, the
 * avatar's measured {top,bottom}, and the panel/list refs — and read back the
 * three positioning values they pass to `<SidebarFlyout>`. Inputs and outputs
 * match the originals exactly; this is a behavior-preserving move, not a
 * redesign.
 *
 * The effect re-runs only on `flyoutCharId` / `flyoutAvatarPos` changes — the
 * refs are stable across renders and intentionally omitted from the dependency
 * array, matching the original inline effect.
 */
import { useState, useLayoutEffect, type RefObject } from "react";

/** Measured viewport position of the trigger avatar. */
export interface FlyoutAvatarPos {
	readonly top: number;
	readonly bottom: number;
}

/** Computed flyout placement, returned to the caller for `<SidebarFlyout>`. */
export interface FlyoutPosition {
	/** Pixel offset for the flyout panel's `top`, or `null` when closed/hidden. */
	readonly top: number | null;
	/** Max-height constraint for the flyout list, or `null` when closed/hidden. */
	readonly maxH: number | null;
	/** Whether the flyout was flipped to open above the avatar. */
	readonly flipped: boolean;
}

/**
 * @param flyoutCharId    The character id whose flyout is open, or `null`.
 * @param flyoutAvatarPos The measured {top, bottom} of the trigger avatar, or `null`.
 * @param flyoutRef       Ref to the flyout panel element.
 * @param flyoutListRef   Ref to the inner scrollable list element.
 */
export function useFlyoutPosition(
	flyoutCharId: string | null,
	flyoutAvatarPos: FlyoutAvatarPos | null,
	flyoutRef: RefObject<HTMLDivElement | null>,
	flyoutListRef: RefObject<HTMLDivElement | null>,
): FlyoutPosition {
	const [top, setTop] = useState<number | null>(null);
	const [maxH, setMaxH] = useState<number | null>(null);
	const [flipped, setFlipped] = useState(false);

	useLayoutEffect(() => {
		if (!flyoutCharId || flyoutAvatarPos == null) {
			setTop(null);
			setMaxH(null);
			setFlipped(false);
			return;
		}
		const panel = flyoutRef.current;
		const list = flyoutListRef.current;
		if (!panel || !list) return;
		const vh = window.innerHeight;
		const spaceBelow = vh - flyoutAvatarPos.top - 12;
		const spaceAbove = flyoutAvatarPos.bottom - 12;
		const naturalH = list.scrollHeight + (panel.clientHeight - list.clientHeight);
		if (naturalH <= spaceBelow || spaceBelow >= spaceAbove) {
			setFlipped(false);
			setTop(flyoutAvatarPos.top);
			setMaxH(Math.max(spaceBelow, 0));
		} else {
			setFlipped(true);
			const h = Math.min(naturalH, spaceAbove);
			setTop(flyoutAvatarPos.bottom - h);
			setMaxH(Math.max(spaceAbove, 0));
		}
	}, [flyoutCharId, flyoutAvatarPos]);

	return { top, maxH, flipped };
}
