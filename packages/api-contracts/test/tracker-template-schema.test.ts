import { describe, expect, it } from "bun:test";
import { trackerTemplateSchema, updateTrackerTemplateSchema } from "../src/schemas/tracker-template-schema.js";

// ---------------------------------------------------------------------------
// CT-9 — objective.state as a discriminated union on `mode`
// ---------------------------------------------------------------------------

/** All issues of a failed parse as `path :: message` strings for readable assertions. */
function issueSummaries(
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map((issue) => `${issue.path.join(".")} :: ${issue.message}`);
}

const routeItem = { id: "task_1", description: "Find water", status: "pending" } as const;
const goalItem = { id: "goal_1", description: "Find the road", status: "pending" } as const;

describe("trackerTemplateSchema objective mode union", () => {
  it("accepts a correct route template and parses ONLY the route branch's slots", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "route", tasks: [routeItem] } },
    });

    expect(result.success).toBe(true);
    const state = result.success ? result.data.objective?.state : undefined;
    expect(state).toEqual({
      mode: "route",
      tasks: [routeItem],
      objectiveDescription: "",
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });
    expect(state).not.toHaveProperty("shortTermGoals");
    expect(state).not.toHaveProperty("longTermGoal");
  });

  it("accepts a correct goals template and parses ONLY the goals branch's slots", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          shortTermGoals: [goalItem],
          longTermGoal: { description: "Defeat the wizard", status: "pending" },
        },
      },
    });

    expect(result.success).toBe(true);
    const state = result.success ? result.data.objective?.state : undefined;
    expect(state).toEqual({
      mode: "goals",
      shortTermGoals: [goalItem],
      longTermGoal: { description: "Defeat the wizard", status: "pending" },
      objectiveDescription: "",
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });
    expect(state).not.toHaveProperty("tasks");
  });

  it("rejects `tasks` under goals mode with an error naming the field", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "goals", tasks: [routeItem] } },
    });

    expect(result.success).toBe(false);
    const summaries = issueSummaries(result);
    expect(summaries.some((summary) => summary.includes("tasks"))).toBe(true);
    expect(summaries).toContain('objective.state :: Unrecognized key: "tasks"');
  });

  it("rejects `shortTermGoals` under route mode with an error naming the field", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "route", shortTermGoals: [goalItem] } },
    });

    expect(result.success).toBe(false);
    const summaries = issueSummaries(result);
    expect(summaries.some((summary) => summary.includes("shortTermGoals"))).toBe(true);
    expect(summaries).toContain('objective.state :: Unrecognized key: "shortTermGoals"');
  });

  it("rejects `longTermGoal` under route mode with an error naming the field", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "route", longTermGoal: { description: "Stray", status: "pending" } } },
    });

    expect(result.success).toBe(false);
    expect(issueSummaries(result)).toContain('objective.state :: Unrecognized key: "longTermGoal"');
  });

  it("defaults a missing `mode` to route (historical behavior pinned)", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { tasks: [routeItem] } },
    });

    expect(result.success).toBe(true);
    const state = result.success ? result.data.objective?.state : undefined;
    expect(state).toEqual({
      mode: "route",
      tasks: [routeItem],
      objectiveDescription: "",
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });
  });

  it("still rejects goals-only fields when `mode` is missing — the default is route, not a guess", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { shortTermGoals: [goalItem] } },
    });

    expect(result.success).toBe(false);
    expect(issueSummaries(result)).toContain('objective.state :: Unrecognized key: "shortTermGoals"');
  });

  it("rejects an unknown discriminator value at the mode path", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "quests" } },
    });

    expect(result.success).toBe(false);
    expect(issueSummaries(result)).toContain("objective.state.mode :: Invalid discriminator value. Expected 'route' | 'goals'");
  });

  it("rejects unknown state keys with a strict unrecognized-key error", () => {
    const result = trackerTemplateSchema.safeParse({
      version: 1,
      objective: { enabled: true, state: { mode: "route", foo: 1 } },
    });

    expect(result.success).toBe(false);
    expect(issueSummaries(result)).toContain('objective.state :: Unrecognized key: "foo"');
  });

  it("keeps scene/objective nullable with root-level strictness", () => {
    const empty = trackerTemplateSchema.safeParse({ version: 1, scene: null, objective: null });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.scene).toBeNull();
      expect(empty.data.objective).toBeNull();
    }

    const defaulted = trackerTemplateSchema.safeParse({ version: 1 });
    expect(defaulted.success).toBe(true);
    if (defaulted.success) {
      expect(defaulted.data.scene).toBeNull();
      expect(defaulted.data.objective).toBeNull();
    }

    const unknownRoot = trackerTemplateSchema.safeParse({ version: 1, extra: true });
    expect(unknownRoot.success).toBe(false);
    expect(issueSummaries(unknownRoot)).toContain(' :: Unrecognized key: "extra"');
  });

  it("round-trips a parsed template through updateTrackerTemplateSchema unchanged", () => {
    const parsed = trackerTemplateSchema.safeParse({
      version: 1,
      scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } },
      objective: {
        enabled: true,
        state: { mode: "goals", shortTermGoals: [goalItem], longTermGoal: null },
      },
    });
    expect(parsed.success).toBe(true);

    const wrapped = updateTrackerTemplateSchema.safeParse(parsed.success ? { template: parsed.data } : {});
    expect(wrapped.success).toBe(true);
    if (wrapped.success && parsed.success) {
      expect(wrapped.data.template).toEqual(parsed.data);
    }
  });
});
