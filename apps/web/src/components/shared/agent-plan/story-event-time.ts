import type { StoryDayPart, StoryEventTime } from "@vibe-tavern/domain";
import type { TFunc } from "../../../i18n/context.js";
import type Resources from "../../../i18n/resources.js";

/**
 * story-event-time (DIRECTOR_DECK_CALENDAR_PLAN DK-10, mockup §6) — the ONE
 * home for the story-event time chip: the part→i18n-key map (moved here from
 * StoryCalendarView, which now imports it — a second hand-written map would
 * be a copy #2 defect), the at→label formatter, and the muted chip's classes.
 *
 * Consumers: AgentPlanPanel (the events tab's dated rows), the story plan
 * proposal card (dated proposed rows), StoryCalendarView (the grid's part
 * row labels). Payload-only — the formatter needs NO clock; the "awaits its
 * time" mark is panel-side (it needs the domain due rule) and stays there.
 */

/** Localized day-part labels (the story-namespace keys; the stored clock
 *  vocabulary stays the four English STORY_DAY_PART words). */
export const PART_LABEL_KEYS: Record<StoryDayPart, keyof Resources["en"]> = {
  morning: "story_clock_part_morning",
  day: "story_clock_part_day",
  evening: "story_clock_part_evening",
  night: "story_clock_part_night",
};

/** The muted time chip (mockup §6 `.tchip`: muted on s2, never wraps) — the
 *  SAME frame the panel's dated rows and the proposal card's dated rows
 *  render; the panel's "awaits" mark composes the same frame with the
 *  warning tint locally. */
export const storyEventTimeChipCls =
  "mt-px shrink-0 whitespace-nowrap rounded bg-s2 px-1.5 py-px font-ui text-[calc(var(--ui-fs)-4px)] text-t3";

/**
 * The ONE at→label derivation (mockup §6): a null part renders just the day
 * label (`story_event_at_day`), a named part renders "day N · part"
 * (`story_event_at_day_part` + the `story_clock_part_*` labels through
 * {@link PART_LABEL_KEYS}). Payload-only: a caller needs no clock to format
 * a stored `at`.
 */
export function storyEventTimeLabel(at: StoryEventTime, t: TFunc): string {
  if (at.part === null) return t("story_event_at_day", { day: at.day });
  return t("story_event_at_day_part", { day: at.day, part: t(PART_LABEL_KEYS[at.part]) });
}
