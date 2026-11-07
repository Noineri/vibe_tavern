import { describe, expect, it } from "bun:test";
import { STORY_DAY_PART } from "../src/story-clock.js";
import {
  STORY_CLOCK_SCENE_FIELDS,
  findSceneClockField,
  readStoryClock,
  withStoryClockFields,
} from "../src/story-clock-scene.js";
import type { SceneTrackerDsl } from "../src/scene-tracker-constants.js";
import { SCENE_CLOCK_MARKER } from "../src/scene-tracker-constants.js";

/** A complete canonical clock schema (the shape withStoryClockFields produces). */
const CANONICAL_DSL: SceneTrackerDsl = {
  mood: { $type: "string" },
  story_day: STORY_CLOCK_SCENE_FIELDS.day.node,
  story_time: STORY_CLOCK_SCENE_FIELDS.part.node,
  story_date: STORY_CLOCK_SCENE_FIELDS.label.node,
};

describe("STORY_CLOCK_SCENE_FIELDS (the ONE canonical field set)", () => {
  it("defines the three canonical fields with the canonical keys", () => {
    expect(STORY_CLOCK_SCENE_FIELDS.day.key).toBe("story_day");
    expect(STORY_CLOCK_SCENE_FIELDS.part.key).toBe("story_time");
    expect(STORY_CLOCK_SCENE_FIELDS.label.key).toBe("story_date");
  });

  it("carries validator-conformant nodes: day on a number, part/label on strings, English labels", () => {
    expect(STORY_CLOCK_SCENE_FIELDS.day.node).toEqual({ $type: "number", clock: "day", label: "Story day" });
    expect(STORY_CLOCK_SCENE_FIELDS.part.node).toEqual({ $type: "string", clock: "part", label: "Part of day" });
    expect(STORY_CLOCK_SCENE_FIELDS.label.node).toEqual({ $type: "string", clock: "label", label: "Date label" });
  });

  it("uses exactly the SCENE_CLOCK_MARKER vocabulary", () => {
    expect(STORY_CLOCK_SCENE_FIELDS.day.node.clock).toBe(SCENE_CLOCK_MARKER.day);
    expect(STORY_CLOCK_SCENE_FIELDS.part.node.clock).toBe(SCENE_CLOCK_MARKER.part);
    expect(STORY_CLOCK_SCENE_FIELDS.label.node.clock).toBe(SCENE_CLOCK_MARKER.label);
  });
});

describe("findSceneClockField", () => {
  it("finds marked fields by marker, following the marker not a canonical key", () => {
    const dsl: SceneTrackerDsl = {
      chapter: { $type: "number", clock: "day" },
      phase: { $type: "string", clock: "part" },
      caption: { $type: "string", clock: "label" },
    };
    expect(findSceneClockField(dsl, "day")?.key).toBe("chapter");
    expect(findSceneClockField(dsl, "part")?.key).toBe("phase");
    expect(findSceneClockField(dsl, "label")?.key).toBe("caption");
  });

  it("returns null for a marker no field carries", () => {
    expect(findSceneClockField({ mood: { $type: "string" } }, "day")).toBeNull();
    expect(findSceneClockField({}, "part")).toBeNull();
  });

  it("ignores markers on nested fields (top-level placement only, mirroring the validator)", () => {
    const dsl = {
      box: { $type: "object", properties: { hidden: { $type: "number", clock: "day" } } },
      list: { $type: "array", items: { $type: "string", clock: "part" } },
    } as unknown as SceneTrackerDsl;
    expect(findSceneClockField(dsl, "day")).toBeNull();
    expect(findSceneClockField(dsl, "part")).toBeNull();
  });

  it("reads the first match when a hand-authored schema duplicates a marker (tolerant reader; the validator is the loud boundary)", () => {
    const dsl: SceneTrackerDsl = {
      second: { $type: "number", clock: "day", min: 2 },
      first: { $type: "number", clock: "day", min: 1 },
    };
    expect(findSceneClockField(dsl, "day")?.key).toBe("second");
  });
});

describe("readStoryClock", () => {
  it("reads the full clock from a canonical record", () => {
    const clock = readStoryClock(CANONICAL_DSL, { story_day: 3, story_time: "evening", story_date: "March 3", mood: "calm" });
    expect(clock).toEqual({ day: 3, part: "evening", label: "March 3" });
  });

  it("reads each STORY_DAY_PART word", () => {
    for (const word of Object.values(STORY_DAY_PART)) {
      expect(readStoryClock(CANONICAL_DSL, { story_day: 1, story_time: word })?.part).toBe(word);
    }
  });

  it("reads a clock from user-marked fields (marker-driven, not key-driven)", () => {
    const dsl: SceneTrackerDsl = {
      chapter: { $type: "number", clock: "day" },
      phase: { $type: "string", clock: "part" },
    };
    expect(readStoryClock(dsl, { chapter: 7, phase: "night" })).toEqual({ day: 7, part: "night", label: null });
  });

  it("returns null when the schema marks no day field", () => {
    expect(readStoryClock({ mood: { $type: "string" } }, { story_day: 1 })).toBeNull();
    expect(readStoryClock({}, { story_day: 1 })).toBeNull();
    // part/label markers alone never substitute for the day.
    expect(readStoryClock({ story_time: { $type: "string", clock: "part" } }, { story_time: "day", story_day: 1 })).toBeNull();
  });

  it("returns null when the day value is not a valid number", () => {
    for (const bad of [undefined, null, "3", true, NaN, Infinity, -Infinity]) {
      expect(readStoryClock(CANONICAL_DSL, { story_day: bad })).toBeNull();
    }
  });

  it("returns null for a day below 1 (0 and negatives)", () => {
    expect(readStoryClock(CANONICAL_DSL, { story_day: 0 })).toBeNull();
    expect(readStoryClock(CANONICAL_DSL, { story_day: -2 })).toBeNull();
  });

  it("accepts day 1 and finite fractional days >= 1 (pinned: only finite >= 1 gates)", () => {
    expect(readStoryClock(CANONICAL_DSL, { story_day: 1 })).toEqual({ day: 1, part: null, label: null });
    expect(readStoryClock(CANONICAL_DSL, { story_day: 2.5 })).toEqual({ day: 2.5, part: null, label: null });
  });

  it("returns null when the record is not a readable object", () => {
    for (const bad of [null, undefined, "record", 42, [1, 2]]) {
      expect(readStoryClock(CANONICAL_DSL, bad)).toBeNull();
    }
  });

  it("reads part: null for an unknown part word — the raw text stays OUT of the clock", () => {
    for (const bad of ["Morning", "MORNING", "afternoon", "twilight", "", 3, null, true]) {
      const clock = readStoryClock(CANONICAL_DSL, { story_day: 2, story_time: bad });
      expect(clock).toEqual({ day: 2, part: null, label: null });
    }
  });

  it("reads label as string | null (missing field, non-string value)", () => {
    expect(readStoryClock(CANONICAL_DSL, { story_day: 1, story_date: "Day one" })?.label).toBe("Day one");
    expect(readStoryClock(CANONICAL_DSL, { story_day: 1, story_date: 5 })?.label).toBeNull();
    expect(readStoryClock(CANONICAL_DSL, { story_day: 1 })?.label).toBeNull();
    expect(readStoryClock(CANONICAL_DSL, { story_day: 1, story_date: null })?.label).toBeNull();
  });

  it("returns part/label null when the schema marks no part/label field", () => {
    const dsl: SceneTrackerDsl = { story_day: { $type: "number", clock: "day" } };
    expect(readStoryClock(dsl, { story_day: 4, story_time: "evening" })).toEqual({ day: 4, part: null, label: null });
  });

  it("never mutates the record", () => {
    const state = { story_day: 1, story_time: "bogus" };
    readStoryClock(CANONICAL_DSL, state);
    expect(state).toEqual({ story_day: 1, story_time: "bogus" });
  });
});

describe("withStoryClockFields", () => {
  it("adds all three canonical fields to a schema without any", () => {
    const out = withStoryClockFields({ mood: { $type: "string" } });
    expect(Object.keys(out).sort()).toEqual(["mood", "story_date", "story_day", "story_time"]);
    expect(out.story_day).toEqual({ $type: "number", clock: "day", label: "Story day" });
    expect(out.story_time).toEqual({ $type: "string", clock: "part", label: "Part of day" });
    expect(out.story_date).toEqual({ $type: "string", clock: "label", label: "Date label" });
  });

  it("adds all three canonical fields to an empty schema", () => {
    const out = withStoryClockFields({});
    expect(Object.keys(out).sort()).toEqual(["story_date", "story_day", "story_time"]);
  });

  it("never duplicates a marker: an existing marked field wins over the canonical one", () => {
    const dsl: SceneTrackerDsl = {
      chapter: { $type: "number", clock: "day" },
      phase: { $type: "string", clock: "part" },
    };
    const out = withStoryClockFields(dsl);
    expect(Object.keys(out).sort()).toEqual(["chapter", "phase", "story_date"]);
    expect(out.chapter).toEqual({ $type: "number", clock: "day" });
  });

  it("skips a canonical key occupied by an unmarked user field — the user node is never touched (pinned collision rule)", () => {
    const userNode = { $type: "string", label: "My own thing" } as const;
    const dsl: SceneTrackerDsl = { story_day: userNode };
    const out = withStoryClockFields(dsl);
    // story_day: collision → skipped, user node verbatim; the other two are added.
    expect(out.story_day).toBe(userNode);
    expect(out.story_time).toEqual({ $type: "string", clock: "part", label: "Part of day" });
    expect(out.story_date).toEqual({ $type: "string", clock: "label", label: "Date label" });
    expect(Object.keys(out).sort()).toEqual(["story_date", "story_day", "story_time"]);
  });

  it("is idempotent: applying twice equals applying once", () => {
    const once = withStoryClockFields({ mood: { $type: "string" } });
    expect(withStoryClockFields(once)).toEqual(once);
    const canonical = withStoryClockFields(CANONICAL_DSL);
    expect(canonical).toEqual(CANONICAL_DSL);
  });

  it("does not mutate the input DSL", () => {
    const dsl: SceneTrackerDsl = { mood: { $type: "string" } };
    withStoryClockFields(dsl);
    expect(dsl).toEqual({ mood: { $type: "string" } });
  });

  it("leaves a schema whose fields carry all three markers byte-identical", () => {
    const dsl: SceneTrackerDsl = {
      a: { $type: "number", clock: "day" },
      b: { $type: "string", clock: "part" },
      c: { $type: "string", clock: "label" },
      extra: { $type: "boolean" },
    };
    expect(withStoryClockFields(dsl)).toEqual(dsl);
  });
});
