import { describe, expect, it } from "bun:test";

import {
	visualPendingFromEffects,
	visualPendingFromPhase,
	type PendingEffectLike,
} from "./experience-pending.js";

describe("visualPendingFromPhase", () => {
	it("forwards typing and effect unchanged (model work gates the visual)", () => {
		expect(visualPendingFromPhase("typing")).toBe("typing");
		expect(visualPendingFromPhase("effect")).toBe("effect");
	});

	it("maps a timer-only phase to idle — a live timer never disables the visual", () => {
		// The regression this pins: timer-driven experiences (falling pieces)
		// used to receive `effect` and lock their controls for the whole session.
		expect(visualPendingFromPhase("timer")).toBe("idle");
	});

	it("maps idle and undefined to idle", () => {
		expect(visualPendingFromPhase("idle")).toBe("idle");
		expect(visualPendingFromPhase(undefined)).toBe("idle");
	});
});

describe("visualPendingFromEffects", () => {
	it("is effect only while a model row is pending or running", () => {
		const rows: PendingEffectLike[] = [
			{ kind: "model", status: "pending" },
		];
		expect(visualPendingFromEffects(rows)).toBe("effect");
		expect(visualPendingFromEffects([{ kind: "model", status: "running" }])).toBe("effect");
	});

	it("stays idle for timer rows — pending OR running (the timer-freedom pin)", () => {
		expect(visualPendingFromEffects([{ kind: "timer", status: "pending" }])).toBe("idle");
		expect(visualPendingFromEffects([{ kind: "timer", status: "running" }])).toBe("idle");
	});

	it("model work outranks a live timer (effect wins when both are in flight)", () => {
		const rows: PendingEffectLike[] = [
			{ kind: "timer", status: "running" },
			{ kind: "model", status: "pending" },
		];
		expect(visualPendingFromEffects(rows)).toBe("effect");
	});

	it("terminal rows never gate the visual", () => {
		expect(visualPendingFromEffects([{ kind: "model", status: "succeeded" }])).toBe("idle");
		expect(visualPendingFromEffects([{ kind: "model", status: "failed" }])).toBe("idle");
		expect(visualPendingFromEffects([{ kind: "timer", status: "succeeded" }])).toBe("idle");
		expect(visualPendingFromEffects([])).toBe("idle");
	});
});
