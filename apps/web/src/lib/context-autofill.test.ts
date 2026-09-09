import { describe, it, expect } from "bun:test";
import { DEFAULT_CONTEXT_BUDGET, pickContextSourceModelId, shouldAutoFillContextBudget } from "./context-autofill.js";

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
