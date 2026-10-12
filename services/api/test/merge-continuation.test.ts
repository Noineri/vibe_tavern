import { describe, it, expect } from "bun:test";
import { mergeContinuation } from "../src/infrastructure/ai/merge-continuation.js";

describe("mergeContinuation", () => {
	it("appends with no overlap, trimming leading whitespace of generated", () => {
		const result = mergeContinuation("The dragon woke.", "   It stretched its wings.");
		expect(result.content).toBe("The dragon woke.It stretched its wings.");
		expect(result.overlapLength).toBe(0);
	});

	it("drops a partial repeat: generated re-emits the last sentence then continues", () => {
		const original = "The dragon woke. It stretched its wings.";
		const generated = "It stretched its wings. And then it flew away.";
		const result = mergeContinuation(original, generated);
		expect(result.content).toBe("The dragon woke. It stretched its wings.And then it flew away.");
		expect(result.overlapLength).toBe("It stretched its wings.".length);
	});

	it("returns the original exactly when generated is entirely a suffix of it", () => {
		const original = "The dragon woke. It stretched its wings.";
		const result = mergeContinuation(original, "It stretched its wings.");
		expect(result.content).toBe(original);
		expect(result.overlapLength).toBe("It stretched its wings.".length);
	});

	it("matches across whitespace variance but preserves the original whitespace", () => {
		const original = "The dragon woke. It stretched its wings.";
		const generated = "It  stretched\n  its wings. And then it flew.";
		const result = mergeContinuation(original, generated);
		expect(result.content).toBe(
			"The dragon woke. It stretched its wings.And then it flew.",
		);
		expect(result.overlapLength).toBe("It stretched its wings.".length);
	});

	it("returns the original untouched for empty generated", () => {
		const original = "The dragon woke.";
		const result = mergeContinuation(original, "");
		expect(result.content).toBe(original);
		expect(result.overlapLength).toBe(0);
	});

	it("returns generated as-is (no trim) for empty original", () => {
		const result = mergeContinuation("", "   Fresh start.");
		expect(result.content).toBe("   Fresh start.");
		expect(result.overlapLength).toBe(0);
	});

	it("returns empty content when both are empty", () => {
		const result = mergeContinuation("", "");
		expect(result.content).toBe("");
		expect(result.overlapLength).toBe(0);
	});

	it("handles a large original without pathological rescanning", () => {
		const original = `segment ${"lorem ipsum dolor sit amet ".repeat(800)}end of tale.`;
		expect(original.length).toBeGreaterThan(20_000);
		const generated = `${original} more text`;
		const start = performance.now();
		const result = mergeContinuation(original, generated);
		const elapsed = performance.now() - start;
		expect(result.content).toBe(`${original}more text`);
		expect(result.overlapLength).toBe(original.length);
		expect(elapsed).toBeLessThan(1000);
	});
});
