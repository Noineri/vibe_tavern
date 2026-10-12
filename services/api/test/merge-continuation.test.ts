import { describe, it, expect } from "bun:test";
import { mergeContinuation } from "../src/infrastructure/ai/merge-continuation.js";

describe("mergeContinuation", () => {
	it("appends with no overlap, preserving the generated leading whitespace as the join", () => {
		const result = mergeContinuation("The dragon woke.", "   It stretched its wings.");
		expect(result.content).toBe("The dragon woke.   It stretched its wings.");
		expect(result.overlapLength).toBe(0);
	});

	it("glues mid-word with no separator when neither side carries whitespace", () => {
		const result = mergeContinuation("she op", "ened the door quietly");
		expect(result.content).toBe("she opened the door quietly");
		expect(result.overlapLength).toBe(0);
	});

	it("trims the generated leading run only when the original already ends on whitespace", () => {
		// The boundary spaces collapse into the overlap (norm length 1);
		// the original keeps its own trailing space, the remainder joins after it.
		const result = mergeContinuation("Half a league, ", "  onward.");
		expect(result.content).toBe("Half a league, onward.");
		expect(result.overlapLength).toBe(1);
	});

	it("drops a partial repeat: generated re-emits the last sentence then continues", () => {
		const original = "The dragon woke. It stretched its wings.";
		const generated = "It stretched its wings. And then it flew away.";
		const result = mergeContinuation(original, generated);
		expect(result.content).toBe("The dragon woke. It stretched its wings. And then it flew away.");
		expect(result.overlapLength).toBe("It stretched its wings.".length);
	});

	it("preserves the model's paragraph break after a repeated tail", () => {
		const original = "The dragon woke. It stretched its wings.";
		const generated = "It stretched its wings.\n\nThen dawn broke.";
		const result = mergeContinuation(original, generated);
		expect(result.content).toBe("The dragon woke. It stretched its wings.\n\nThen dawn broke.");
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
			"The dragon woke. It stretched its wings. And then it flew.",
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
		expect(result.content).toBe(`${original} more text`);
		expect(result.overlapLength).toBe(original.length);
		expect(elapsed).toBeLessThan(1000);
	});
});
