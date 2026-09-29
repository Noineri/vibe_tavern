import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Leading content decorators — parseDecorators parity (resweep P7).
 *
 * ST world-info.js 4540-4586 parses every leading `@@` line, recognizes
 * known decorators with startsWith, skips an `@@@` line until parsing has
 * fallen back, and removes the leading decorator block from entry content.
 * The parsed content, rather than the raw source, is both injected and added
 * to ST's recursion text (call site 4517-4523; scan loop 4763-4771).
 *
 * Local harness fork of the sibling lore-activation suites' makeEntry /
 * makeInput (tri-state-matching carries the canonical copy).
 */

function makeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    content: `content of ${id}`,
    keys: [] as string[],
    secondaryKeys: [] as string[],
    logic: "and_any",
    position: "before_char",
    depth: 0,
    priority: 100,
    stickyWindow: 0,
    cooldownWindow: 0,
    minChatMessages: 0,
    constant: false,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 0,
    prioritizeInclusion: false,
    useGroupScoring: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
    scanDepthOverride: null,
    caseSensitive: null,
    matchWholeWords: null,
    characterFilter: [] as Array<{ id: string | null; name: string }>,
    characterFilterExclude: false,
    matchSources: [] as string[],
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

function makeInput(
  entries: ReturnType<typeof makeEntry>[],
  opts: {
    book?: Record<string, unknown>;
    text?: string;
  } & Partial<ActivationInput> = {},
): ActivationInput {
  return {
    lorebooks: [
      {
        id: "lb_test",
        scanDepth: 1,
        tokenBudget: 100_000,
        tokenBudgetPercent: null,
        recursiveScanning: false,
        maxRecursionSteps: 0,
        includeNames: false,
        minActivations: 0,
        minActivationsDepthMax: 0,
        entries,
        ...opts.book,
      },
    ],
    messages: opts.text === undefined ? [] : [{ role: "user", content: opts.text }],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    ...opts,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((entry) => entry.id);
}

function activatedContent(result: ReturnType<typeof resolveActivatedEntries>, id: string): string | undefined {
  return result.activatedEntries.find((entry) => entry.id === id)?.content;
}

describe("lore activation engine — leading content decorators (P7)", () => {
  it("recognizes @@activate after an escaped leading @@@ line", () => {
    const entry = makeEntry("line_two", { content: "@@@note\n@@activate\nBody" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry])))).toEqual(["line_two"]);
  });

  it("treats @@@activate as an escape, not an activation decorator", () => {
    const entry = makeEntry("escaped_activate", { content: "@@@activate\nBody" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry])))).toEqual([]);
  });

  it("does not recognize a decorator after leading whitespace", () => {
    const entry = makeEntry("indented", { content: "  @@activate\nBody" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry])))).toEqual([]);
  });

  it("removes every leading decorator line from injected content", () => {
    const entry = makeEntry("stripped", { content: "@@activate\n@@dont_activate\nBody" });
    const result = resolveActivatedEntries(makeInput([entry]));
    expect(activatedIds(result)).toEqual(["stripped"]);
    expect(activatedContent(result, "stripped")).toBe("Body");
  });

  it("recognizes decorator prefixes with startsWith while only exact tokens activate", () => {
    const entry = makeEntry("suffix", { constant: true, content: "@@activate for this turn\nBody" });
    const result = resolveActivatedEntries(makeInput([entry]));
    expect(activatedIds(result)).toEqual(["suffix"]);
    expect(activatedContent(result, "suffix")).toBe("Body");
  });

  it("gives @@activate precedence when the leading block contains both decorators", () => {
    const entry = makeEntry("active_wins", { content: "@@dont_activate\n@@activate\nBody" });
    expect(activatedIds(resolveActivatedEntries(makeInput([entry])))).toEqual(["active_wins"]);
  });

  it("seeds recursive scanning with stripped content", () => {
    const anchor = makeEntry("anchor", { content: "@@activate\nBody" });
    const leakedDecoratorKey = makeEntry("leaked_decorator_key", { keys: ["activate"] });
    const result = resolveActivatedEntries(makeInput([anchor, leakedDecoratorKey], {
      book: { recursiveScanning: true, maxRecursionSteps: 2 },
    }));
    expect(activatedIds(result)).toEqual(["anchor"]);
  });
});
