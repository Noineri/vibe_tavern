import { describe, expect, test } from "bun:test";
import { agentReviewEnvelopeSchema, agentReviewRoundSchema, agentToolActivitySchema, type AgentReviewEnvelope, type AgentToolActivity } from "../src/index.js";

function envelope(): AgentReviewEnvelope {
  return {
    _v: 2,
    activities: [
      { toolCallId: "write", toolName: "write_buffer", status: "done", target: "rules", proposed: "Revised rules", summary: "Rules changed", args: { target: "rules", content: "Revised rules" } },
      { toolCallId: "edit", toolName: "edit_buffer", status: "done", target: "visual", proposed: "<main>Revised</main>", args: { edits: [{ search: "Old", replace: "Revised" }] } },
    ],
    round: {
      snapshots: [{ id: 1, rules: "Original rules", visual: "<main>Old</main>" }],
      nextSnapshotId: 2,
      acceptedRules: [0, -1], acceptedVisual: [2], dismissedRules: [1], dismissedVisual: [3],
      rulesKey: "Original rules\0Revised rules", visualKey: "<main>Old</main>\0<main>Revised</main>",
      dangling: { rules: "Pending rules", visual: "Pending visual", baseRules: "Original rules", baseVisual: "<main>Old</main>" },
    },
  };
}

describe("agent review v2 envelope", () => {
  test("round-trips the complete two-buffer review without dropping progress or operation inputs", () => {
    const original = envelope();
    expect(agentReviewEnvelopeSchema.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
    expect(agentReviewRoundSchema.parse(original.round)).toEqual(original.round!);
  });

  test("accepts a null round, empty resolved state, and dangling-only state", () => {
    expect(agentReviewEnvelopeSchema.parse({ _v: 2, activities: [], round: null })).toEqual({ _v: 2, activities: [], round: null });
    const danglingOnly = { ...envelope(), activities: [] };
    expect(agentReviewEnvelopeSchema.parse(danglingOnly)).toEqual(danglingOnly);
  });

  test("rejects legacy versions, absent envelope fields and malformed rounds", () => {
    for (const invalid of [
      null, {}, { ...envelope(), _v: 1 }, { ...envelope(), _v: 3 },
      { activities: [], round: null }, { _v: 2, round: null }, { _v: 2, activities: [] },
      { ...envelope(), round: { ...envelope().round, snapshots: "bad" } },
      { ...envelope(), round: { ...envelope().round, acceptedRules: [0.5] } },
      { ...envelope(), round: { ...envelope().round, dangling: { rules: "No bases" } } },
    ]) expect(agentReviewEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  test("never admits streaming/errors/read-only activities or a script code proposal", () => {
    const valid = envelope().activities[0]!;
    for (const activity of [
      { ...valid, status: "streaming" }, { ...valid, status: "error" },
      { toolCallId: "read", toolName: "read_skill_file", status: "done", readPath: "skills/example.md" },
      { ...valid, target: "code" }, { ...valid, proposed: "" }, { ...valid, proposed: 12 },
      { ...valid, toolCallId: null }, { ...valid, toolName: null },
    ]) expect(agentReviewEnvelopeSchema.safeParse({ ...envelope(), activities: [activity] }).success).toBe(false);
  });

  test("generic live activity types still include code proposals and non-proposal card metadata", () => {
    const activity: AgentToolActivity = {
      toolCallId: "code", toolName: "write_buffer", status: "done", target: "code", proposed: "return 1;",
      todo: { items: [{ title: "Review", status: "active" }], remaining: 1, activeTitle: "Review" },
      ask: { question: "Proceed?", options: ["Yes", "No"], recommended: "Yes", status: "answered", answer: "Yes" },
      permission: { status: "granted", position: 1, variantNumber: 2, replyFirstLine: "Hello", promptTokens: 300, presetName: "Preset" },
    };
    expect(agentToolActivitySchema.parse(activity)).toEqual(activity);
  });
});
