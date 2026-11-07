import { describe, expect, test } from "bun:test";
import {
  AGENT_PLAN_TASK_STATUS,
  STORY_DAY_PART,
  addStoryDay,
  compareStoryTime,
  isStoryEventDue,
  isStoryEventTime,
  nextStoryDayPart,
  normalizeAgentPlan,
  pickCurrentPlanTask,
  promoteStoryEvent,
} from "../src/index.js";
import type {
  AgentPlan,
  AgentPlanTask,
  StoryClock,
  StoryDayPart,
  StoryEventTime,
} from "../src/index.js";

/**
 * Characterization of the story clock and the ONE current-event rule
 * (DIRECTOR_DECK_CALENDAR_PLAN DK-1). Two invariants are pinned hardest:
 * the day-part order (morning -> day -> evening -> night, `null` ranking
 * exactly as `morning`) and the clock-null equality — with no clock,
 * `pickCurrentPlanTask` must equal the pre-clock rule (first active, else
 * first pending) for dated and undated tasks alike.
 */

// --- factories ---------------------------------------------------------------

function task(id: string, overrides: Partial<AgentPlanTask> = {}): AgentPlanTask {
  return {
    id,
    title: `Task ${id}`,
    body: "",
    status: AGENT_PLAN_TASK_STATUS.pending,
    ...overrides,
  };
}

function clock(day: number, part: StoryDayPart | null, label: string | null = null): StoryClock {
  return { day, part, label };
}

function at(day: number, part: StoryDayPart | null): StoryEventTime {
  return { day, part };
}

function plan(tasks: AgentPlanTask[]): AgentPlan {
  return { goal: "G", constraints: [], tasks };
}

// --- STORY_DAY_PART ----------------------------------------------------------

describe("STORY_DAY_PART", () => {
  test("carries exactly the four day parts in story order", () => {
    expect(Object.keys(STORY_DAY_PART)).toEqual(["morning", "day", "evening", "night"]);
    expect(Object.values(STORY_DAY_PART)).toEqual(["morning", "day", "evening", "night"]);
  });
});

// --- isStoryEventTime (the one validity rule) --------------------------------

describe("isStoryEventTime", () => {
  test("accepts a valid time with a part and with a null part", () => {
    expect(isStoryEventTime({ day: 1, part: STORY_DAY_PART.morning })).toBe(true);
    expect(isStoryEventTime({ day: 12, part: null })).toBe(true);
  });

  test("rejects day 0, negative and non-integer days", () => {
    expect(isStoryEventTime({ day: 0, part: null })).toBe(false);
    expect(isStoryEventTime({ day: -2, part: null })).toBe(false);
    expect(isStoryEventTime({ day: 1.5, part: null })).toBe(false);
    expect(isStoryEventTime({ part: null })).toBe(false);
  });

  test("rejects an unknown part word and a missing part", () => {
    expect(isStoryEventTime({ day: 1, part: "dusk" })).toBe(false);
    expect(isStoryEventTime({ day: 1 })).toBe(false);
  });

  test("rejects a time that is not an object", () => {
    expect(isStoryEventTime("day 2")).toBe(false);
    expect(isStoryEventTime(7)).toBe(false);
    expect(isStoryEventTime(null)).toBe(false);
    expect(isStoryEventTime(undefined)).toBe(false);
    expect(isStoryEventTime([1, "morning"])).toBe(false);
  });
});

// --- compareStoryTime --------------------------------------------------------

describe("compareStoryTime", () => {
  test("orders the day parts within one day", () => {
    const day = 2;
    expect(compareStoryTime(at(day, STORY_DAY_PART.morning), at(day, STORY_DAY_PART.day))).toBeLessThan(0);
    expect(compareStoryTime(at(day, STORY_DAY_PART.day), at(day, STORY_DAY_PART.evening))).toBeLessThan(0);
    expect(compareStoryTime(at(day, STORY_DAY_PART.evening), at(day, STORY_DAY_PART.night))).toBeLessThan(0);
    expect(compareStoryTime(at(day, STORY_DAY_PART.night), at(day, STORY_DAY_PART.morning))).toBeGreaterThan(0);
  });

  test("is antisymmetric and reflexive", () => {
    expect(compareStoryTime(at(2, STORY_DAY_PART.evening), at(2, STORY_DAY_PART.day))).toBeGreaterThan(0);
    expect(compareStoryTime(at(2, STORY_DAY_PART.evening), at(2, STORY_DAY_PART.evening))).toBe(0);
  });

  test("orders days before parts (night of day 1 < morning of day 2)", () => {
    expect(compareStoryTime(at(1, STORY_DAY_PART.night), at(2, STORY_DAY_PART.morning))).toBeLessThan(0);
    expect(compareStoryTime(at(2, STORY_DAY_PART.morning), at(1, STORY_DAY_PART.night))).toBeGreaterThan(0);
  });

  test("ranks a null part exactly as morning", () => {
    expect(compareStoryTime(at(2, null), at(2, STORY_DAY_PART.morning))).toBe(0);
    expect(compareStoryTime(at(2, null), at(2, STORY_DAY_PART.day))).toBeLessThan(0);
    expect(compareStoryTime(at(2, STORY_DAY_PART.night), at(2, null))).toBeGreaterThan(0);
  });

  test("accepts a StoryClock on either side (structural superset)", () => {
    expect(compareStoryTime(at(2, STORY_DAY_PART.evening), clock(2, STORY_DAY_PART.night))).toBeLessThan(0);
    expect(compareStoryTime(clock(3, null), at(3, STORY_DAY_PART.day))).toBeLessThan(0);
    expect(compareStoryTime(clock(3, null, "Act II"), at(3, STORY_DAY_PART.morning))).toBe(0);
  });
});

// --- nextStoryDayPart --------------------------------------------------------

describe("nextStoryDayPart", () => {
  test("walks morning -> day -> evening -> night within one day", () => {
    expect(nextStoryDayPart(clock(2, STORY_DAY_PART.morning))).toEqual(clock(2, STORY_DAY_PART.day));
    expect(nextStoryDayPart(clock(2, STORY_DAY_PART.day))).toEqual(clock(2, STORY_DAY_PART.evening));
    expect(nextStoryDayPart(clock(2, STORY_DAY_PART.evening))).toEqual(clock(2, STORY_DAY_PART.night));
  });

  test("rolls night over to the NEXT day's morning", () => {
    expect(nextStoryDayPart(clock(2, STORY_DAY_PART.night))).toEqual(clock(3, STORY_DAY_PART.morning));
    expect(nextStoryDayPart(clock(9, STORY_DAY_PART.night)).day).toBe(10);
  });

  test("advances a null part exactly like morning (lands on day of the same day)", () => {
    expect(nextStoryDayPart(clock(2, null))).toEqual(clock(2, STORY_DAY_PART.day));
  });

  test("carries the display label through unchanged", () => {
    expect(nextStoryDayPart(clock(2, STORY_DAY_PART.night, "Act I")).label).toBe("Act I");
  });
});

// --- addStoryDay -------------------------------------------------------------

describe("addStoryDay", () => {
  test("moves one day forward keeping the same part", () => {
    expect(addStoryDay(clock(3, STORY_DAY_PART.evening))).toEqual(clock(4, STORY_DAY_PART.evening));
  });

  test("keeps a null part null (same time next day)", () => {
    expect(addStoryDay(clock(3, null))).toEqual(clock(4, null));
  });

  test("carries the display label through unchanged", () => {
    expect(addStoryDay(clock(3, STORY_DAY_PART.night, "Chapter 2"))).toEqual(
      clock(4, STORY_DAY_PART.night, "Chapter 2"),
    );
  });
});

// --- isStoryEventDue ---------------------------------------------------------

describe("isStoryEventDue", () => {
  test("an undated task is due with and without a clock", () => {
    expect(isStoryEventDue(task("t1"), clock(2, STORY_DAY_PART.evening))).toBe(true);
    expect(isStoryEventDue(task("t1"), null)).toBe(true);
  });

  test("a dated task with no clock is due (treated as undated)", () => {
    expect(isStoryEventDue({ ...task("t1"), at: at(5, STORY_DAY_PART.night) }, null)).toBe(true);
  });

  test("a dated task at or before the clock is due", () => {
    const now = clock(2, STORY_DAY_PART.night);
    expect(isStoryEventDue({ ...task("t1"), at: at(1, STORY_DAY_PART.morning) }, now)).toBe(true);
    expect(isStoryEventDue({ ...task("t1"), at: at(2, STORY_DAY_PART.evening) }, now)).toBe(true);
    expect(isStoryEventDue({ ...task("t1"), at: at(2, STORY_DAY_PART.night) }, now)).toBe(true);
  });

  test("a dated task after the clock is not due", () => {
    const now = clock(2, STORY_DAY_PART.night);
    expect(isStoryEventDue({ ...task("t1"), at: at(3, STORY_DAY_PART.morning) }, now)).toBe(false);
    expect(isStoryEventDue({ ...task("t1"), at: at(3, null) }, now)).toBe(false);
  });

  test("equality on the (day, part) pair is due (null ranks as morning)", () => {
    expect(isStoryEventDue({ ...task("t1"), at: at(2, null) }, clock(2, STORY_DAY_PART.morning))).toBe(true);
  });
});

// --- pickCurrentPlanTask -----------------------------------------------------

describe("pickCurrentPlanTask (clock null equals the old rule)", () => {
  test("the first active task wins wherever it sits", () => {
    const tasks = [task("a"), task("b", { status: AGENT_PLAN_TASK_STATUS.active }), task("c")];
    expect(pickCurrentPlanTask(tasks, null)?.id).toBe("b");
    expect(pickCurrentPlanTask(tasks, clock(5, STORY_DAY_PART.night))?.id).toBe("b");
  });

  test("no active -> the first pending, undated or dated alike (clock null)", () => {
    const undatedFirst = [task("a"), task("b")];
    expect(pickCurrentPlanTask(undatedFirst, null)?.id).toBe("a");

    const datedFirst = [{ ...task("a"), at: at(9, STORY_DAY_PART.night) }, task("b")];
    expect(pickCurrentPlanTask(datedFirst, null)?.id).toBe("a");

    const datedSecond = [task("a"), { ...task("b"), at: at(9, STORY_DAY_PART.night) }];
    expect(pickCurrentPlanTask(datedSecond, null)?.id).toBe("a");
  });

  test("an old dated pending is still picked first with no clock (order, not datedness)", () => {
    const tasks = [{ ...task("a"), at: at(1, STORY_DAY_PART.morning) }, task("b")];
    expect(pickCurrentPlanTask(tasks, null)?.id).toBe("a");
  });

  test("completed/abandoned tasks are never picked; empty list -> null", () => {
    expect(pickCurrentPlanTask([task("a", { status: AGENT_PLAN_TASK_STATUS.completed })], null)).toBeNull();
    expect(pickCurrentPlanTask([task("a", { status: AGENT_PLAN_TASK_STATUS.abandoned })], null)).toBeNull();
    expect(pickCurrentPlanTask([], null)).toBeNull();
    expect(pickCurrentPlanTask([], clock(1, STORY_DAY_PART.morning))).toBeNull();
  });
});

describe("pickCurrentPlanTask (time-aware)", () => {
  test("an active task wins even when its date has not arrived", () => {
    const tasks = [task("a", { status: AGENT_PLAN_TASK_STATUS.active, at: at(9, null) })];
    expect(pickCurrentPlanTask(tasks, clock(1, STORY_DAY_PART.morning))?.id).toBe("a");
  });

  test("skips a pending that is not yet due and picks the first pending that IS due", () => {
    const tasks = [
      { ...task("future"), at: at(5, STORY_DAY_PART.evening) },
      { ...task("past"), at: at(2, STORY_DAY_PART.morning) },
      { ...task("later-past"), at: at(2, STORY_DAY_PART.evening) },
    ];
    expect(pickCurrentPlanTask(tasks, clock(3, STORY_DAY_PART.morning))?.id).toBe("past");
  });

  test("returns null when no pending task is due", () => {
    const tasks = [
      { ...task("a"), at: at(5, STORY_DAY_PART.evening) },
      { ...task("b"), at: at(6, null) },
    ];
    expect(pickCurrentPlanTask(tasks, clock(4, STORY_DAY_PART.night))).toBeNull();
    expect(pickCurrentPlanTask(tasks, clock(5, STORY_DAY_PART.day))).toBeNull();
    expect(pickCurrentPlanTask(tasks, clock(5, STORY_DAY_PART.evening))?.id).toBe("a");
  });
});

// --- promoteStoryEvent -------------------------------------------------------

describe("promoteStoryEvent", () => {
  test("target after the current: target takes the current's position, current goes pending directly after", () => {
    const result = promoteStoryEvent(
      plan([
        task("a", { status: AGENT_PLAN_TASK_STATUS.active }),
        task("b"),
        task("c"),
      ]),
      "c",
    );
    expect(result.tasks.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(result.tasks[0]?.status).toBe(AGENT_PLAN_TASK_STATUS.active);
    expect(result.tasks[1]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
    expect(result.tasks[2]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
  });

  test("target before the current: same rule, position arithmetic holds", () => {
    const result = promoteStoryEvent(plan([task("a"), task("b", { status: AGENT_PLAN_TASK_STATUS.active })]), "a");
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.tasks[0]?.status).toBe(AGENT_PLAN_TASK_STATUS.active);
    expect(result.tasks[1]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
  });

  test("target in the middle: only the two involved events change", () => {
    const result = promoteStoryEvent(
      plan([task("a"), task("b"), task("c", { status: AGENT_PLAN_TASK_STATUS.active }), task("d")]),
      "b",
    );
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.tasks[1]?.status).toBe(AGENT_PLAN_TASK_STATUS.active);
    expect(result.tasks[2]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
    expect(result.tasks[0]).toEqual(task("a"));
    expect(result.tasks[3]).toEqual(task("d"));
  });

  test("promoting the already-current target returns the plan unchanged", () => {
    const p = plan([task("a"), task("b", { status: AGENT_PLAN_TASK_STATUS.active })]);
    expect(promoteStoryEvent(p, "b")).toEqual(p);
  });

  test("an unknown task id returns the plan unchanged", () => {
    const p = plan([task("a", { status: AGENT_PLAN_TASK_STATUS.active })]);
    expect(promoteStoryEvent(p, "ghost")).toEqual(p);
  });

  test("no current event: the target activates in place and nothing moves", () => {
    const result = promoteStoryEvent(plan([task("a"), task("b")]), "b");
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.tasks[0]?.status).toBe(AGENT_PLAN_TASK_STATUS.pending);
    expect(result.tasks[1]?.status).toBe(AGENT_PLAN_TASK_STATUS.active);
  });

  test("the result passes normalizeAgentPlan and keeps fields (at included)", () => {
    const p = plan([
      { ...task("a", { title: "Current", body: "direction", at: at(2, STORY_DAY_PART.evening) }), status: AGENT_PLAN_TASK_STATUS.active },
      { ...task("b", { title: "Later", body: "", at: at(5, null) }), status: AGENT_PLAN_TASK_STATUS.pending },
    ]);
    const promoted = promoteStoryEvent(p, "b");
    expect(normalizeAgentPlan(promoted)).toEqual(promoted);
    expect(promoted.tasks[0]?.at).toEqual(at(5, null));
    expect(promoted.tasks[1]?.at).toEqual(at(2, STORY_DAY_PART.evening));
  });

  test("no-current promotion also passes normalizeAgentPlan", () => {
    const promoted = promoteStoryEvent(plan([task("a")]), "a");
    expect(normalizeAgentPlan(promoted)).toEqual(promoted);
  });
});
