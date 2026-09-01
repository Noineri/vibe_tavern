/**
 * STT quickstart recipes (STT_PLAN ST-4a): direct vendors only (owner rule —
 * an aggregator is not a provider), unique ids, each recipe lands on a
 * complete openai-compat config.
 */

import { describe, expect, test } from "bun:test";

import { STT_QUICKSTARTS, getSttQuickstart } from "./stt-quickstarts.js";

describe("STT_QUICKSTARTS", () => {
  test("three recipes with unique ids", () => {
    expect(STT_QUICKSTARTS.length).toBe(3);
    const ids = STT_QUICKSTARTS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every recipe carries a full endpoint + model", () => {
    for (const q of STT_QUICKSTARTS) {
      expect(q.endpoint.length).toBeGreaterThan(0);
      expect(q.model.length).toBeGreaterThan(0);
    }
  });

  test("no aggregator recipes (OpenRouter is a transport, not a provider)", () => {
    const labels = STT_QUICKSTARTS.map((q) => q.label.toLowerCase());
    expect(labels.some((l) => l.includes("openrouter"))).toBe(false);
    expect(STT_QUICKSTARTS.map((q) => q.endpoint).some((e) => e.includes("openrouter"))).toBe(false);
  });

  test("getSttQuickstart resolves known ids, null for unknown", () => {
    expect(getSttQuickstart("openai")?.model).toBe("whisper-1");
    expect(getSttQuickstart("nope")).toBeNull();
  });
});