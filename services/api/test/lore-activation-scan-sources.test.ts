import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Injected-prompt scan sources — ST parity (P15).
 *
 * ST marks Author's Note scans with allowWIScan, defaulting it OFF
 * (authors-note.js:295-305, 375-392), and passes that same flag to the
 * character depth prompt (script.js:4415-4430). VT deliberately has no
 * global flag: each entry's selected source chip is its default-off gate.
 * ST always scans the persona-at-depth prompt (script.js:3155-3166); VT's
 * existing persona_desc chip needs no separate global gate.
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
  overrides: Partial<ActivationInput> = {},
): ActivationInput {
  return {
    lorebooks: [{
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
    }],
    messages: [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Character",
    activationState: {},
    currentTurn: 0,
    ...overrides,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map((entry) => entry.id);
}

describe("lore activation engine — injected-prompt scan sources (P15)", () => {
  it("scans Author's Note only for entries with the authors_note chip", () => {
    const optedIn = makeEntry("authors_note_opted_in", {
      keys: ["author-key"],
      matchSources: ["authors_note"],
    });
    const optedOut = makeEntry("authors_note_opted_out", { keys: ["author-key"] });

    const result = resolveActivatedEntries(makeInput([optedIn, optedOut], {
      authorsNote: "author-key",
    }));

    expect(activatedIds(result)).toEqual(["authors_note_opted_in"]);
  });

  it("scans enabled summary text only for entries with the summaries chip", () => {
    const optedIn = makeEntry("summaries_opted_in", {
      keys: ["summary-key"],
      matchSources: ["summaries"],
    });
    const optedOut = makeEntry("summaries_opted_out", { keys: ["summary-key"] });

    const result = resolveActivatedEntries(makeInput([optedIn, optedOut], {
      summaries: ["summary-key"],
    }));

    expect(activatedIds(result)).toEqual(["summaries_opted_in"]);
  });

  it("does not let either injected source activate an entry without its chip", () => {
    const authorEntry = makeEntry("author_without_chip", { keys: ["author-key"] });
    const summaryEntry = makeEntry("summary_without_chip", { keys: ["summary-key"] });

    const result = resolveActivatedEntries(makeInput([authorEntry, summaryEntry], {
      authorsNote: "author-key",
      summaries: ["summary-key"],
    }));

    expect(activatedIds(result)).toEqual([]);
  });

  it("keeps persona description scanning available without a global scan gate", () => {
    const entry = makeEntry("persona_source", {
      keys: ["persona-key"],
      matchSources: ["persona_desc"],
    });

    const result = resolveActivatedEntries(makeInput([entry], {
      personaDescription: "persona-key",
    }));

    expect(activatedIds(result)).toEqual(["persona_source"]);
  });

  it("always scans the quiet prompt after global sources", () => {
    const entry = makeEntry("quiet_prompt_source", {
      keys: ["draft-only-key"],
    });

    const result = resolveActivatedEntries(makeInput([entry], {
      quietPrompt: "draft-only-key",
    }));

    expect(activatedIds(result)).toEqual(["quiet_prompt_source"]);
  });
});
