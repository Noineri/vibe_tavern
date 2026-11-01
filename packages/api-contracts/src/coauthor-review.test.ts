import { expect, test } from "bun:test";
import { buildCoauthorReviewEnvelope, coauthorReviewActivityFromResult, coauthorReviewEnvelopeSchema, type CoauthorReviewActivity } from "./coauthor-review.js";

const profile = { toolCallId: "profile", toolName: "write_profile", status: "done", target: "profile", proposed: "# PERSONALITY\nNew", summary: "Edited", args: { profileMd: "# PERSONALITY\nNew" } } satisfies CoauthorReviewActivity;

test("the CA-15 v1 envelope round-trips profile/greeting/lore proposals and their native inputs", () => {
  const activities: CoauthorReviewActivity[] = [profile,
    { toolCallId: "greeting", toolName: "edit_greeting", status: "done", target: "greeting", proposed: "Hi", greetingIndex: 0, isAdd: false },
    { toolCallId: "lore", toolName: "edit_lore", status: "done", loreBundle: { revision: 3, lorebooks: [], entries: [] } },
  ];
  expect(coauthorReviewEnvelopeSchema.parse(JSON.parse(JSON.stringify({ _v: 1, activities })))).toEqual({ _v: 1, activities });
});

test("only finalized real proposals qualify; wrong versions, malformed data and empty drafts are rejected", () => {
  for (const activity of [{ ...profile, status: "streaming" }, { ...profile, status: "error" }, { ...profile, proposed: "" },
    { toolCallId: "read", toolName: "read_skill_file", status: "done", readPath: "skill.md" }, { ...profile, greetingIndex: -1 }, { ...profile, loreBundle: { lorebooks: "bad" } }]) {
    expect(coauthorReviewEnvelopeSchema.safeParse({ _v: 1, activities: [activity] }).success).toBe(false);
  }
  expect(coauthorReviewEnvelopeSchema.safeParse({ _v: 2, activities: [profile] }).success).toBe(false);
  expect(coauthorReviewEnvelopeSchema.safeParse({ _v: 1, activities: [] }).success).toBe(false);
});

test("projection ignores reads/errors, normalizes the historical alias and preserves cumulative lore revision", () => {
  const base = { toolCallId: "call", toolName: "edit_profile", args: { content: "Input" }, result: { target: "profile", proposed: "New", summary: "Edited" } };
  expect(coauthorReviewActivityFromResult(base)).toMatchObject({ toolName: "write_profile", status: "done", args: base.args, proposed: "New" });
  expect(coauthorReviewActivityFromResult({ ...base, isError: true })).toBeNull();
  expect(coauthorReviewActivityFromResult({ ...base, toolName: "read_skill_file", result: { path: "skill.md", content: "Read" } })).toBeNull();
  expect(coauthorReviewActivityFromResult({ ...base, toolName: "edit_lore", result: { target: "lore_bundle", summary: "Lore", bundle: { revision: 8, lorebooks: [], entries: [] } } }))
    .toMatchObject({ loreBundle: { revision: 8, lorebooks: [], entries: [] } });
});

test("tracker-template proposals use the existing canonical schema rather than being dropped by the legacy filter", () => {
  const activity = coauthorReviewActivityFromResult({ toolCallId: "tracker", toolName: "set_tracker_template", result: { summary: "Tracker", trackerTemplate: { version: 1, scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } } } } });
  expect(activity?.trackerTemplate).toMatchObject({ version: 1, scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } } });
  expect(buildCoauthorReviewEnvelope([activity])?.activities).toHaveLength(1);
});

test("finalization dedupes in first-insertion order, with the latest valid result winning and no-proposal turns returning null", () => {
  const greeting = { ...profile, toolCallId: "greeting", target: "greeting", proposed: "Hi" };
  expect(buildCoauthorReviewEnvelope([profile, greeting, { ...profile, proposed: "Revised" }])?.activities.map(({ toolCallId, proposed }) => [toolCallId, proposed]))
    .toEqual([["profile", "Revised"], ["greeting", "Hi"]]);
  expect(buildCoauthorReviewEnvelope([null, { status: "streaming" }])).toBeNull();
});
