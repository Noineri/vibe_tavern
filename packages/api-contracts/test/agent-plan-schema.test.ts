import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { agentPlanSchema, agentPlanTaskSchema } from "../src/schemas/agent-plan-schema.js";

/**
 * Characterization of the agent-plan wire schemas around the DK-1 `at` stamp.
 *
 * Wire design (pinned here): `at` is optional and STRICT — `day` integer >= 1,
 * `part` one of the four day parts or null, no extra keys. A payload without
 * `at` parses exactly as before DK-1; a malformed `at` rejects the WHOLE
 * payload (never silently stripped — that tolerance lives in the domain
 * normalizer, which drops just the stamp on the read path).
 */

// --- helpers -----------------------------------------------------------------

function expectReject(result: z.ZodSafeParseResult<unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

function expectData(result: z.ZodSafeParseResult<unknown>): unknown {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data;
}

/** A minimal valid plan payload, pre-DK-1 shape. */
function validPlan() {
  return {
    goal: "Ship the script",
    constraints: ["Keep saves compatible"],
    tasks: [
      { id: "task_1", title: "Implement storage", body: "Add the persisted plan table.", status: "active" },
    ],
  };
}

// --- without at (the pre-DK-1 wire shape, unchanged) -------------------------

describe("agentPlanSchema without at", () => {
  it("parses exactly as before (no at key appears in the parsed task)", () => {
    const data = expectData(agentPlanSchema.safeParse(validPlan())) as {
      tasks: Record<string, unknown>[];
    };
    expect(data.tasks[0]).toEqual({
      id: "task_1",
      title: "Implement storage",
      body: "Add the persisted plan table.",
      status: "active",
    });
    expect("at" in (data.tasks[0] ?? {})).toBe(false);
  });

  it("still rejects unknown task keys (strict, unchanged)", () => {
    const bad = validPlan();
    (bad.tasks[0] as Record<string, unknown>).extra = 1;
    expectReject(agentPlanSchema.safeParse(bad));
  });
});

// --- with a valid at ---------------------------------------------------------

describe("agentPlanSchema with a valid at", () => {
  it("round-trips a part stamp through the plan schema", () => {
    const payload = validPlan();
    (payload.tasks[0] as Record<string, unknown>).at = { day: 2, part: "evening" };
    const data = expectData(agentPlanSchema.safeParse(payload)) as {
      tasks: { at: unknown }[];
    };
    expect(data.tasks[0]?.at).toEqual({ day: 2, part: "evening" });
  });

  it("round-trips a null part (the day's start)", () => {
    const payload = validPlan();
    (payload.tasks[0] as Record<string, unknown>).at = { day: 3, part: null };
    const data = expectData(agentPlanSchema.safeParse(payload)) as {
      tasks: { at: unknown }[];
    };
    expect(data.tasks[0]?.at).toEqual({ day: 3, part: null });
  });

  it("accepts a bare task carrying a valid at (task schema alone)", () => {
    expect(
      agentPlanTaskSchema.safeParse({
        id: "task_1",
        title: "T",
        body: "",
        status: "pending",
        at: { day: 1, part: "morning" },
      }).success,
    ).toBe(true);
  });
});

// --- with an invalid at (whole payload rejected, not stripped) ---------------

describe("agentPlanSchema with an invalid at", () => {
  function planWithAt(at: unknown) {
    const payload = validPlan();
    (payload.tasks[0] as Record<string, unknown>).at = at;
    return payload;
  }

  it("rejects day 0", () => {
    expectReject(agentPlanSchema.safeParse(planWithAt({ day: 0, part: "morning" })));
  });

  it("rejects a non-integer day", () => {
    expectReject(agentPlanSchema.safeParse(planWithAt({ day: 1.5, part: "morning" })));
  });

  it("rejects an unknown part word", () => {
    expectReject(agentPlanSchema.safeParse(planWithAt({ day: 2, part: "dusk" })));
  });

  it("rejects a missing part inside at", () => {
    expectReject(agentPlanSchema.safeParse(planWithAt({ day: 2 })));
  });

  it("rejects an at that is not an object", () => {
    expectReject(agentPlanSchema.safeParse(planWithAt("day 2")));
    expectReject(agentPlanSchema.safeParse(planWithAt(7)));
    expectReject(agentPlanSchema.safeParse(planWithAt(null)));
  });

  it("rejects an extra key inside at (strict)", () => {
    expectReject(
      agentPlanSchema.safeParse(planWithAt({ day: 2, part: null, label: "Act II" })),
    );
  });

  it("one bad at rejects the whole plan, not just the field", () => {
    // The divergence from normalizeAgentPlan pinned: the wire never strips a
    // malformed stamp and passes the task through — it fails the payload.
    const payload = validPlan();
    payload.tasks.push({ id: "task_2", title: "Fine", body: "", status: "pending" });
    (payload.tasks[0] as Record<string, unknown>).at = { day: 0, part: null };
    expectReject(agentPlanSchema.safeParse(payload));
  });
});
