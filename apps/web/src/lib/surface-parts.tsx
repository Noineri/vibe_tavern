/**
 * Surface-parts catalog — the ONLY file that imports the concrete shell
 * components, mapping each named part from `chat-mode-registry.ts` to its
 * component. Split per slot (central surface / left chrome / top bar) because
 * the three slot kinds have different prop signatures: central surfaces take no
 * args, left chrome is a platform pair (desktop takes no args, mobile takes
 * `hidden`), and top bars take `railHidden`/`onShowRail` (RP TopBar also takes
 * `update`). A single flat record could not hold these without either a name
 * collision ("default" used for both leftChrome and topBar) or unsafe narrowing
 * casts; the per-slot split keeps every lookup type-safe.
 *
 * Keeping the catalog out of the registry lets the registry stay pure (names
 * only) and unit-testable, while the catalog is the single swappable seam
 * between names and components.
 *
 * See SURFACE_REGISTRY_REPORT.md.
 */
import type { ComponentType } from "react";
import { Sidebar } from "../components/layout/Sidebar.js";
import { Rail } from "../components/layout/Rail.js";
import { CoauthorSidebar } from "../components/coauthor/CoauthorSidebar.js";
import { CoauthorRail } from "../components/coauthor/CoauthorRail.js";
import { TopBar } from "../components/layout/TopBar.js";
import { CoauthorTopBar } from "../components/coauthor/CoauthorTopBar.js";
import { PlayMode } from "../components/play/PlayMode.js";
import { BuildMode } from "../components/build/BuildMode.js";
import { CoauthorMode } from "../components/coauthor/CoauthorMode.js";
import { CoauthorEditorPanel } from "../components/coauthor/CoauthorEditorPanel.js";

/** Props every top bar accepts. CoauthorTopBar ignores `update` (it accepts a subset). */
export interface TopBarPartProps {
	railHidden?: boolean;
	onShowRail?: () => void;
	update?: { latestVersion: string; releaseUrl: string } | null;
}

/** A top bar component — accepts the union of every top bar's props. */
export type TopBarComponent = ComponentType<TopBarPartProps>;

/** Left chrome is platform-aware: desktop takes no args, mobile takes `hidden`. */
export interface LeftChromePart {
	desktop: ComponentType;
	mobile: ComponentType<{ hidden?: boolean }>;
}

/** Central surface components — no-arg (PlayMode / BuildMode / CoauthorMode). */
export const SURFACE_SURFACES: Record<string, ComponentType> = {
	PlayMode,
	BuildMode,
	CoauthorMode,
};

/** Left chrome parts — keyed by the `leftChrome` name in a ShellSlotNames. */
export const SURFACE_LEFT_CHROME: Record<string, LeftChromePart> = {
	default: { desktop: Sidebar, mobile: Rail },
	coauthor: { desktop: CoauthorSidebar, mobile: CoauthorRail },
};

/** Top bar parts — keyed by the `topBar` name in a ShellSlotNames. */
export const SURFACE_TOP_BARS: Record<string, TopBarComponent> = {
	default: TopBar,
	coauthor: CoauthorTopBar,
};

/**
 * Right-panel parts — keyed by the `rightPanel` name in a ShellSlotNames. A
 * no-arg component reading its own stores (the co-author editor). Resolved
 * DESKTOP-ONLY by `useShellSurface` — mobile has no side column (see
 * ShellSlotNames.rightPanel + RIGHT_PANEL_SHELL_SLOT_REPORT variant B).
 */
export const SURFACE_RIGHT_PANELS: Record<string, ComponentType> = {
	CoauthorEditor: CoauthorEditorPanel,
};
