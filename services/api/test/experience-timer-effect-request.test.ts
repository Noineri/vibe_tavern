/**
 * parseTimerEffectRequest — strict envelope validation for timer effects
 * (fix step 2a). Table-driven: the valid shape yields the typed payload; every
 * malformed shape (wrong kind, missing/empty fields, out-of-bound delay, unknown
 * keys, bad JSON) yields null, so a bad timer request never reaches the
 * scheduler.
 */
import { describe, expect, test } from "bun:test";

import { parseTimerEffectRequest } from "../src/domain/interactive/experience-service.js";

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { viewer: "model", actionType: "tick", afterMs: 5000, ...overrides };
}

function envelope(request: unknown): string {
	return JSON.stringify({ kind: "timer", request });
}

describe("parseTimerEffectRequest", () => {
	test("accepts a valid payload", () => {
		expect(parseTimerEffectRequest(envelope(valid()))).toEqual({
			viewer: "model",
			actionType: "tick",
			afterMs: 5000,
		});
	});

	test("accepts args when present and passes them through", () => {
		expect(parseTimerEffectRequest(envelope(valid({ args: { x: 1 } })))).toEqual({
			viewer: "model",
			actionType: "tick",
			afterMs: 5000,
			args: { x: 1 },
		});
	});

	test("args absent is fine", () => {
		expect(parseTimerEffectRequest(envelope(valid()))).not.toBeNull();
	});

	test("accepts the maximum allowed delay", () => {
		expect(parseTimerEffectRequest(envelope(valid({ afterMs: 2_147_483_647 })))).not.toBeNull();
	});

	test("rejects a wrong envelope kind", () => {
		expect(parseTimerEffectRequest(JSON.stringify({ kind: "model", request: valid() }))).toBeNull();
	});

	test("rejects a missing viewer or actionType", () => {
		expect(parseTimerEffectRequest(envelope({ actionType: "tick", afterMs: 5000 }))).toBeNull();
		expect(parseTimerEffectRequest(envelope({ viewer: "model", afterMs: 5000 }))).toBeNull();
	});

	test("rejects empty viewer/actionType strings", () => {
		expect(parseTimerEffectRequest(envelope(valid({ viewer: "" })))).toBeNull();
		expect(parseTimerEffectRequest(envelope(valid({ actionType: "" })))).toBeNull();
	});

	test("rejects non-positive, non-integer, or oversized afterMs", () => {
		for (const afterMs of [0, -5, 1.5, 2_147_483_648]) {
			expect(parseTimerEffectRequest(envelope(valid({ afterMs })))).toBeNull();
		}
	});

	test("rejects a string afterMs", () => {
		expect(parseTimerEffectRequest(envelope(valid({ afterMs: "5000" })))).toBeNull();
	});

	test("rejects an unknown extra key", () => {
		expect(parseTimerEffectRequest(envelope(valid({ bogus: true })))).toBeNull();
	});

	test("rejects malformed JSON", () => {
		expect(parseTimerEffectRequest("{not json")).toBeNull();
	});

	test("rejects a non-object request", () => {
		expect(parseTimerEffectRequest(envelope("tick"))).toBeNull();
		expect(parseTimerEffectRequest(envelope(null))).toBeNull();
	});

	test("rejects a non-object envelope", () => {
		expect(parseTimerEffectRequest(JSON.stringify("just a string"))).toBeNull();
		expect(parseTimerEffectRequest(JSON.stringify(null))).toBeNull();
	});
});
