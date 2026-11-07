import type { AgentPlan, AgentPlanTask } from "./agent-plan.js";
import { isRecord } from "./is-record.js";

/**
 * The story clock (DIRECTOR_DECK_CALENDAR_PLAN DK-1): a coarse in-story
 * calendar — a day number plus a named part of the day — and the ONE pure
 * current-event rule that reads it. The server (`pickCurrentStoryEvent`,
 * DK-4) and the web (`AgentPlanPanel.pickCurrent`, DK-10) migrate to these
 * functions; until they do, their local rules stay the live copies.
 *
 * Runtime dependency direction: `agent-plan.ts` imports THIS module (the day
 * parts, the `at` validator); the `AgentPlanTask` reference here is type-only
 * (erased at compile), so there is no runtime cycle.
 */

/** The four named parts of a story day, in story order. */
export const STORY_DAY_PART = {
  morning: "morning",
  day: "day",
  evening: "evening",
  night: "night",
} as const;

export type StoryDayPart = typeof STORY_DAY_PART[keyof typeof STORY_DAY_PART];

/** Day parts in story order — the single ordering source, derived from the const. */
const STORY_DAY_PART_ORDER: readonly StoryDayPart[] = Object.values(STORY_DAY_PART);

/** A dated story event: the story day it happens on and (optionally) the part. */
export interface StoryEventTime {
  /** 1-based story day. */
  day: number;
  /** Part of the day; `null` = the day's start, ranking exactly with `morning`. */
  part: StoryDayPart | null;
}

/**
 * The story clock: where "now" sits on the story calendar. `label` is
 * display-only metadata (whatever the caller renders for the clock); it is
 * never part of any ordering and every clock arithmetic below carries it
 * through unchanged.
 */
export interface StoryClock {
  /** 1-based story day. */
  day: number;
  /** Current part of the day; `null` = the day's start, ranking with `morning`. */
  part: StoryDayPart | null;
  /** Display-only label; never read by any ordering or arithmetic. */
  label: string | null;
}

function storyDayPartRank(part: StoryDayPart): number {
  return STORY_DAY_PART_ORDER.indexOf(part);
}

/** Rank of a clock/event part: `null` (the day's start) ranks exactly as `morning`. */
function storyTimeRank(part: StoryDayPart | null): number {
  return part === null ? 0 : storyDayPartRank(part);
}

/** Whether `value` is one of the four story day parts (mirrors the status guard in agent-plan.ts). */
export function isStoryDayPart(value: unknown): value is StoryDayPart {
  return Object.values(STORY_DAY_PART).some((part) => part === value);
}

/**
 * The ONE validity rule for a persisted event time (DK-1): an object whose
 * `day` is an integer >= 1 and whose `part` is one of the four day parts or
 * null. `normalizeAgentPlan` drops a task's invalid `at` through this
 * predicate (the task survives); the wire schema mirrors the same rule
 * strictly and rejects the payload instead.
 */
export function isStoryEventTime(value: unknown): value is StoryEventTime {
  if (!isRecord(value)) return false;
  const day = value.day;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 1) return false;
  return value.part === null || isStoryDayPart(value.part);
}

/**
 * The ONE total order over story times (design: a structural `(day, part)`
 * comparison — a `StoryClock` is accepted wherever a time is expected because
 * it is a structural superset of `StoryEventTime`). Days compare first;
 * within a day, a `null` part ranks exactly as `morning`. Returns < 0, 0 or
 * > 0 in the usual way, for both event-vs-event and event-vs-clock use.
 */
export function compareStoryTime(a: StoryEventTime, b: StoryEventTime): number {
  if (a.day !== b.day) return a.day - b.day;
  return storyTimeRank(a.part) - storyTimeRank(b.part);
}

/**
 * Advance the clock one day-part: morning -> day -> evening -> night -> the
 * NEXT day's morning. A `null` part advances exactly like `morning` (it
 * ranks with it), so it lands on `day` of the same story day. The display
 * label is carried through unchanged — it is not derived from the part.
 */
export function nextStoryDayPart(clock: StoryClock): StoryClock {
  const rank = storyTimeRank(clock.part);
  const rollover = rank === STORY_DAY_PART_ORDER.length - 1;
  if (rollover) {
    return { day: clock.day + 1, part: STORY_DAY_PART.morning, label: clock.label };
  }
  return { day: clock.day, part: STORY_DAY_PART_ORDER[rank + 1], label: clock.label };
}

/**
 * One day forward, same time of day: evening -> the next day's evening, and
 * a `null` part stays `null` (design: same-time-next-day keeps durations
 * exact — evening to evening is precisely one day, while resetting to the
 * day's start would silently shorten the skipped day). The display label is
 * carried through unchanged.
 */
export function addStoryDay(clock: StoryClock): StoryClock {
  return { day: clock.day + 1, part: clock.part, label: clock.label };
}

/**
 * Due rule (DK-1): an undated task is always due; a dated task is due when
 * the clock exists and its time has arrived (`at <= clock`, by
 * {@link compareStoryTime}). With no clock a dated task is treated as
 * undated — an absent clock must never hide events, so `clock === null`
 * reproduces the pre-clock behavior for dated and undated tasks alike.
 */
export function isStoryEventDue(task: AgentPlanTask, clock: StoryClock | null): boolean {
  if (task.at === undefined) return true;
  if (clock === null) return true;
  return compareStoryTime(task.at, clock) <= 0;
}

/**
 * The ONE current-event rule (DK-1), time-aware: the first `active` task,
 * else the first `pending` task that is due, else null. With `clock === null`
 * every dated task is due, so this equals the pre-clock rule (first active,
 * else first pending) for dated and undated tasks alike — the equality the
 * story-clock tests pin. With a clock, a not-yet-due pending is skipped in
 * favor of the first pending that IS due.
 */
export function pickCurrentPlanTask(
  tasks: readonly AgentPlanTask[],
  clock: StoryClock | null,
): AgentPlanTask | null {
  for (const task of tasks) {
    if (task.status === "active") return task;
  }
  for (const task of tasks) {
    if (task.status === "pending" && isStoryEventDue(task, clock)) return task;
  }
  return null;
}

/**
 * The interrupt rule (plan ruling K3): `taskId` becomes the current event —
 * it takes the current event's position and turns `active`, while the
 * interrupted active event turns `pending` and sits directly AFTER the
 * target. Here "the current event" is the first `active` task (the rule
 * speaks of "the interrupted active event"; time does not gate an explicit
 * promotion). A target that is already the current event — or that matches
 * no task — returns the plan unchanged. With no active event present there
 * is nothing to interrupt and no position to take: the target just turns
 * `active` in place. Pure; `at` stamps are never touched (promotion is
 * positional, not temporal), and the result carries exactly one active task,
 * so it passes `normalizeAgentPlan`.
 */
export function promoteStoryEvent(plan: AgentPlan, taskId: string): AgentPlan {
  const currentIndex = plan.tasks.findIndex((task) => task.status === "active");
  const targetIndex = plan.tasks.findIndex((task) => task.id === taskId);
  if (targetIndex === -1 || currentIndex === targetIndex) return plan;

  if (currentIndex === -1) {
    return {
      ...plan,
      tasks: plan.tasks.map((task): AgentPlanTask =>
        task.id === taskId ? { ...task, status: "active" } : task,
      ),
    };
  }

  const tasks = plan.tasks.slice();
  const target = tasks[targetIndex];
  tasks.splice(targetIndex, 1);
  const insertAt = targetIndex < currentIndex ? currentIndex - 1 : currentIndex;
  tasks.splice(insertAt, 0, { ...target, status: "active" });
  const interrupted = tasks[insertAt + 1];
  tasks[insertAt + 1] = { ...interrupted, status: "pending" };
  return { ...plan, tasks };
}
