/**
 * Chat-mode shell registry — the declarative source of truth for which shell
 * surfaces (central play/build panel + left chrome + top bar) each chat mode
 * owns. One chat mode = one "package" of named parts. `useShellSurface()`
 * resolves a concrete (chatMode × appMode × platform) tuple to components via
 * `surface-parts.tsx`; THIS file holds only the pure descriptor data (parts
 * referenced by NAME, never by component import), so it stays leaf-like and
 * unit-testable without rendering anything.
 *
 * Mirrors the STATIC manifest shape of `themes/registry.ts` (a frozen array +
 * derived type + helpers), NOT the dynamic register/subscribe bus of
 * `build-panel-registry.ts` — chat modes are core to the monolith, not plugins.
 * If plugin-contributed modes ever become real, the static array upgrades to a
 * register/subscribe bus in one place without touching consumers.
 *
 * This is the prep layer for wouter: `getShellRoutes()` exports the flat route
 * list that `WOUTER_PERSIST_REPORT` consumes to generate `<Route>` entries; the
 * registry wires no router itself.
 *
 * See SURFACE_REGISTRY_REPORT.md.
 */
import type { ChatMode } from "@vibe-tavern/domain";

/**
 * The shell editing axis — orthogonal to `ChatMode`. `play` = interact with the
 * chat; `build` = edit the character/lore/script structure. `coauthor` is NOT an
 * AppMode — it is a `ChatMode`, and its package (below) declares the surfaces it
 * owns. Re-exported from `app-shell-types.ts` (the back-compat hub, mirroring
 * `ThemeMode`) for navigation-store + chat-actions.
 */
export const APP_MODES = ["play", "build"] as const;
export type AppMode = (typeof APP_MODES)[number];

/** The platform dimension the shell dispatches on. */
export type SurfacePlatform = "desktop" | "mobile";

/**
 * Part slots within one surface, each referenced by a catalog NAME (a key into
 * the per-slot maps in `surface-parts.tsx`), never by component. Splitting the
 * catalog per slot (surfaces / left-chrome / top-bars) lets the same name (e.g.
 * "default") resolve to a different component shape in different slots — the
 * flat single-record design the report draft proposed could not hold this
 * package's own data without a name collision.
 */
export interface ShellSlotNames {
	/** Central panel — a no-arg component (PlayMode / BuildMode / CoauthorMode). */
	surface: string;
	/** Left chrome — a platform-aware { desktop, mobile } pair. */
	leftChrome: string;
	/** Top bar — a chrome component taking railHidden/onShowRail/update. */
	topBar: string;
}

/**
 * One chat mode's shell package. `play` is required (every mode has a play
 * screen). `build` is optional: a mode with no build editor omits it, and the
 * shell clamps a stale `build` toggle down to `play` at render time (preserving
 * the toggle as user intent, never rendering an impossible build screen).
 * `routes` is the wouter hand-off — per-mode play/build paths.
 */
export interface ChatModePackage {
	chatMode: ChatMode;
	play: ShellSlotNames;
	build?: ShellSlotNames;
	routes: { play: string; build?: string };
}

/**
 * The static manifest of every chat mode's shell package.
 *
 * Reserved modes `novel`/`group` (in `CHAT_MODE`) have no entry yet — they fall
 * back to the rp package via `getChatModePackage`. Adding a real novel/group
 * shell is one entry here, nothing else in the dispatch chain changes.
 */
export const CHAT_MODE_PACKAGES: readonly ChatModePackage[] = [
	{
		chatMode: "rp",
		play: { surface: "PlayMode", leftChrome: "default", topBar: "default" },
		build: { surface: "BuildMode", leftChrome: "default", topBar: "default" },
		routes: { play: "/play", build: "/build" },
	},
	{
		chatMode: "coauthor",
		play: { surface: "CoauthorMode", leftChrome: "coauthor", topBar: "coauthor" },
		routes: { play: "/coauthor" },
	},
];

/**
 * Look up the shell package for a chat mode. Falls back to the rp package for an
 * unknown/undefined/absent mode (covers reserved-but-unimplemented modes like
 * `novel`/`group`, and chats whose `mode` field is missing).
 */
export function getChatModePackage(chatMode: ChatMode | undefined | null): ChatModePackage {
	return CHAT_MODE_PACKAGES.find((p) => p.chatMode === chatMode) ?? CHAT_MODE_PACKAGES[0];
}

/** True if the chat mode's package declares a build surface (rp: yes; coauthor: no). */
export function hasBuildSurface(chatMode: ChatMode | undefined | null): boolean {
	return getChatModePackage(chatMode).build != null;
}

/** One row of the flat route list exported for the wouter hand-off. */
export interface ShellRoute {
	path: string;
	chatMode: ChatMode;
	appMode: AppMode;
}

/**
 * Flat route list across all packages — the contract `WOUTER_PERSIST_REPORT`
 * consumes to generate wouter `<Route>` entries. One row per package's `play`
 * route, plus a `build` row only when the package declares a build surface (so
 * coauthor contributes just `/coauthor`, not a build route). Mobile routing
 * (`/m/*` vs shared routes) is decided in `WOUTER_PERSIST_REPORT`, not here.
 */
export function getShellRoutes(): readonly ShellRoute[] {
	return CHAT_MODE_PACKAGES.flatMap((pkg): ShellRoute[] => {
		const rows: ShellRoute[] = [{ path: pkg.routes.play, chatMode: pkg.chatMode, appMode: "play" }];
		if (pkg.build && pkg.routes.build) {
			rows.push({ path: pkg.routes.build, chatMode: pkg.chatMode, appMode: "build" });
		}
		return rows;
	});
}
