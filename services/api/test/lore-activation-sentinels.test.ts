import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Scan-buffer sentinels — ST parity (N2).
 *
 * WorldInfoBuffer.get wraps the initial depth-buffer source with `\x01` and
 * joins every further scanned unit with `\n\x01` (ST world-info.js 278-325).
 * That includes selected global sources and recursion-buffer units. The
 * control sentinel is not whitespace (`/\s/.test("\x01") === false`), so a
 * regex using `\s` cannot cross a source seam while matching inside one unit
 * remains unchanged.
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
    messages?: Array<{ role: string; content: string; name?: string }>;
  } & Partial<ActivationInput> = {},
): ActivationInput {
  return {
    lorebooks: [
      {
        id: "lb_test",
        scanDepth: 10,
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
    messages: opts.messages ?? [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Character",
    activationState: {},
    currentTurn: opts.messages?.length ?? 0,
    ...opts,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((entry) => entry.id);
}

describe("lore activation engine — scan-buffer sentinels (N2)", () => {
  it("does not let a regex using \\s cross two chat-message seams", () => {
    const entry = makeEntry("regex_cross_message", { keys: ["/blue\\ssky/"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      messages: [
        { role: "user", content: "the blue" },
        { role: "assistant", content: "sky is clear" },
      ],
    }));
    expect(activatedIds(result)).toEqual([]);
  });

  it("still lets a regex using \\s match inside one chat message", () => {
    const entry = makeEntry("regex_within_message", { keys: ["/blue\\ssky/"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      messages: [{ role: "user", content: "the blue sky is clear" }],
    }));
    expect(activatedIds(result)).toEqual(["regex_within_message"]);
  });

  it("keeps a plain multi-word key from crossing two chat messages", () => {
    const entry = makeEntry("plain_cross_message", { keys: ["blue sky"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      messages: [
        { role: "user", content: "the blue" },
        { role: "assistant", content: "sky is clear" },
      ],
    }));
    expect(activatedIds(result)).toEqual([]);
  });

  it("delimits selected global scan sources with the same sentinel seam", () => {
    const entry = makeEntry("regex_cross_source", {
      keys: ["/blue\\ssky/"],
      matchSources: ["character_desc", "character_personality"],
    });
    const result = resolveActivatedEntries(makeInput([entry], {
      characterDescription: "the blue",
      characterPersonality: "sky is clear",
    }));
    expect(activatedIds(result)).toEqual([]);
  });

  it("does not let a regex using \\s cross recursion-buffer pass seams", () => {
    // ST adds one joined content unit to its recursion buffer per scan pass
    // (world-info.js 5020-5024), then get() joins those units with \n\x01
    // (world-info.js 323-324).
    const anchor = makeEntry("anchor", { content: "@@activate\nthe blue" });
    const carrier = makeEntry("carrier", { keys: ["the blue"], content: "sky is clear" });
    const crossPass = makeEntry("regex_cross_recursion_pass", { keys: ["/blue\\ssky/"] });
    const result = resolveActivatedEntries(makeInput([anchor, carrier, crossPass], {
      book: { recursiveScanning: true, maxRecursionSteps: 3 },
      messages: [{ role: "user", content: "origin" }],
    }));
    expect(activatedIds(result)).toEqual(["anchor", "carrier"]);
  });

  it("keeps a speaker-tag key inside its name-prefixed message when names are enabled", () => {
    const entry = makeEntry("speaker_tag", { keys: ["Alice:"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      book: { includeNames: true },
      messages: [{ role: "user", name: "Alice", content: "opens the door" }],
    }));
    expect(activatedIds(result)).toEqual(["speaker_tag"]);
  });
});
