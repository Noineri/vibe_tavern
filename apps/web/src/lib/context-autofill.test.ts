import { describe, it, expect } from "bun:test";
import { DEFAULT_CONTEXT_BUDGET, pickContextSourceModelId, resolveModelContextBudget, shouldAutoFillContextBudget } from "./context-autofill.js";

describe("shouldAutoFillContextBudget (LS-7)", () => {
	it("fills while the field still shows the shipped default", () => {
		expect(shouldAutoFillContextBudget({ pinned: false, formValue: DEFAULT_CONTEXT_BUDGET })).toBe(true);
	});

	it("never fills a pinned budget — even at the default", () => {
		expect(shouldAutoFillContextBudget({ pinned: true, formValue: DEFAULT_CONTEXT_BUDGET })).toBe(false);
	});

	it("never fills once the value moved off the default (typed or model-picked)", () => {
		expect(shouldAutoFillContextBudget({ pinned: false, formValue: 8192 })).toBe(false);
		expect(shouldAutoFillContextBudget({ pinned: false, formValue: 131_072 })).toBe(false);
	});
});

describe("resolveModelContextBudget", () => {
	it("uses the model's known context length", () => {
		expect(resolveModelContextBudget({ pinned: false, contextLength: 32_768, unknownContextBudget: 128_000 })).toBe(32_768);
	});

	it("uses the surface fallback only when the model context is unknown", () => {
		expect(resolveModelContextBudget({ pinned: false, contextLength: undefined, unknownContextBudget: 16_000 })).toBe(16_000);
		expect(resolveModelContextBudget({ pinned: false, contextLength: null, unknownContextBudget: 128_000 })).toBe(128_000);
	});

	it("respects a pinned budget", () => {
		expect(resolveModelContextBudget({ pinned: true, contextLength: 32_768, unknownContextBudget: 128_000 })).toBeUndefined();
	});
});

describe("pickContextSourceModelId (LS-7)", () => {
	it("prefers the selected model when present in the list", () => {
		const models = [{ id: "a", contextLength: 4096 }, { id: "b", contextLength: 8192 }];
		expect(pickContextSourceModelId("b", models)).toBe("b");
	});

	it("falls back to the first model (the auto-pick target)", () => {
		const models = [{ id: "a", contextLength: 4096 }];
		expect(pickContextSourceModelId(undefined, models)).toBe("a");
		expect(pickContextSourceModelId("missing", models)).toBe("a");
	});

	it("returns undefined for an empty list", () => {
		expect(pickContextSourceModelId(undefined, [])).toBeUndefined();
	});
});
