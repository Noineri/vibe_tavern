import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Scan depth zero — ST parity (P8).
 *
 * ST's WorldInfoBuffer.get returns before reading its depth buffer when the
 * requested depth is at or below its start depth (world-info.js:279-283),
 * and its ordinary buffer construction slices from that start depth to the
 * requested depth (world-info.js:295-297). VT must therefore exclude chat
 * messages at depth 0 without dropping its selected source joins.
 *
 * Local harness fork of lore-activation-sentinels.test.ts.
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
        scanDepth: 2,
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

describe("lore activation engine — scan depth zero (P8)", () => {
  it("excludes chat messages at book-level depth 0 while retaining enabled sources", () => {
    const chatEntry = makeEntry("chat_key", { keys: ["chat key"] });
    const sourceEntry = makeEntry("source_key", {
      keys: ["source key"],
      matchSources: ["character_desc"],
    });
    const result = resolveActivatedEntries(makeInput([chatEntry, sourceEntry], {
      book: { scanDepth: 0 },
      messages: [{ role: "user", content: "chat key" }],
      characterDescription: "source key",
    }));

    expect(activatedIds(result)).toEqual(["source_key"]);
  });

  it("excludes chat messages at per-entry depth override 0 while retaining enabled sources", () => {
    const chatEntry = makeEntry("chat_key", {
      keys: ["chat key"],
      scanDepthOverride: 0,
    });
    const sourceEntry = makeEntry("source_key", {
      keys: ["source key"],
      scanDepthOverride: 0,
      matchSources: ["character_desc"],
    });
    const result = resolveActivatedEntries(makeInput([chatEntry, sourceEntry], {
      book: { scanDepth: 2 },
      messages: [{ role: "user", content: "chat key" }],
      characterDescription: "source key",
    }));

    expect(activatedIds(result)).toEqual(["source_key"]);
  });

  it("scans only the last message at depth 1", () => {
    const firstEntry = makeEntry("first_key", { keys: ["first key"] });
    const lastEntry = makeEntry("last_key", { keys: ["last key"] });
    const result = resolveActivatedEntries(makeInput([firstEntry, lastEntry], {
      book: { scanDepth: 1 },
      messages: [
        { role: "user", content: "first key" },
        { role: "assistant", content: "last key" },
      ],
    }));

    expect(activatedIds(result)).toEqual(["last_key"]);
  });

  it("scans both messages at depth 2", () => {
    const firstEntry = makeEntry("first_key", { keys: ["first key"] });
    const lastEntry = makeEntry("last_key", { keys: ["last key"] });
    const result = resolveActivatedEntries(makeInput([firstEntry, lastEntry], {
      book: { scanDepth: 2 },
      messages: [
        { role: "user", content: "first key" },
        { role: "assistant", content: "last key" },
      ],
    }));

    expect(activatedIds(result)).toEqual(["first_key", "last_key"]);
  });
});
