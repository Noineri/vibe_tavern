import { test, expect } from "bun:test";
import {
  isStarPromptDue,
  nextStarPromptAt,
  repoWebUrl,
  starPromptInterval,
} from "./star-prompt.js";

test("the interval grows with deferrals and caps at 300", () => {
  expect(starPromptInterval(0)).toBe(10);
  expect(starPromptInterval(1)).toBe(100);
  expect(starPromptInterval(2)).toBe(300);
  expect(starPromptInterval(3)).toBe(300);
  expect(starPromptInterval(99)).toBe(300);
});

test("deferring walks the documented schedule 10 -> 110 -> 410 -> 710", () => {
  expect(nextStarPromptAt(10, 1)).toBe(110);
  expect(nextStarPromptAt(110, 2)).toBe(410);
  expect(nextStarPromptAt(410, 3)).toBe(710);
});

test("deferring schedules from the live count, not the stale due point", () => {
  // A suppression guard let the count run to 17 while the modal was due at 10.
  expect(nextStarPromptAt(17, 1)).toBe(117);
});

test("the prompt is due once the count reaches the due point", () => {
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 9, nextStarPromptAt: 10 })).toBe(false);
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 10, nextStarPromptAt: 10 })).toBe(true);
  expect(isStarPromptDue({ githubStarred: false, userMessageCount: 17, nextStarPromptAt: 10 })).toBe(true);
});

test("a starred user is never due, at any count", () => {
  expect(isStarPromptDue({ githubStarred: true, userMessageCount: 5000, nextStarPromptAt: 10 })).toBe(false);
});

test("the repo web URL is derived from the update API base", () => {
  expect(repoWebUrl()).toBe("https://github.com/Noineri/vibe_tavern");
});
