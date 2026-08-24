/**
 * RX-13 assembled-prompt seam tests: `applyRegexToChatHistory` mode isolation.
 *
 * Pins the four-mode apply-target matrix as it crosses the PROMPT boundary:
 * - prompt-only and display+prompt presets DO transform assembled history;
 * - display-only and persist presets do NOT (display belongs to the client
 *   render seam; persist already wrote the stored text at generation time —
 *   transforming again would double-apply);
 * - disabled presets never apply anywhere;
 * - placement maps to role (USER_INPUT=1 → user, AI_OUTPUT=2 → assistant);
 * - depth counts from the end of history (ST: depth 0 = last message);
 * - purity: the input messages array and its elements are never mutated.
 */
import { describe, it, expect } from "bun:test";
import { brandId, REGEX_PLACEMENT, type RegexPreset, type RegexPresetId } from "@vibe-tavern/domain";

import { applyRegexToChatHistory } from "../src/regex-engine.ts";

let seq = 0;
function makePreset(overrides: Partial<RegexPreset> = {}): RegexPreset {
  return {
    id: brandId<RegexPresetId>(`rx13_${seq++}`),
    name: "t",
    findRegex: "/secret/g",
    replaceString: "[redacted]",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [REGEX_PLACEMENT.AiOutput],
    isGlobal: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function history() {
  return [
    { id: "m1", role: "user" as const, content: "hello secret user" },
    { id: "m2", role: "assistant" as const, content: "hi secret bot" },
    { id: "m3", role: "user" as const, content: "bye secret user" },
  ];
}

describe("applyRegexToChatHistory — mode isolation (RX-13)", () => {
  it("prompt-only presets transform assembled history", () => {
    const out = applyRegexToChatHistory(history(), [makePreset({ promptOnly: true })]);
    // Default placement is AI_OUTPUT → only the assistant message transforms.
    expect(out.map((m) => m.content)).toEqual(["hello secret user", "hi [redacted] bot", "bye secret user"]);
  });

  it("display+prompt (markdownOnly && promptOnly) presets transform assembled history", () => {
    const out = applyRegexToChatHistory(history(), [makePreset({ markdownOnly: true, promptOnly: true })]);
    expect(out[1].content).toBe("hi [redacted] bot");
  });

  it("display-only (markdownOnly alone) presets do NOT touch the prompt", () => {
    const msgs = history();
    const out = applyRegexToChatHistory(msgs, [makePreset({ markdownOnly: true })]);
    expect(out).toBe(msgs); // same reference — no prompt-side work at all
  });

  it("persist presets are excluded here (already applied at generation time — no double-apply)", () => {
    const msgs = history();
    const out = applyRegexToChatHistory(msgs, [makePreset()]);
    expect(out).toBe(msgs);
  });

  it("disabled presets never apply", () => {
    const msgs = history();
    const out = applyRegexToChatHistory(msgs, [makePreset({ promptOnly: true, disabled: true })]);
    expect(out).toBe(msgs);
  });
});

describe("applyRegexToChatHistory — placement & depth (RX-13)", () => {
  it("USER_INPUT placement applies to user messages only, AI_OUTPUT to assistant only", () => {
    const out = applyRegexToChatHistory(history(), [makePreset({ promptOnly: true, placement: [REGEX_PLACEMENT.UserInput] })]);
    expect(out.map((m) => m.content)).toEqual(["hello [redacted] user", "hi secret bot", "bye [redacted] user"]);
  });

  it("a script with both codes applies to both roles", () => {
    const out = applyRegexToChatHistory(history(), [makePreset({ promptOnly: true, placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput] })]);
    expect(out.every((m) => m.content.includes("[redacted]"))).toBe(true);
  });

  it("maxDepth 0 restricts to the last message only (ST depth semantics)", () => {
    const out = applyRegexToChatHistory(
      history(),
      [makePreset({ promptOnly: true, placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput], maxDepth: 0 })],
    );
    expect(out.map((m) => m.content)).toEqual(["hello secret user", "hi secret bot", "bye [redacted] user"]);
  });

  it("minDepth bounds exclude the very last message", () => {
    const out = applyRegexToChatHistory(
      history(),
      [makePreset({ promptOnly: true, placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput], minDepth: 1 })],
    );
    expect(out.map((m) => m.content)).toEqual(["hello [redacted] user", "hi [redacted] bot", "bye secret user"]);
  });
});

describe("applyRegexToChatHistory — purity (RX-13)", () => {
  it("never mutates the input messages", () => {
    const msgs = history();
    const snapshot = JSON.stringify(msgs);
    applyRegexToChatHistory(msgs, [makePreset({ promptOnly: true })]);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("returns the same reference when nothing applies", () => {
    const msgs = history();
    expect(applyRegexToChatHistory(msgs, [])).toBe(msgs);
  });

  it("clones only transformed messages (untransformed keep identity)", () => {
    const msgs = history();
    const out = applyRegexToChatHistory(msgs, [makePreset({ promptOnly: true, placement: [REGEX_PLACEMENT.UserInput] })]);
    expect(out[0]).not.toBe(msgs[0]); // transformed user msg → clone
    expect(out[1]).toBe(msgs[1]); // untouched assistant msg → same object
  });
});
