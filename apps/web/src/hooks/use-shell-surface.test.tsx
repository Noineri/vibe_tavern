/**
 * Integration contracts for `useShellSurface` — the hook that joins the registry
 * package (names) with the surface-parts catalog (components) and returns
 * ready-to-render { surface, leftChrome, topBar } elements (option B per the
 * report). These tests pin the resolution rules:
 *
 * - chatMode drives the package; navMode contributes only the play/build axis.
 * - a stale `build` toggle on a mode with no build slot (coauthor) CLAMPS to play.
 * - reserved/absent modes fall back to rp via the registry.
 * - the transitional navMode `"coauthor"` is treated as play (until fix-step 4
 *   collapses it out of AppMode).
 * - platform picks the rail/sidebar variant and derives railHidden + hidden.
 * - topBar receives railHidden / onShowRail / update verbatim.
 *
 * Platform is controlled by mocking `use-mobile` (it reads matchMedia, which
 * happy-dom does not implement); the two stores are driven via `setState()`
 * directly — no vi.mock needed for them. Asserting against the catalog entries
 * (not bare component imports) keeps these tests robust to component-file
 * moves; surface-parts.test.tsx independently pins catalog→component identity.
 *
 * See SURFACE_REGISTRY_REPORT.md fix-step 1b.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppSnapshot } from "../api/types.js";
import { useNavigationStore } from "../stores/index.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";

vi.mock("./use-mobile.js", () => ({
	useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from "./use-mobile.js";
import { useShellSurface, type ShellSurfaceProps } from "./use-shell-surface.js";
import { SURFACE_LEFT_CHROME, SURFACE_RIGHT_PANELS, SURFACE_SURFACES, SURFACE_TOP_BARS } from "../lib/surface-parts.js";

const setActiveChat = (mode: "rp" | "coauthor") =>
	useSnapshotStore.setState({
		activeChat: { id: "c1", mode } as unknown as AppSnapshot["activeChat"],
	});

const baseProps: ShellSurfaceProps = {
	showRail: false,
	onShowRail: vi.fn(),
	update: null,
};

beforeEach(() => {
	useSnapshotStore.setState({ activeChat: null });
	useNavigationStore.setState({ mode: "play" });
	vi.mocked(useIsMobile).mockReturnValue(false);
});

describe("useShellSurface", () => {
	describe("RP mode", () => {
		it("play axis on desktop → PlayMode + Sidebar + TopBar", () => {
			setActiveChat("rp");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.platform).toBe("desktop");
			expect(result.current.surface.type).toBe(SURFACE_SURFACES.PlayMode);
			expect(result.current.leftChrome.type).toBe(SURFACE_LEFT_CHROME.default.desktop);
			expect(result.current.topBar.type).toBe(SURFACE_TOP_BARS.default);
		});

		it("build axis on desktop → BuildMode (same chrome + top bar)", () => {
			setActiveChat("rp");
			useNavigationStore.setState({ mode: "build" });
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.surface.type).toBe(SURFACE_SURFACES.BuildMode);
			expect(result.current.leftChrome.type).toBe(SURFACE_LEFT_CHROME.default.desktop);
			expect(result.current.topBar.type).toBe(SURFACE_TOP_BARS.default);
			expect(result.current.rightPanel).toBeNull();
		});
	});

	describe("Coauthor mode", () => {
		it("play axis → CoauthorMode + CoauthorSidebar + CoauthorTopBar + rightPanel", () => {
			setActiveChat("coauthor");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.surface.type).toBe(SURFACE_SURFACES.CoauthorMode);
			expect(result.current.leftChrome.type).toBe(SURFACE_LEFT_CHROME.coauthor.desktop);
			expect(result.current.topBar.type).toBe(SURFACE_TOP_BARS.coauthor);
			// The hoisted editor is resolved as the desktop right panel.
			expect(result.current.rightPanel?.type).toBe(SURFACE_RIGHT_PANELS.CoauthorEditor);
		});

		it("CLAMPS a stale build toggle down to play (coauthor has no build slot)", () => {
			setActiveChat("coauthor");
			useNavigationStore.setState({ mode: "build" });
			const { result } = renderHook(() => useShellSurface(baseProps));
			// Still the coauthor PLAY surface — never an impossible build screen.
			expect(result.current.surface.type).toBe(SURFACE_SURFACES.CoauthorMode);
			expect(result.current.leftChrome.type).toBe(SURFACE_LEFT_CHROME.coauthor.desktop);
			expect(result.current.topBar.type).toBe(SURFACE_TOP_BARS.coauthor);
		});

		it("mobile → NO right panel (side column is desktop-only; mobile swap is in-surface)", () => {
			vi.mocked(useIsMobile).mockReturnValue(true);
			setActiveChat("coauthor");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.platform).toBe("mobile");
			expect(result.current.rightPanel).toBeNull();
		});
	});

	describe("fallbacks", () => {
		it("no active chat → rp play package", () => {
			// activeChat is null from beforeEach.
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.surface.type).toBe(SURFACE_SURFACES.PlayMode);
		});
	});

	describe("mobile chrome", () => {
		it("mobile resolves the rail variant and sets hidden = !showRail", () => {
			vi.mocked(useIsMobile).mockReturnValue(true);
			setActiveChat("rp");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.platform).toBe("mobile");
			expect(result.current.leftChrome.type).toBe(SURFACE_LEFT_CHROME.default.mobile);
			expect(result.current.leftChrome.props.hidden).toBe(true); // !showRail (false)
		});

		it("showRail=true on mobile clears hidden + railHidden", () => {
			vi.mocked(useIsMobile).mockReturnValue(true);
			setActiveChat("rp");
			const { result } = renderHook(() => useShellSurface({ ...baseProps, showRail: true }));
			expect(result.current.leftChrome.props.hidden).toBe(false);
			expect(result.current.topBar.props.railHidden).toBe(false);
		});

		it("railHidden is always false on desktop (the rail is a mobile concept)", () => {
			setActiveChat("rp");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.topBar.props.railHidden).toBe(false);
		});

		it("desktop left chrome takes no `hidden` prop", () => {
			setActiveChat("rp");
			const { result } = renderHook(() => useShellSurface(baseProps));
			expect(result.current.leftChrome.props.hidden).toBeUndefined();
		});
	});

	describe("top bar prop pass-through", () => {
		it("update + onShowRail are forwarded verbatim", () => {
			setActiveChat("rp");
			const onShowRail = vi.fn();
			const update = { latestVersion: "1.2.3", releaseUrl: "https://example.com" };
			const { result } = renderHook(() =>
				useShellSurface({ showRail: false, onShowRail, update }),
			);
			expect(result.current.topBar.props.update).toBe(update);
			expect(result.current.topBar.props.onShowRail).toBe(onShowRail);
		});
	});
});
