import { expect, test } from "bun:test";
import { agentReviewEnvelopeSchema, appendAgentReviewSnapshot, buildAgentReviewEnvelope, captureAgentReviewProposal, createEmptyAgentReviewRound, ensureAgentReviewKey, type AgentToolActivity } from "../src/index.js";

function activity(id: string, target: "rules" | "visual", proposed: string): AgentToolActivity {
  return { toolCallId: id, toolName: "edit_buffer", status: "done", target, proposed, summary: `Updated ${target}`, args: { target, edits: [] } };
}
const buffers = { rules: "Old rules", visual: "Old visual" };

test("first turn builds a full V2 round with the request's starting buffers", () => {
  const activities = [activity("rules", "rules", "New rules"), activity("visual", "visual", "New visual")];
  const result = buildAgentReviewEnvelope(null, activities, buffers);
  expect(result).toEqual({ _v: 2, activities, round: {
    ...createEmptyAgentReviewRound(), snapshots: [{ ...buffers, id: 1 }], nextSnapshotId: 2,
    rulesKey: "Old rules\0New rules", visualKey: "Old visual\0New visual",
  } });
  expect(agentReviewEnvelopeSchema.parse(result)).toEqual(result!);
});

test("a visual-only follow-up preserves rules progress and the original dangling base", () => {
  const previous = buildAgentReviewEnvelope(null, [activity("r", "rules", "New rules"), activity("v", "visual", "New visual")], buffers)!;
  previous.round!.acceptedRules = [0];
  previous.round!.dismissedRules = [1];
  previous.round!.acceptedVisual = [2];
  const before = JSON.stringify(previous);
  const next = buildAgentReviewEnvelope(previous, [activity("next", "visual", "Revised visual")], { rules: "Partly accepted rules", visual: "Current visual" })!;
  expect(next.round!.dangling).toEqual({ rules: "New rules", visual: "New visual", baseRules: "Old rules", baseVisual: "Old visual" });
  expect(next.round!.acceptedRules).toEqual([0]);
  expect(next.round!.dismissedRules).toEqual([1]);
  expect(next.round!.acceptedVisual).toEqual([]);
  expect(next.round!.rulesKey).toBe("Old rules\0New rules");
  expect(next.round!.visualKey).toBe("Current visual\0Revised visual");
  expect(next.round!.snapshots).toHaveLength(2);
  expect(JSON.stringify(previous)).toBe(before);
});

test("existing dangling survives when there was no prior live proposal", () => {
  const previous = { _v: 2 as const, activities: [], round: { ...createEmptyAgentReviewRound(), dangling: { rules: "Pending", baseRules: "Original", baseVisual: "Visual" } } };
  const next = buildAgentReviewEnvelope(previous, [activity("v", "visual", "New visual")], buffers)!;
  expect(next.round!.dangling).toEqual(previous.round.dangling);
  expect(next.round!.rulesKey).toBe("Original\0Pending");
});

test("no finalized proposals means no write, while duplicates preserve call order and later values", () => {
  const transient: AgentToolActivity = { ...activity("stream", "rules", "Partial"), status: "streaming" };
  expect(buildAgentReviewEnvelope(null, [transient], buffers)).toBeNull();
  const a = activity("a", "rules", "A");
  const b = activity("b", "visual", "B");
  const revised = activity("a", "rules", "Revised A");
  expect(buildAgentReviewEnvelope(null, [a, b, revised, transient], buffers)!.activities).toEqual([revised, b]);
});

test("the extracted store operations preserve identity on a matching key and reset only that buffer", () => {
  const round = { ...createEmptyAgentReviewRound(), rulesKey: "same", acceptedRules: [0], dismissedRules: [1], acceptedVisual: [2] };
  expect(ensureAgentReviewKey(round, "rules", "same")).toBe(round);
  expect(ensureAgentReviewKey(round, "rules", "changed")).toEqual({ ...round, rulesKey: "changed", acceptedRules: [], dismissedRules: [] });
  expect(appendAgentReviewSnapshot(round, buffers).snapshots).toEqual([{ ...buffers, id: 1 }]);
  expect(captureAgentReviewProposal({ hasProposal: false, summaries: [] }, null, buffers)).toBeNull();
  expect(captureAgentReviewProposal({ hasProposal: true, proposedRules: "New", summaries: [] }, null, buffers)).toEqual({ rules: "New", visual: undefined, baseRules: "Old rules", baseVisual: "Old visual" });
});
