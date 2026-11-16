/**
 * The story clock fields in a Scene Tracker schema (DIRECTOR_DECK_CALENDAR_PLAN
 * DK-2): the ONE canonical field set, the pure reader from a scene record to a
 * {@link StoryClock}, and the idempotent canonical-fields adder.
 *
 * A Scene Tracker DSL may mark up to three TOP-LEVEL fields as the story clock
 * (`clock` markers on the schema nodes — see `SCENE_CLOCK_MARKER` in
 * `scene-tracker-constants.ts`; the marker rules are validator-enforced there).
 * This module is the single definition of what those fields look like and how
 * a per-variant scene record (`sceneState`) reads back into a
 * {@link StoryClock}: the scene-tracker time toggle (DK-9) and the director's
 * `withClock` (DK-5a) consume {@link STORY_CLOCK_SCENE_FIELDS}; the scene
 * tracker prompt (DK-2 hint block) and any clock consumer read through
 * {@link readStoryClock} — never a second hand-written derivation.
 *
 * Pure leaf module: depends only on `story-clock.ts` (the DK-1 clock
 * vocabulary) and types from `scene-tracker-constants.ts`.
 */

import { SCENE_CLOCK_MARKER } from "./scene-tracker-constants.js";
import type { SceneClockMarker, SceneTrackerDsl, SceneTrackerSchemaNode } from "./scene-tracker-constants.js";
import { isStoryDayPart } from "./story-clock.js";
import type { StoryClock, StoryDayPart } from "./story-clock.js";
import { isRecord } from "./is-record.js";

/**
 * The ONE canonical story clock field set (DK-2): the three fields a schema
 * gains when the story clock is turned on — the 1-based day counter (a number
 * node marked `"day"`), the named part of the day (a string node marked
 * `"part"`), and the free-form date label (a string node marked `"label"`).
 * Each entry carries the canonical machine key and the ready-to-embed node
 * (marker + human label included); consumers embed `node` verbatim so the
 * definition cannot drift between the ones that add the fields.
 *
 * Labels are English by design (like every authored schema label in the code);
 * localized display names are a later unit's locale concern and must live in
 * the locale files, never here.
 */
export const STORY_CLOCK_SCENE_FIELDS = {
  day: {
    key: "story_day",
    node: { $type: "number", clock: SCENE_CLOCK_MARKER.day, label: "Story day" },
  },
  part: {
    key: "story_time",
    node: { $type: "string", clock: SCENE_CLOCK_MARKER.part, label: "Part of day" },
  },
  label: {
    key: "story_date",
    node: { $type: "string", clock: SCENE_CLOCK_MARKER.label, label: "Date label" },
  },
} as const satisfies Record<string, { key: string; node: SceneTrackerSchemaNode }>;

/** Canonical story clock field roles. */
export type StoryClockSceneField = keyof typeof STORY_CLOCK_SCENE_FIELDS;

/** A top-level DSL field found carrying a clock marker. */
export interface SceneClockFieldRef {
  /** The machine key the field sits under in THIS schema. */
  key: string;
  /** The marker it carries (`day`, `part` or `label`). */
  marker: SceneClockMarker;
  /** The marked node verbatim. */
  node: SceneTrackerSchemaNode;
}

/**
 * Find the first top-level DSL field carrying `marker` (schemas are
 * validator-ruled to at most one per marker; a hand-authored duplicate reads
 * the first match in key order rather than throwing — the reader is tolerant,
 * the validator is the loud boundary). Only top-level fields are considered,
 * mirroring the validator's placement rule. Pure.
 */
export function findSceneClockField(dsl: SceneTrackerDsl, marker: SceneClockMarker): SceneClockFieldRef | null {
  for (const [key, node] of Object.entries(dsl)) {
    const clock = node.$type === "string" || node.$type === "number" ? node.clock : undefined;
    if (clock === marker) return { key, marker, node };
  }
  return null;
}

/**
 * The ONE pure reader from a scene record to the story clock (DK-2):
 * `null` when the schema has no marked `"day"` field, when the record is not
 * a readable object, or when the day value is not a valid number — a finite
 * number >= 1 (a day below 1, a fraction of unreadable provenance excepted,
 * NaN/Infinity included, all read `null`; the 1-based rule matches
 * `isStoryEventTime`'s day rule). The part is read from the marked `"part"`
 * field and must be exactly one of the four `STORY_DAY_PART` words — the
 * canonical stored vocabulary; an unknown word (any other spelling, case or
 * language) reads `part: null` and the raw text stays OUT of the clock, so
 * the clock never carries an unrankable part. The label is read from the
 * marked `"label"` field as `string | null` (display-only, never interpreted).
 * A missing part/label field (or a non-conforming value) reads `null` there —
 * only the day gates the whole clock. Never throws; never mutates.
 */
export function readStoryClock(dsl: SceneTrackerDsl, sceneState: unknown): StoryClock | null {
  const dayField = findSceneClockField(dsl, SCENE_CLOCK_MARKER.day);
  if (!dayField) return null;
  if (!isRecord(sceneState)) return null;
  const rawDay = sceneState[dayField.key];
  if (typeof rawDay !== "number" || !Number.isFinite(rawDay) || rawDay < 1) return null;

  const partField = findSceneClockField(dsl, SCENE_CLOCK_MARKER.part);
  const rawPart = partField ? sceneState[partField.key] : undefined;
  const part: StoryDayPart | null = isStoryDayPart(rawPart) ? rawPart : null;

  const labelField = findSceneClockField(dsl, SCENE_CLOCK_MARKER.label);
  const rawLabel = labelField ? sceneState[labelField.key] : undefined;
  const label = typeof rawLabel === "string" ? rawLabel : null;

  return { day: rawDay, part, label };
}

/**
 * Add the missing canonical story clock fields to a DSL (pure; never mutates
 * the input): a field is added only when its marker is not already present
 * anywhere at the top level (an existing marked field wins — the canonical
 * field is never duplicated) AND its canonical key is free.
 *
 * Key collision rule (pinned, least-destructive): if a user field already
 * occupies a canonical key (e.g. a `story_day` string node without the
 * marker), that canonical field is SKIPPED — the user's node is never
 * renamed, retyped, overwritten or marked; no alternate key is invented. The
 * adder would rather leave the clock incomplete (the reader then reads
 * `null`) than destroy or reinterpret a single authored byte.
 *
 * Idempotent: a schema that already carries the canonical fields (or any
 * fields with the same markers) round-trips unchanged.
 */
export function withStoryClockFields(dsl: SceneTrackerDsl): SceneTrackerDsl {
  const marked = new Set<SceneClockMarker>();
  for (const node of Object.values(dsl)) {
    const clock = node.$type === "string" || node.$type === "number" ? node.clock : undefined;
    if (clock !== undefined) marked.add(clock);
  }
  const out: SceneTrackerDsl = { ...dsl };
  for (const field of Object.values(STORY_CLOCK_SCENE_FIELDS)) {
    if (marked.has(field.node.clock)) continue;
    if (out[field.key] !== undefined) continue;
    out[field.key] = field.node;
  }
  return out;
}
