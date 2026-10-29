import { expect, test } from "bun:test";
import { agentReviewEnvelopeSchema, aggregateScriptAgentCodeProposal, buildAgentReviewEnvelope, buildScriptAgentReviewEnvelope, captureScriptAgentReviewProposal, createEmptyAgentReviewRound, finalizeReviewActivities, isFinalizedReviewActivity, type AgentToolActivity } from "../src/index.js";

function activity(id: string, proposed: string): AgentToolActivity {
  return { toolCallId: id, toolName: "write_buffer", status: "done", target: "code", proposed, args: { target: "code", content: proposed }, summary: "Code updated" };
}

test("native code proposal round-trips with the established rules-slot snapshot", () => {
  const activities = [activity("a", "New code")];
  const result = buildScriptAgentReviewEnvelope(null, activities, "Old code")!;
  expect(result).toEqual({ _v: 2, activities, round: { ...createEmptyAgentReviewRound(), snapshots: [{ id: 1, rules: "Old code", visual: "" }], nextSnapshotId: 2, rulesKey: "Old code\0New code" } });
  expect(agentReviewEnvelopeSchema.parse(result)).toEqual(result);
});

test("empty code is an actual deletion proposal, not absence", () => {
  const deletion = activity("delete", "");
  expect(aggregateScriptAgentCodeProposal([deletion])).toBe("");
  const result = buildScriptAgentReviewEnvelope(null, [deletion], "Old code")!;
  expect(result.activities[0]!.proposed).toBe("");
  expect(result.round!.rulesKey).toBe("Old code\0");
  expect(agentReviewEnvelopeSchema.parse(result)).toEqual(result);
});

test("code support does not widen mini-app finalization, aggregation or producer writes", () => {
  const code = activity("code", "New code");
  expect(isFinalizedReviewActivity(code)).toBe(false);
  expect(finalizeReviewActivities([code])).toEqual([]);
  expect(buildAgentReviewEnvelope(null, [code], { rules: "Rules", visual: "Visual" })).toBeNull();
});

test("same-key follow-up retains hunk progress, changed key resets it without mutating the predecessor", () => {
  const previous = buildScriptAgentReviewEnvelope(null, [activity("a", "Proposal")], "Base")!;
  previous.round!.acceptedRules = [0];
  previous.round!.dismissedRules = [1];
  const before = JSON.stringify(previous);
  const same = buildScriptAgentReviewEnvelope(previous, [activity("b", "Proposal")], "Base")!;
  expect(same.round!.acceptedRules).toEqual([0]);
  expect(same.round!.dismissedRules).toEqual([1]);
  const changed = buildScriptAgentReviewEnvelope(previous, [activity("b", "Revised")], "Hybrid")!;
  expect(changed.round!.acceptedRules).toEqual([]);
  expect(changed.round!.dismissedRules).toEqual([]);
  expect(changed.round!.dangling).toEqual({ rules: "Proposal", baseRules: "Base", baseVisual: "" });
  expect(changed.round!.snapshots).toEqual([{ id: 1, rules: "Base", visual: "" }, { id: 2, rules: "Hybrid", visual: "" }]);
  expect(JSON.stringify(previous)).toBe(before);
});

test("dangling-only and empty-code captures preserve the original anchor", () => {
  const round = { ...createEmptyAgentReviewRound(), dangling: { rules: "", baseRules: "Original", baseVisual: "" } };
  expect(captureScriptAgentReviewProposal([], round, "Current")).toEqual(round.dangling);
  expect(captureScriptAgentReviewProposal([], null, "Current")).toBeNull();
});

test("no proposals means no write; successful duplicate ids retain call order with later values", () => {
  const transient = { ...activity("pending", "Partial"), status: "streaming" as const };
  expect(buildScriptAgentReviewEnvelope(null, [transient, { ...activity("bad", "Bad"), status: "error" }], "Old")).toBeNull();
  const last = activity("a", "Last");
  expect(buildScriptAgentReviewEnvelope(null, [activity("a", "First"), activity("b", "Middle"), last, transient], "Old")!.activities).toEqual([last, activity("b", "Middle")]);
});
