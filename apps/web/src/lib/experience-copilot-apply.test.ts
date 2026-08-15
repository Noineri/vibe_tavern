/**
 * ER-9.1 — experience-copilot-apply (pure).
 *
 * Pins the aggregation that turns an experience-copilot turn's tool activities
 * into a two-buffer proposal (`rules`/`visual`, last-wins per buffer) — the
 * contract the editor review flow (CD-2/CD-6) consumes. The two-buffer
 * last-wins semantics are load-bearing: a wrong aggregation means a wrong
 * buffer gets committed, or a buffer the model never touched gets overwritten.
 *
 * Covers: empty/streaming/error exclusion, rules-only and visual-only
 * proposals, both-buffer turns, last-wins per buffer (cumulative checkpoints),
 * and read-only tool isolation (read_skill_file / run_test never count as a
 * proposal).
 */
import { describe, it, expect } from "bun:test";
import {
	aggregateExperienceCopilotProposal,
} from "./experience-copilot-apply.js";
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";

/** A write_buffer/edit_buffer activity whose tool-result finalized with the
 *  proposal triple (`target`/`proposed`/`summary`). */
function bufferActivity(
	toolCallId: string,
	target: "rules" | "visual",
	proposed: string,
	summary = "Edited buffer.",
): ExperienceCopilotToolActivity {
	return { toolCallId, toolName: "write_buffer", status: "done", target, proposed, summary };
}

/** A read_skill_file activity — `done` with a `readPath`, but NO
 *  target/proposed, so it must never enter proposal aggregation. */
function readActivity(toolCallId: string, path: string): ExperienceCopilotToolActivity {
	return { toolCallId, toolName: "read_skill_file", status: "done", readPath: path };
}

/** A run_test activity — `done` with a `summary` only (an informational digest),
 *  so it must never enter proposal aggregation. */
function runTestActivity(toolCallId: string, summary: string): ExperienceCopilotToolActivity {
	return { toolCallId, toolName: "run_test", status: "done", summary };
}

describe("aggregateExperienceCopilotProposal — no proposal", () => {
	it("returns hasProposal=false for empty activities", () => {
		const result = aggregateExperienceCopilotProposal([]);
		expect(result.hasProposal).toBe(false);
		expect(result.proposedRules).toBeUndefined();
		expect(result.proposedVisual).toBeUndefined();
		expect(result.summaries).toEqual([]);
	});

	it("excludes streaming and error activities (only done+proposed count)", () => {
		const streaming: ExperienceCopilotToolActivity = { toolCallId: "t1", toolName: "write_buffer", status: "streaming" };
		const errored: ExperienceCopilotToolActivity = { toolCallId: "t2", toolName: "write_buffer", status: "error", target: "rules", proposed: "x" };
		const result = aggregateExperienceCopilotProposal([streaming, errored]);
		expect(result.hasProposal).toBe(false);
		expect(result.summaries).toEqual([]);
	});
});

describe("aggregateExperienceCopilotProposal — single buffer", () => {
	it("rules-only proposal → proposedRules set, proposedVisual undefined", () => {
		const result = aggregateExperienceCopilotProposal([
			bufferActivity("t1", "rules", "new rules", "Rewrote the rules."),
		]);
		expect(result.hasProposal).toBe(true);
		expect(result.proposedRules).toBe("new rules");
		expect(result.proposedVisual).toBeUndefined();
		expect(result.summaries).toEqual(["Rewrote the rules."]);
	});

	it("visual-only proposal → proposedVisual set, proposedRules undefined", () => {
		const result = aggregateExperienceCopilotProposal([
			bufferActivity("t1", "visual", "new visual", "Rewrote the visual."),
		]);
		expect(result.hasProposal).toBe(true);
		expect(result.proposedVisual).toBe("new visual");
		expect(result.proposedRules).toBeUndefined();
		expect(result.summaries).toEqual(["Rewrote the visual."]);
	});
});

describe("aggregateExperienceCopilotProposal — both buffers", () => {
	it("rules + visual in one turn → both buffers proposed", () => {
		const result = aggregateExperienceCopilotProposal([
			bufferActivity("t1", "rules", "new rules", "Rules."),
			bufferActivity("t2", "visual", "new visual", "Visual."),
		]);
		expect(result.hasProposal).toBe(true);
		expect(result.proposedRules).toBe("new rules");
		expect(result.proposedVisual).toBe("new visual");
		expect(result.summaries).toEqual(["Rules.", "Visual."]);
	});
});

describe("aggregateExperienceCopilotProposal — last-wins per buffer", () => {
	it("two rules proposals → the second one's text wins (cumulative checkpoint)", () => {
		// write_buffer / edit_buffer results are complete cumulative buffers, so
		// the later `proposed` already carries the earlier op.
		const result = aggregateExperienceCopilotProposal([
			bufferActivity("t1", "rules", "first rules", "first"),
			bufferActivity("t2", "rules", "second rules", "second"),
		]);
		expect(result.proposedRules).toBe("second rules");
		expect(result.summaries).toEqual(["first", "second"]);
	});

	it("last-wins is per buffer — two visual proposals do not disturb rules", () => {
		const result = aggregateExperienceCopilotProposal([
			bufferActivity("t1", "rules", "rules text", "rules"),
			bufferActivity("t2", "visual", "first visual", "first visual"),
			bufferActivity("t3", "visual", "second visual", "second visual"),
		]);
		expect(result.proposedRules).toBe("rules text");
		expect(result.proposedVisual).toBe("second visual");
	});
});

describe("aggregateExperienceCopilotProposal — read-only tool isolation", () => {
	it("read_skill_file and run_test never count as proposals", () => {
		const result = aggregateExperienceCopilotProposal([
			readActivity("r1", "experience-authoring/SKILL.md"),
			runTestActivity("r2", "test passed"),
		]);
		expect(result.hasProposal).toBe(false);
		expect(result.proposedRules).toBeUndefined();
		expect(result.proposedVisual).toBeUndefined();
		expect(result.summaries).toEqual([]);
	});

	it("reads/tests do not displace a real proposal, and contribute no summary", () => {
		const result = aggregateExperienceCopilotProposal([
			readActivity("r1", "experience-authoring/SKILL.md"),
			runTestActivity("r2", "test passed"),
			bufferActivity("t1", "rules", "new rules", "Rewrote rules."),
		]);
		expect(result.hasProposal).toBe(true);
		expect(result.proposedRules).toBe("new rules");
		expect(result.summaries).toEqual(["Rewrote rules."]);
	});
});
