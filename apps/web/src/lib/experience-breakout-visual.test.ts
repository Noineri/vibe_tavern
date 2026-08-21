/**
 * Breakout builtin visual boundary test (REALTIME_EXPERIENCE_MODE_PLAN, RM-12e).
 *
 * The missing coverage that let the RM-12d view-shape bug ship: every earlier
 * test drove the RULES (kernel determinism) or the frame document
 * (purity/escaping), but nothing ever delivered a realtime projection to the
 * REAL builtin visual. The realtime loop dispatches the FLAT `project()`
 * return (`{score,lives,px,ball,bricks,over,won}`) over `vt-loop:view`; a
 * visual that reads the TURN-mode wrapper (`view.state`) renders defaults
 * every frame — HUD frozen, ball parked — while the round runs underneath.
 *
 * This test evals the real SDK string + the real BREAKOUT_VISUAL_SOURCE into
 * a happy-dom document exactly the way the frame does (no mocks between the
 * CustomEvent surface and the visual), then drives flat views / the finish
 * payload / a loop error through `window` and asserts what the user sees.
 */
import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { BREAKOUT_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "./experience-sdk.js";

useDomEnv();

/** Install a visual source (style + markup + script) the way the frame does:
 *  parse it into an inert template, mount the non-script nodes, then eval the
 *  script against the live document. */
function installVisual(source: string): void {
	const tpl = document.createElement("template");
	tpl.innerHTML = source;
	const nodes = [...tpl.content.childNodes];
	for (const node of nodes) {
		if (node.nodeType === 1 && (node as Element).tagName === "SCRIPT") continue;
		document.body.append(node);
	}
	for (const node of nodes) {
		if (node.nodeType === 1 && (node as Element).tagName === "SCRIPT") {
			new Function((node as HTMLScriptElement).textContent ?? "")();
		}
	}
}

describe("breakout builtin visual — realtime view contract", () => {
	test("flat vt-loop:view projections drive the HUD, not view.state", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(BREAKOUT_VISUAL_SOURCE);

		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 0");
		expect(document.getElementById("xp-lives")?.textContent).toBe("●●●");

		// The exact payload shape startExperienceLoopHost dispatches per frame.
		window.dispatchEvent(
			new CustomEvent("vt-loop:view", {
				detail: { score: 12, lives: 2, px: 0.7, ball: { x: 0.4, y: 0.5 }, bricks: 0x00ffff0f, over: false, won: false },
			}),
		);
		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 12");
		expect(document.getElementById("xp-lives")?.textContent).toBe("●●");

		// A later frame updates in place (a view.state-only read left these at 0).
		window.dispatchEvent(
			new CustomEvent("vt-loop:view", {
				detail: { score: 15, lives: 1, px: 0.3, ball: { x: 0.6, y: 0.7 }, bricks: 0x0000ff0f, over: false, won: false },
			}),
		);
		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 15");
		expect(document.getElementById("xp-lives")?.textContent).toBe("●");
	});

	test("vt-loop:finish renders the terminal card from finalState (win + loss shapes)", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(BREAKOUT_VISUAL_SOURCE);

		const overlay = document.getElementById("xp-overlay");
		expect(overlay).toBeTruthy();

		window.dispatchEvent(
			new CustomEvent("vt-loop:finish", {
				detail: {
					status: "completed",
					finalState: { score: 64, lives: 1, px: 0.5, ball: { x: 0.5, y: 0.6 }, bricks: 0, over: true, won: true },
					log: [],
				},
			}),
		);
		expect(overlay?.style.display).toBe("flex");
		expect(document.getElementById("xp-over-title")?.textContent).toBe("Field cleared!");
		expect(document.getElementById("xp-over-body")?.textContent).toBe("Score: 64");

		window.dispatchEvent(
			new CustomEvent("vt-loop:finish", {
				detail: {
					status: "completed",
					finalState: { score: 22, lives: 0, px: 0.5, ball: { x: 0.5, y: 1.2 }, bricks: 0x00ffff0f, over: true, won: false },
					log: [],
				},
			}),
		);
		// 0x00ffff0f has 16 alive bits.
		expect(document.getElementById("xp-over-title")?.textContent).toBe("Round finished");
		expect(document.getElementById("xp-over-body")?.textContent).toBe("Score: 22 / Bricks left: 20");
	});

	test("vt-loop:error surfaces in the overlay instead of a silent dead frame", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(BREAKOUT_VISUAL_SOURCE);

		window.dispatchEvent(
			new CustomEvent("vt-loop:error", { detail: { kind: "boot_failed", message: "boom" } }),
		);
		expect(document.getElementById("xp-overlay")?.style.display).toBe("flex");
		expect(document.getElementById("xp-over-body")?.textContent).toBe("boom");
	});
});
