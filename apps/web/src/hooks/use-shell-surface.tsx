/**
 * useShellSurface — the single shell-dispatch hook. Resolves concrete
 * { surface, leftChrome, topBar } elements (ready to drop in) from the active
 * chat's mode (ChatMode, snapshot store) + the play/build toggle (navigation
 * store) + platform. Joins the registry package (names) with the surface-parts
 * catalog (components), clamps a build toggle down to play when the active
 * package has no build slot, and derives the chrome props internally.
 *
 * Option B (per SURFACE_REGISTRY_REPORT fix-step 1): returns DRESSED ELEMENTS
 * rather than bare component types, so AppShell is a pure single-lookup
 * consumer with zero per-component prop knowledge. Reads the stores directly;
 * tests set store state via `getState()` (no vi.mock needed).
 *
 * This file is `.tsx` (the report draft first had `.ts`) because option B
 * returns JSX elements — a direct consequence of choosing dressed elements.
 *
 * Nothing consumes this hook until fix-step 2 rewires AppShell onto it.
 *
 * See SURFACE_REGISTRY_REPORT.md fix-step 1.
 */
import type { ReactElement } from "react";
import { useIsMobile } from "./use-mobile.js";
import { useNavigationStore } from "../stores/index.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import {
	getChatModePackage,
	hasBuildSurface,
	type AppMode,
	type SurfacePlatform,
} from "../lib/chat-mode-registry.js";
import {
	SURFACE_LEFT_CHROME,
	SURFACE_SURFACES,
	SURFACE_TOP_BARS,
	type TopBarPartProps,
} from "../lib/surface-parts.js";

export interface ShellSurfaceProps {
	/** Whether the mobile rail is currently open (drives the rail `hidden` flag). */
	showRail: boolean;
	/** Callback to open the mobile rail (passed to both top bars). */
	onShowRail: () => void;
	/** Update-notification payload; passed only to the RP TopBar (CoauthorTopBar ignores it). */
	update: { latestVersion: string; releaseUrl: string } | null;
}

export interface ResolvedShell {
	/** Central panel (PlayMode / BuildMode / CoauthorMode) — no shell-injected props. */
	surface: ReactElement;
	/** Left chrome, already platform-resolved and prop-dressed (mobile takes `hidden`). */
	leftChrome: ReactElement<{ hidden?: boolean }>;
	/** Top bar, already prop-dressed (railHidden / onShowRail / update). */
	topBar: ReactElement<TopBarPartProps>;
	/** The platform the shell resolved for. */
	platform: SurfacePlatform;
}

/**
 * Resolve the active shell. Always called (rules of hooks) — AppShell may
 * ignore the result in empty states (no active snapshot / first-time setup);
 * those guards are AppShell's concern, not the hook's.
 */
export function useShellSurface({ showRail, onShowRail, update }: ShellSurfaceProps): ResolvedShell {
	const isMobile = useIsMobile();
	const platform: SurfacePlatform = isMobile ? "mobile" : "desktop";
	const navMode = useNavigationStore((s) => s.mode);
	const activeChat = useSnapshotStore((s) => s.activeChat);

	// chatMode drives the package; the navigation mode only contributes the
	// play/build editing axis.
	const chatMode = activeChat?.mode ?? "rp";
	const pkg = getChatModePackage(chatMode);

	// Narrow the navigation mode to the editing axis. During the transition
	// (before fix-step 4 collapses `coauthor` out of AppMode), navMode may still
	// be "coauthor" — anything that is not a real "build" is treated as "play",
	// and chatMode (not navMode) drives the package, so this is safe.
	const requestedAxis: AppMode = navMode === "build" ? "build" : "play";

	// Clamp: if the toggle is "build" but this mode has no build surface (e.g.
	// coauthor), fall back to play. Preserves the toggle as user intent, never
	// renders an impossible build screen.
	const useBuildSlot = requestedAxis === "build" && hasBuildSurface(chatMode);
	const slot = useBuildSlot && pkg.build ? pkg.build : pkg.play;

	const Surface = SURFACE_SURFACES[slot.surface];
	const chromePair = SURFACE_LEFT_CHROME[slot.leftChrome];
	const TopBar = SURFACE_TOP_BARS[slot.topBar];

	// Desktop chrome takes no args; mobile chrome takes `hidden`. The two have
	// different prop signatures, so branch on platform to keep this type-safe
	// (no narrowing cast) rather than indexing a union.
	const leftChrome: ReactElement<{ hidden?: boolean }> =
		platform === "mobile" ? <chromePair.mobile hidden={!showRail} /> : <chromePair.desktop />;

	return {
		surface: <Surface />,
		leftChrome,
		topBar: (
			<TopBar
				railHidden={platform === "mobile" && !showRail}
				onShowRail={onShowRail}
				update={update}
			/>
		),
		platform,
	};
}
