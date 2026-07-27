/**
 * Pure-logic contracts for the chat-mode shell registry (`chat-mode-registry.ts`).
 * This file holds NO component imports (that is the whole point — it stays
 * leaf-like), so these tests render nothing and only assert the descriptor
 * shape: the static manifest, the lookup fallback, the build-surface predicate,
 * and the flat route list that the wouter hand-off consumes.
 *
 * See SURFACE_REGISTRY_REPORT.md fix-step 1b.
 */
import { describe, expect, it } from "bun:test";
import {
	CHAT_MODE_PACKAGES,
	getChatModePackage,
	getShellRoutes,
	hasBuildSurface,
} from "./chat-mode-registry.js";

describe("chat-mode-registry", () => {
	describe("getChatModePackage", () => {
		it("returns the rp package with play + build slots", () => {
			const rp = getChatModePackage("rp");
			expect(rp.chatMode).toBe("rp");
			expect(rp.play).toEqual({ surface: "PlayMode", leftChrome: "default", topBar: "default" });
			expect(rp.build).toEqual({ surface: "BuildMode", leftChrome: "default", topBar: "default" });
			expect(rp.routes).toEqual({ play: "/play", build: "/build" });
		});

		it("returns the coauthor package with play only (no build)", () => {
			const co = getChatModePackage("coauthor");
			expect(co.chatMode).toBe("coauthor");
			expect(co.play).toEqual({ surface: "CoauthorMode", leftChrome: "coauthor", topBar: "coauthor", rightPanel: "CoauthorEditor" });
			expect(co.build).toBeUndefined();
			expect(co.routes).toEqual({ play: "/coauthor" });
		});

		it("falls back to the rp package for unknown / undefined / null (reserved modes share this path)", () => {
			const fallback = CHAT_MODE_PACKAGES[0];
			expect(getChatModePackage(undefined)).toBe(fallback);
			expect(getChatModePackage(null)).toBe(fallback);
			// Reserved-but-unimplemented novel/group are not in the manifest → rp fallback.
			expect(getChatModePackage("novel" as never)).toBe(fallback);
			expect(getChatModePackage("group" as never)).toBe(fallback);
		});
	});

	describe("hasBuildSurface", () => {
		it("rp has a build surface", () => expect(hasBuildSurface("rp")).toBe(true));
		it("coauthor has no build surface", () => expect(hasBuildSurface("coauthor")).toBe(false));
		it("falls back to rp (which HAS build) for an unknown mode", () => {
			expect(hasBuildSurface(undefined)).toBe(true);
		});
	});

	describe("getShellRoutes", () => {
		it("emits one play row per package + a build row only where a build surface exists", () => {
			// coauthor declares no build surface → no /coauthor build route.
			expect(getShellRoutes()).toEqual([
				{ path: "/play", chatMode: "rp", appMode: "play" },
				{ path: "/build", chatMode: "rp", appMode: "build" },
				{ path: "/coauthor", chatMode: "coauthor", appMode: "play" },
			]);
		});
	});

	describe("manifest integrity", () => {
		it("every play slot names all three parts", () => {
			for (const pkg of CHAT_MODE_PACKAGES) {
				expect(pkg.play.surface, `${pkg.chatMode}.play.surface`).toBeTruthy();
				expect(pkg.play.leftChrome, `${pkg.chatMode}.play.leftChrome`).toBeTruthy();
				expect(pkg.play.topBar, `${pkg.chatMode}.play.topBar`).toBeTruthy();
			}
		});

		it("rightPanel is declared ONLY by modes that own a desktop side column (coauthor)", () => {
			const withPanel = CHAT_MODE_PACKAGES.filter((p) => p.play.rightPanel);
			expect(withPanel.map((p) => p.chatMode)).toEqual(["coauthor"]);
			expect(getChatModePackage("coauthor").play.rightPanel).toBe("CoauthorEditor");
			expect(getChatModePackage("rp").play.rightPanel).toBeUndefined();
		});

		it("every build slot (when present) names all three parts", () => {
			for (const pkg of CHAT_MODE_PACKAGES) {
				if (!pkg.build) continue;
				expect(pkg.build.surface, `${pkg.chatMode}.build.surface`).toBeTruthy();
				expect(pkg.build.leftChrome, `${pkg.chatMode}.build.leftChrome`).toBeTruthy();
				expect(pkg.build.topBar, `${pkg.chatMode}.build.topBar`).toBeTruthy();
			}
		});

		it("every package has a play route; build route only when a build slot exists", () => {
			for (const pkg of CHAT_MODE_PACKAGES) {
				expect(pkg.routes.play, `${pkg.chatMode}.routes.play`).toBeTruthy();
				expect(pkg.routes.build === undefined).toBe(pkg.build === undefined);
			}
		});
	});
});
