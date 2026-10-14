import { describe, expect, it } from "bun:test";
import { buildExperienceCopilotReviewSnapshot, experienceReviewRoundId } from "./experience-copilot-review-snapshot.js";

describe("experience copilot review snapshot", () => {
  it("normalizes overlapping selections as rejected and counts only locally applied accepts", () => {
    const snapshot = buildExperienceCopilotReviewSnapshot([{
      target: "rules",
      base: "const old = 1;",
      proposed: "const next = 2;",
      offeredHunkIds: [1, 2, 3, 4],
      acceptedHunkIds: new Set([1, 2]),
      dismissedHunkIds: new Set([2, 3]),
      appliedHunkIds: new Set([1]),
    }]);
    expect(snapshot.targets).toEqual([{
      target: "rules",
      roundId: experienceReviewRoundId("const old = 1;", "const next = 2;"),
      outcome: "applied-partial",
      hunks: { accepted: 1, rejected: 2, pending: 1 },
    }]);
  });

  it("uses a stable short content id and never puts documents into wire metadata", () => {
    const first = experienceReviewRoundId("before", "after");
    expect(first).toBe(experienceReviewRoundId("before", "after"));
    expect(first).toMatch(/^[a-f\d]{1,16}$/);
    expect(first).not.toBe(experienceReviewRoundId("before!", "after"));
    const snapshot = buildExperienceCopilotReviewSnapshot([]);
    expect(snapshot).toEqual({ targets: [] });
    expect(JSON.stringify(snapshot)).not.toContain("before");
  });

  it("keeps a too-large sentinel pending until its local application succeeds", () => {
    const pending = buildExperienceCopilotReviewSnapshot([{
      target: "visual", base: "a", proposed: "b", offeredHunkIds: [-1], acceptedHunkIds: new Set(), dismissedHunkIds: new Set(),
    }]);
    const applied = buildExperienceCopilotReviewSnapshot([{
      target: "visual", base: "a", proposed: "b", offeredHunkIds: [-1], acceptedHunkIds: new Set([-1]), dismissedHunkIds: new Set(), appliedHunkIds: new Set([-1]),
    }]);
    expect(pending.targets[0]!.hunks).toEqual({ accepted: 0, rejected: 0, pending: 1 });
    expect(applied.targets[0]!.outcome).toBe("applied");
  });
});
