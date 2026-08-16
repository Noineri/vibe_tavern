import { test, expect } from "bun:test";
import { canShowStarPrompt } from "./star-prompt-trigger.js";

test("the prompt is allowed on a quiet screen", () => {
  expect(canShowStarPrompt({ wizardVisible: false, anyModalOpen: false, anyGenerationActive: false })).toBe(true);
});

test("the first-run wizard suppresses the prompt", () => {
  expect(canShowStarPrompt({ wizardVisible: true, anyModalOpen: false, anyGenerationActive: false })).toBe(false);
});

test("another open modal suppresses the prompt", () => {
  expect(canShowStarPrompt({ wizardVisible: false, anyModalOpen: true, anyGenerationActive: false })).toBe(false);
});

test("a generation running in another chat suppresses the prompt", () => {
  expect(canShowStarPrompt({ wizardVisible: false, anyModalOpen: false, anyGenerationActive: true })).toBe(false);
});
