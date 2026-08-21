/**
 * Catch builtin visual boundary test (REALTIME_EXPERIENCE_MODE_PLAN, RM-12d).
 *
 * The missing coverage that let a view-shape bug ship: every RM-12 test drove
 * the RULES (kernel determinism) or the frame document (purity/escaping), but
 * nothing ever delivered a realtime projection to the REAL catch visual. The
 * realtime loop dispatches the FLAT `project()` return (`{score,misses,px,ball,
 * over}`) over `vt-loop:view`; the starter visual read `view.state` (the
 * TURN-mode wrapper) — so every frame rendered defaults: HUD frozen at 0, ball
 * parked at its fallback, while the round ran underneath and the finish
 * overlay popped "Score: 1 / Misses: 3" out of nowhere.
 *
 * This test evals the real SDK string + the real CATCH_VISUAL_SOURCE into a
 * happy-dom document exactly the way the frame does (no mocks between the
 * CustomEvent surface and the visual), then drives flat views / the finish
 * payload / a loop error through `window` and asserts what the user sees.
 */
import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { CATCH_VISUAL_SOURCE } from "@vibe-tavern/domain/builtins";
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

describe("catch builtin visual — realtime view contract", () => {
	test("flat vt-loop:view projections drive the HUD (not view.state)", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(CATCH_VISUAL_SOURCE);

		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 0");

		// The exact payload shape startExperienceLoopHost dispatches per frame.
		window.dispatchEvent(
			new CustomEvent("vt-loop:view", {
				detail: { score: 2, misses: 1, px: 0.7, ball: { x: 0.4, y: 0.5 }, over: false },
			}),
		);
		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 2");
		expect(document.getElementById("xp-misses")?.textContent).toBe("Misses: 1");

		// A later frame updates in place (the pre-fix bug left these at 0).
		window.dispatchEvent(
			new CustomEvent("vt-loop:view", {
				detail: { score: 3, misses: 2, px: 0.3, ball: { x: 0.6, y: 0.7 }, over: false },
			}),
		);
		expect(document.getElementById("xp-score")?.textContent).toBe("Score: 3");
		expect(document.getElementById("xp-misses")?.textContent).toBe("Misses: 2");
	});

	test("vt-loop:finish renders the terminal card from finalState", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(CATCH_VISUAL_SOURCE);

		const overlay = document.getElementById("xp-overlay");
		expect(overlay).toBeTruthy();

		window.dispatchEvent(
			new CustomEvent("vt-loop:finish", {
				detail: {
					status: "completed",
					finalState: { score: 2, misses: 3, px: 0.5, ball: { x: 0.5, y: 0.84, vx: 0, vy: 0.2 }, over: true },
					log: [],
				},
			}),
		);
		expect(overlay?.style.display).toBe("flex");
		expect(document.getElementById("xp-over-title")?.textContent).toBe("Round finished");
		expect(document.getElementById("xp-over-body")?.textContent).toBe("Score: 2 / Misses: 3");
	});

	test("vt-loop:error surfaces in the overlay instead of a silent dead frame", () => {
		new Function(VIBE_EXPERIENCE_SDK_SOURCE)();
		installVisual(CATCH_VISUAL_SOURCE);

		window.dispatchEvent(
			new CustomEvent("vt-loop:error", { detail: { kind: "boot_failed", message: "boom" } }),
		);
		expect(document.getElementById("xp-overlay")?.style.display).toBe("flex");
		expect(document.getElementById("xp-over-body")?.textContent).toBe("boom");
	});
});
