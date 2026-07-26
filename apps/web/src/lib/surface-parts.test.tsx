import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
/**
 * Catalog contracts for `surface-parts.tsx` — the ONLY file that maps the
 * registry's named parts to concrete components. Two invariants are pinned:
 *
 * 1. COMPLETENESS — every name referenced by `CHAT_MODE_PACKAGES` (across play
 *    + build slots) resolves to a defined catalog entry. A typo'd name in the
 *    registry would otherwise produce `undefined` at runtime; this fails it in
 *    the test suite instead.
 * 2. IDENTITY — each catalog entry IS the component it claims to be (PlayMode
 *    is PlayMode, not BuildMode). Catches a swapped mapping that completeness
 *    alone would miss.
 *
 * See SURFACE_REGISTRY_REPORT.md fix-step 1b.
 */
import { describe, expect, it } from "bun:test";
import { CHAT_MODE_PACKAGES } from "./chat-mode-registry.js";
import { SURFACE_LEFT_CHROME, SURFACE_RIGHT_PANELS, SURFACE_SURFACES, SURFACE_TOP_BARS } from "./surface-parts.js";
import { PlayMode } from "../components/play/PlayMode.js";
import { BuildMode } from "../components/build/BuildMode.js";
import { CoauthorMode } from "../components/coauthor/CoauthorMode.js";
import { CoauthorEditorPanel } from "../components/coauthor/CoauthorEditorPanel.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { Rail } from "../components/layout/Rail.js";
import { CoauthorSidebar } from "../components/coauthor/CoauthorSidebar.js";
import { CoauthorRail } from "../components/coauthor/CoauthorRail.js";
import { TopBar } from "../components/layout/TopBar.js";
import { CoauthorTopBar } from "../components/coauthor/CoauthorTopBar.js";

/** Collect every (slot, name) pair the registry references. */
function registryNames(): { slot: "surface" | "leftChrome" | "topBar" | "rightPanel"; name: string }[] {
	const pairs: { slot: "surface" | "leftChrome" | "topBar" | "rightPanel"; name: string }[] = [];
	for (const pkg of CHAT_MODE_PACKAGES) {
		for (const slot of [pkg.play, pkg.build] as const) {
			if (!slot) continue;
			pairs.push(
				{ slot: "surface", name: slot.surface },
				{ slot: "leftChrome", name: slot.leftChrome },
				{ slot: "topBar", name: slot.topBar },
			);
			if (slot.rightPanel) pairs.push({ slot: "rightPanel", name: slot.rightPanel });
		}
	}
	return pairs;
}

describe("surface-parts catalog", () => {
	describe("completeness — every registry name resolves", () => {
		const pairs = registryNames();

		it("all surface names resolve to a component", () => {
			for (const p of pairs) {
				if (p.slot !== "surface") continue;
				expect(SURFACE_SURFACES[p.name], `surface "${p.name}"`).toBeDefined();
			}
		});

		it("all leftChrome names resolve to a desktop+mobile pair", () => {
			for (const p of pairs) {
				if (p.slot !== "leftChrome") continue;
				const part = SURFACE_LEFT_CHROME[p.name];
				expect(part, `leftChrome "${p.name}"`).toBeDefined();
				expect(part.desktop, `leftChrome "${p.name}".desktop`).toBeDefined();
				expect(part.mobile, `leftChrome "${p.name}".mobile`).toBeDefined();
			}
		});

		it("all topBar names resolve to a component", () => {
			for (const p of pairs) {
				if (p.slot !== "topBar") continue;
				expect(SURFACE_TOP_BARS[p.name], `topBar "${p.name}"`).toBeDefined();
			}
		});

		it("all rightPanel names resolve to a component", () => {
			for (const p of pairs) {
				if (p.slot !== "rightPanel") continue;
				expect(SURFACE_RIGHT_PANELS[p.name], `rightPanel "${p.name}"`).toBeDefined();
			}
		});
	});

	describe("identity — each entry is the component it claims to be", () => {
		it("surfaces", () => {
			expect(SURFACE_SURFACES.PlayMode).toBe(PlayMode);
			expect(SURFACE_SURFACES.BuildMode).toBe(BuildMode);
			expect(SURFACE_SURFACES.CoauthorMode).toBe(CoauthorMode);
		});

		it("left chrome pairs (desktop + mobile)", () => {
			expect(SURFACE_LEFT_CHROME.default.desktop).toBe(Sidebar);
			expect(SURFACE_LEFT_CHROME.default.mobile).toBe(Rail);
			expect(SURFACE_LEFT_CHROME.coauthor.desktop).toBe(CoauthorSidebar);
			expect(SURFACE_LEFT_CHROME.coauthor.mobile).toBe(CoauthorRail);
		});

		it("top bars", () => {
			expect(SURFACE_TOP_BARS.default).toBe(TopBar);
			expect(SURFACE_TOP_BARS.coauthor).toBe(CoauthorTopBar);
		});

		it("right panels", () => {
			expect(SURFACE_RIGHT_PANELS.CoauthorEditor).toBe(CoauthorEditorPanel);
		});
	});
});
