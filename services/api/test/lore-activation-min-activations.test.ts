import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Min-activations widening (N9 / P6, resweep step 4).
 *
 * ST world-info.js 4987-5003: while min activations are not met, the scan
 * window widens by one message per retry (advanceScan = skew++), the cap is
 * on the ABSOLUTE depth (getDepth() = base + skew, world-info.js 402-404),
 * depth max 0 = unlimited widening bounded only by chat length
 * (`getDepth() > chat.length`), and the widened window persists into the
 * recursion passes (the skew lives in the scan buffer, so get() at any later
 * state sees base + skew too).
 *
 * The P6 probe: before the fix the retry loop never passed depthSkew into
 * buildScanText, so every retry rescanned the identical window —
 * `minActivations 1, depthMax 10, scanDepth 1`, key three messages back →
 * nothing activated (report §Diagnosis 5: "invisible to reading and obvious
 * to a one-scenario probe").
 *
 * Named deviation (owner ruling keeps per-book budgets; same shape here):
 * ST has ONE global depth base; VT's entries carry per-book scanDepth with
 * per-entry overrides, so the loop's "absolute depth" is measured from the
 * WIDEST base across entries — widening stops once the deepest current
 * window exceeds the cap.
 */

function makeEntry(id: string, keys: string[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    content: `<${id}>`,
    keys,
    secondaryKeys: [] as string[],
    logic: "and_any",
    position: "before_char",
    depth: 0,
    priority: 0,
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
    caseSensitive: false,
    matchWholeWords: false,
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
  messages: string[],
  bookOverrides: Record<string, unknown> = {},
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
        ...bookOverrides,
      },
    ],
    messages: messages.map((t, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
  };
}

function activatedIds(result: ReturnType<typeof resolveActivatedEntries>): string[] {
  return result.activatedEntries.map(e => e.id);
}

describe("min activations — widening (N9/P6)", () => {
  it("widening reaches a key beyond the base scan depth (the P6 probe)", () => {
    // scanDepth 1: the base window is the LAST message only. The key sits
    // three messages back. minActivations 1 forces retries; each retry must
    // widen the window by one message until the key is in scope (depth 3).
    const input = makeInput(
      [makeEntry("a", ["sigil"])],
      ["hello there", "plain talk", "the sigil glows", "wind outside", "morning"],
      { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 10 },
    );
    expect(activatedIds(resolveActivatedEntries(input))).toEqual(["a"]);
  });

  it("widening stops once min activations are met", () => {
    // Two entries: a's key one message back (in the base window), b's key far
    // back. minActivations 1 is met by a in the FIRST pass — no widening,
    // b stays out (widening is a remedy, not a sweep).
    const input = makeInput(
      [makeEntry("a", ["near"]), makeEntry("b", ["farback"])],
      ["the farback rune sleeps", "x", "x", "x", "a near shadow"],
      { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 10 },
    );
    expect(activatedIds(resolveActivatedEntries(input))).toEqual(["a"]);
  });

  it("the cap is on the ABSOLUTE depth, not the skew (ST getDepth())", () => {
    // scanDepth 2, key four messages back (needs depth 4). depthMax 3:
    // passes at depths 2 (miss), 3 (miss), then the pre-advance check allows
    // one more (3 <= 3) → depth 4 hits. ST's check is `depth > depthMax`
    // AFTER the pass, BEFORE advancing — so depthMax 3 admits depth 4.
    const messages = ["padding", "alpha rune", "x", "x", "closer"];
    const hit = makeInput(
      [makeEntry("a", ["alpha"])],
      messages,
      { scanDepth: 2, minActivations: 1, minActivationsDepthMax: 3 },
    );
    expect(activatedIds(resolveActivatedEntries(hit))).toEqual(["a"]);

    // depthMax 2: the same check stops after depth 3 (3 > 2) — the depth-4
    // window is never scanned, the entry stays out. (Under the old
    // skew-vs-cap comparison this case wrongly widened to depth 4.)
    const stop = makeInput(
      [makeEntry("a", ["alpha"])],
      messages,
      { scanDepth: 2, minActivations: 1, minActivationsDepthMax: 2 },
    );
    expect(activatedIds(resolveActivatedEntries(stop))).toEqual([]);
  });

  it("depthMax 0 = unlimited widening, bounded by chat length (terminates)", () => {
    // depthMax 0 disables the cap — widening is bounded only by
    // `depth > chat.length`. Three messages, key in the FIRST: found at
    // depth 3.
    const found = makeInput(
      [makeEntry("a", ["ember"])],
      ["an ember flickers", "x", "today"],
      { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 0 },
    );
    expect(activatedIds(resolveActivatedEntries(found))).toEqual(["a"]);

    // Unreachable min: the loop must TERMINATE once depth passes the chat
    // length (the bound is the only stop with depthMax 0).
    const never = makeInput(
      [makeEntry("a", ["absent"])],
      ["one", "two", "three"],
      { scanDepth: 1, minActivations: 2, minActivationsDepthMax: 0 },
    );
    expect(activatedIds(resolveActivatedEntries(never))).toEqual([]);
  });

  it("the widened window persists into recursion passes (skew lives in the buffer)", () => {
    // a's key sits three back → activates only via widening (depth 3).
    // b is delay-until-recursion: gated out of the normal pass, scanned in
    // the recursion pass — whose window must still be the WIDENED one (ST's
    // skew is buffer state, world-info.js 280/402). b's key exists ONLY in
    // the old message (a's content deliberately carries no key), so b
    // activates iff the recursion scan sees the widened window.
    const input = makeInput(
      [
        makeEntry("a", ["beacon"]),
        makeEntry("b", ["beacon"], { delayUntilRecursion: true }),
      ],
      ["a beacon burns", "x", "x", "quiet"],
      {
        scanDepth: 1,
        minActivations: 1,
        minActivationsDepthMax: 10,
        recursiveScanning: true,
        maxRecursionSteps: 2,
      },
    );
    expect(activatedIds(resolveActivatedEntries(input)).sort()).toEqual(["a", "b"]);
  });
});
