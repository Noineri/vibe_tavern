import { test, expect } from "bun:test";
import {
  isStarPromptDue,
  nextStarPromptAt,
  repoWebUrl,
  starPromptInterval,
} from "./star-prompt.js";

test("the interval grows with deferrals and caps at 900", () => {
  expect(starPromptInterval(0)).toBe(100);
  expect(starPromptInterval(1)).toBe(300);
  expect(starPromptInterval(2)).toBe(900);
  expect(starPromptInterval(3)).toBe(900);
  expect(starPromptInterval(99)).toBe(900);
});

test("deferring walks the documented schedule 100 -> 400 -> 1300 -> 2200", () => {
  expect(nextStarPromptAt(100, 1)).toBe(400);
  expect(nextStarPromptAt(400, 2)).toBe(1300);
  expect(nextStarPromptAt(1300, 3)).toBe(2200);
});

test("deferring schedules from the live count, not the stale due point", () => {
  // A suppression guard let the count run to 137 while the modal was due at 100.
  expect(nextStarPromptAt(137, 1)).toBe(437);
});

test("the prompt is due once the count reaches the due point", () => {
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 99, nextStarPromptAt: 100 })).toBe(false);
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 100, nextStarPromptAt: 100 })).toBe(true);
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 137, nextStarPromptAt: 100 })).toBe(true);
});

test("a starred user is never due, at any count", () => {
  expect(isStarPromptDue({ githubStarred: true, userMessageCount: 5000, nextStarPromptAt: 100 })).toBe(false);
});

test("the repo web URL is derived from the update API base", () => {
  expect(repoWebUrl()).toBe("https://github.com/Noineri/vibe_tavern");
});
