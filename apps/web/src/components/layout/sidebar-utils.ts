/**
 * Pure positioning + date-format helpers shared by the layout shells.
 *
 * Extracted from `Sidebar.tsx` (SF-3) so the co-author shell fork can consume
 * them without copying. The desktop `Sidebar` is the only consumer today (the
 * mobile `Rail` renders via a bottom-sheet, not a portaled popover, and shows
 * no dates in its rows); `CoauthorSidebar` / `CoauthorRail` will import from
 * here when they land (SF-4 / SF-5).
 *
 * All functions are pure — no component state, no store reads. DOM-geometry
 * helpers take the trigger element and return viewport-relative coords for a
 * portaled dropdown (portaled to `document.body` because the sidebar/rail root
 * is a CSS backdrop root — see the in-component comment on charSwitcherPos).
 */

import { resolveEntityAvatarUrl } from "../../lib/avatar.js";

/** Resolve a character tab's avatar URL (folder avatar when migrated). Pure. */
export function tabAvatarSrc(tab: { id: string; avatarExt: string | null; avatarAssetId: string | null; updatedAt?: string | null }): string | null {
	return resolveEntityAvatarUrl({ kind: "characters", id: tab.id, avatarExt: tab.avatarExt, avatarAssetId: tab.avatarAssetId, updatedAt: tab.updatedAt });
}

/**
 * Position a portaled dropdown below its trigger, matching the trigger's width.
 * Portaled to body (see charSwitcherPos comment in Sidebar.tsx — the sidebar
 * root is a glass/backdrop-blur root, so an in-tree dropdown can't frost the
 * lava behind it).
 */
export function calcSwitcherPos(triggerEl: HTMLElement): { top: number; left: number; width: number } {
	const rect = triggerEl.getBoundingClientRect();
	return { top: rect.bottom + 4, left: rect.left, width: rect.width };
}

/** Short absolute date (e.g. "Jul 3"). Empty for null/invalid input. */
export function formatShortDate(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Relative time (e.g. "2h ago"), falling back to {@link formatShortDate} beyond a week. */
export function formatRelativeTime(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const diffSec = (Date.now() - date.getTime()) / 1000;
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
	if (diffSec < 45) return rtf.format(0, "second");
	if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
	if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
	if (diffSec < 604800) return rtf.format(-Math.round(diffSec / 86400), "day");
	return formatShortDate(value);
}
