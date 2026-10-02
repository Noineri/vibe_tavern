import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Speaker names in lorebook scan text — ST parity (N1).
 *
 * ST builds `chatForWI` by mapping every scanned message to
 * `${x.name}: ${x.mes}` when world_info_include_names is on, then reverses
 * the list before passing it to World Info (public/script.js 4563-4572).
 * The prefix is scan input only: ST's recursion buffer receives stripped
 * activated content, not a speaker-prefixed copy (world-info.js 4517-4523).
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

describe("lore activation engine — speaker names in scan text (N1)", () => {
  it("matches a speaker-tag key when the book enables names", () => {
    const entry = makeEntry("speaker_key", { keys: ["Alice:"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      book: { includeNames: true },
      messages: [{ role: "user", name: "Alice", content: "opens the door" }],
    }));
    expect(activatedIds(result)).toEqual(["speaker_key"]);
  });

  it("does not match the same speaker-tag key when the book disables names", () => {
    const entry = makeEntry("speaker_key", { keys: ["Alice:"] });
    const result = resolveActivatedEntries(makeInput([entry], {
      messages: [{ role: "user", name: "Alice", content: "opens the door" }],
    }));
    expect(activatedIds(result)).toEqual([]);
  });

  it("does not prefix activated content with its entry title", () => {
    const entry = makeEntry("title_only", {
      title: "Unapproved title prefix",
      content: "Plain entry content",
      constant: true,
    });
    const result = resolveActivatedEntries(makeInput([entry], { book: { includeNames: true } }));
    expect(result.activatedEntries[0]?.content).toBe("Plain entry content");
  });

  it("keeps recursion text stripped and free of speaker-name prefixes", () => {
    const anchor = makeEntry("anchor", {
      content: "@@activate\nSeed text",
    });
    const speakerPrefixedTarget = makeEntry("speaker_prefixed_target", {
      keys: ["Alice: Seed text"],
    });
    const result = resolveActivatedEntries(makeInput([anchor, speakerPrefixedTarget], {
      book: { includeNames: true, recursiveScanning: true, maxRecursionSteps: 2 },
      messages: [{ role: "user", name: "Alice", content: "origin" }],
    }));
    expect(activatedIds(result)).toEqual(["anchor"]);
  });
});
