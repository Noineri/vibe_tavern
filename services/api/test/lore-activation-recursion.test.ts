import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries, type ActivationInput } from "../src/domain/prompt/lore-activation-engine.js";

/**
 * Recursion-path tests for the lore activation engine.
 *
 * The engine runs a normal scan pass, then iterates recursion passes that
 * re-match keys against a buffer built from the *content* of entries activated
 * so far (lore-activation-engine.ts:196–305). Four entry-level flags gate that
 * second phase, and until this file they had no behavioral coverage:
 *
 * - `recursiveScanning` (lorebook-level) — enables the recursion phase at all
 * - `preventRecursion` (entry) — the entry's content is withheld from the buffer
 * - `excludeRecursion` (entry) — the entry is skipped on recursion passes only
 * - `delayUntilRecursion` + `recursionLevel` (entry) — deferred to a later pass
 * - `maxRecursionSteps` (lorebook-level) — hard cap on recursion pass count
 *
 * Ports scenarios 3 (recursion) and 4 (recursion-blocker) from the hand-written
 * stress-test lorebook in data/lorebooks/, plus the three flag variants the
 * stress-test did not exercise. Inline factories mirror lore-activation-reasons.test.ts;
 * no shared fixtures (per docs/architecture/testing.md).
 *
 * Assertions are set-membership, not ordered: final output is sorted by priority
 * (both entries here share the default priority 100), and ordering is exercised
 * separately in the sorting tests. These tests are about the recursion mechanism.
 */

// ─── inline factories (per-file, not shared — see docs/architecture/testing.md) ─

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
    delayWindow: 0,
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

/** Build an ActivationInput with a single lorebook; lorebook-level flags overridable. */
function makeInput(
  entries: ReturnType<typeof makeEntry>[],
  lorebookOverrides: Record<string, unknown> = {},
  inputOverrides: Partial<ActivationInput> = {},
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
        ...lorebookOverrides,
      },
    ],
    messages: [],
    macroMap: {},
    characterId: "c_test",
    characterName: "Test",
    activationState: {},
    currentTurn: 1,
    ...inputOverrides,
  };
}

function activated(result: ReturnType<typeof resolveActivatedEntries>, id: string) {
  return result.activatedEntries.find((e) => e.id === id);
}

/** Assert exactly the given set of ids activated, order-independent. */
function expectActivated(result: ReturnType<typeof resolveActivatedEntries>, ids: string[]) {
  const got = result.activatedEntries.map((e) => e.id).sort();
  expect(got).toEqual([...ids].sort());
}

const RECURSION_LB = { recursiveScanning: true, maxRecursionSteps: 5 };

// ─── LG-5 characterization: recursion × inclusion groups ─────────────────────
// Characterization-first (LG-5): the first two tests were pinned against the
// pre-rework engine (loser-seeds-recursion, cross-level re-resolution), then
// flipped to the ST per-pass semantics; the comma-lock pair pins ST's raw-string
// lock quirk.

describe("lore activation — recursion × inclusion groups (LG-5 characterization)", () => {
  it("LG-5: a group-scoring loser is removed BEFORE its content can seed recursion (D7a)", () => {
    // loud_loser (score 1) loses the scoring filter to quiet_winner (score 2)
    // in the SAME pass. Its content contains omega_key — under ST's per-pass
    // filter the loser never reaches the recursion buffer, so recursive_target
    // must NOT fire. (Characterization pin of the pre-LG5 engine had
    // recursive_target PRESENT.)
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("loud_loser", {
            keys: ["alpha"], content: "mention omega_key here",
            groupName: "g", groupWeight: 100, useGroupScoring: true,
          }),
          makeEntry("quiet_winner", {
            keys: ["alpha", "alphabet"], content: "quiet",
            groupName: "g", groupWeight: 100, useGroupScoring: true,
          }),
          makeEntry("recursive_target", { keys: ["omega_key"] }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "alpha alphabet" }] },
      ),
    );
    expectActivated(result, ["quiet_winner"]);
  });

  it("LG-5: an earlier-pass winner locks its group — a later override entry is silently removed (D7b)", () => {
    // l0 wins group g at level 0 (sole member, no roll — group unresolved but
    // l0 is locked in). At level 1 the seeder's content activates l1_override
    // (prioritizeInclusion, higher priority). ST's lock check rejects new
    // competitors of an already-activated group before the override stage,
    // so the earlier winner stays. (Characterization pin of the pre-LG5
    // engine had the latecomer override winning the group.)
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("l0", { keys: ["alpha"], content: "l0 text", groupName: "g", groupWeight: 100 }),
          makeEntry("seeder", { keys: ["alpha"], content: "golf_delta" }),
          makeEntry("l1_override", {
            keys: ["golf_delta"], content: "l1 text",
            groupName: "g", groupWeight: 100, prioritizeInclusion: true, priority: 200,
          }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "alpha" }] },
      ),
    );
    expectActivated(result, ["seeder", "l0"]);
  });

  it("LG-5: lock matching is raw-string — a comma-group winner does NOT lock its component groups (ST quirk)", () => {
    // The winner's group field is "g1,g2". ST's lock check compares the RAW
    // string against each group key (`x.group === key`), so neither "g1" nor
    // "g2" is considered already-activated: the late "g1" competitor arrives
    // as a lone candidate, is skipped by the ≤1 guard, and survives.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("w", { keys: ["alpha"], content: "w text", groupName: "g1,g2", groupWeight: 100 }),
          makeEntry("seeder", { keys: ["alpha"], content: "golf_delta" }),
          makeEntry("late", { keys: ["golf_delta"], content: "late text", groupName: "g1", groupWeight: 100 }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "alpha" }] },
      ),
    );
    expectActivated(result, ["seeder", "w", "late"]);
  });

  it("LG-5: a single-group winner DOES lock its group — the late competitor is silently removed", () => {
    // Mirror of the comma quirk: the winner's group field is exactly "g1", so
    // the lock fires and the late "g1" competitor never survives to roll.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("w", { keys: ["alpha"], content: "w text", groupName: "g1", groupWeight: 100 }),
          makeEntry("seeder", { keys: ["alpha"], content: "golf_delta" }),
          makeEntry("late", { keys: ["golf_delta"], content: "late text", groupName: "g1", groupWeight: 100 }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "alpha" }] },
      ),
    );
    expectActivated(result, ["seeder", "w"]);
  });
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe("lore activation — recursion", () => {
  // ── TEST 3 (ported): an entry activates via another entry's content ──────

  it("activates a second entry whose key appears only in a first entry's content (recursive scan)", () => {
    // Ported from stress-test lorebook: trigger contains the target's key in
    // its content, so the target can only match during a recursion pass.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("trigger", { keys: ["test_recursion_trigger"], content: "this unlocks test_recursive_target" }),
          makeEntry("target", { keys: ["test_recursive_target"] }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "test_recursion_trigger" }] },
      ),
    );

    expectActivated(result, ["trigger", "target"]);
    // The recursion-pass activation must be tagged so the prompt trace can
    // distinguish it from a normal-scan match.
    expect(activated(result, "target")?.reason).toMatchObject({ kind: "key_match", scanState: "recursion" });
  });

  it("does NOT recurse when recursiveScanning is disabled on the lorebook", () => {
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("trigger", { keys: ["gate"], content: "opens the vault" }),
          makeEntry("vault", { keys: ["vault"] }),
        ],
        { recursiveScanning: false }, // recursion phase never runs
        { messages: [{ role: "user", content: "gate" }] },
      ),
    );

    expectActivated(result, ["trigger"]);
  });

  // ── TEST 4 (ported): preventRecursion withholds the entry's content ──────

  it("does not propagate an entry's content to the recursion buffer when preventRecursion is set", () => {
    // Ported from stress-test lorebook: the blocker matches and injects its
    // text, but preventRecursion stops its content from seeding further matches.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("blocker", { keys: ["test_recursion_blocker"], content: "mentions test_blocked_target", preventRecursion: true }),
          makeEntry("blocked", { keys: ["test_blocked_target"] }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "test_recursion_blocker" }] },
      ),
    );

    // blocker activated normally, blocked must NOT — its key only exists in
    // blocker's content, which was withheld from the buffer.
    expectActivated(result, ["blocker"]);
    expect(activated(result, "blocked")).toBeUndefined();
  });

  it("still injects a preventRecursion entry's content into the final prompt (only the buffer is affected)", () => {
    // preventRecursion is about seeding further recursion, not hiding the
    // entry. The entry itself still lands in the activated output.
    const result = resolveActivatedEntries(
      makeInput(
        [makeEntry("blocker", { keys: ["k"], content: "visible payload", preventRecursion: true })],
        RECURSION_LB,
        { messages: [{ role: "user", content: "k" }] },
      ),
    );

    expect(activated(result, "blocker")).toBeDefined();
    expect(activated(result, "blocker")?.content).toBe("visible payload");
  });

  // ── excludeRecursion: the entry is skipped on recursion passes only ──────

  it("skips an excludeRecursion entry on the recursion pass even when its key is present in another entry's content", () => {
    // "deep" only appears in anchor's content, so it can only match during
    // recursion — and excludeRecursion rules it out precisely there.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("anchor", { keys: ["gate"], content: "the deep vault" }),
          makeEntry("deep", { keys: ["deep"], excludeRecursion: true }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "gate" }] },
      ),
    );

    expectActivated(result, ["anchor"]);
    expect(activated(result, "deep")).toBeUndefined();
  });

  it("still activates an excludeRecursion entry when its key matches on the normal scan", () => {
    // excludeRecursion only filters recursion passes; a direct match in chat
    // history must still activate the entry.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("anchor", { keys: ["gate"], content: "the deep vault" }),
          makeEntry("deep", { keys: ["deep"], excludeRecursion: true }),
        ],
        RECURSION_LB,
        // "deep" is present in chat history directly → normal-scan match wins.
        { messages: [{ role: "user", content: "gate and deep" }] },
      ),
    );

    expectActivated(result, ["anchor", "deep"]);
    expect(activated(result, "deep")?.reason).toMatchObject({ kind: "key_match", scanState: "normal" });
  });

  // ── maxRecursionSteps: hard cap on the number of recursion passes ────────

  it("cuts a multi-hop chain once maxRecursionSteps is exceeded", () => {
    // A→B→C→D chain: each entry's content contains the next entry's key.
    // With maxRecursionSteps: 2 there are two recursion passes, so A (normal)
    // and B, C (recursion passes 1 and 2) activate, but D never gets a chance.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("a", { keys: ["ka"], content: "kb" }),
          makeEntry("b", { keys: ["kb"], content: "kc" }),
          makeEntry("c", { keys: ["kc"], content: "kd" }),
          makeEntry("d", { keys: ["kd"] }),
        ],
        { recursiveScanning: true, maxRecursionSteps: 2 },
        { messages: [{ role: "user", content: "ka" }] },
      ),
    );

    expectActivated(result, ["a", "b", "c"]);
    expect(activated(result, "d")).toBeUndefined();
  });

  // ── delayUntilRecursion: defers activation to a recursion pass ───────────

  it("defers a delayUntilRecursion entry: skipped on normal scan, activated on a recursion pass", () => {
    // "delayed" would match on the normal scan (its key is seeded by anchor),
    // but delayUntilRecursion forces it to wait for a recursion pass. anchor
    // seeds the buffer; delayed then activates once recursion begins.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("anchor", { keys: ["gate"], content: "emits deepsignal" }),
          makeEntry("delayed", { keys: ["deepsignal"], delayUntilRecursion: true, recursionLevel: 1 }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "gate" }] },
      ),
    );

    expectActivated(result, ["anchor", "delayed"]);
    // Confirms it activated during recursion, not on the normal pass where it
    // was deliberately deferred.
    expect(activated(result, "delayed")?.reason).toMatchObject({ kind: "key_match", scanState: "recursion" });
  });

  it("does not activate a delayUntilRecursion entry at all when recursion never produces its key", () => {
    // delayed's key never enters the buffer (no other entry mentions it), so
    // even though it would be eligible on a recursion pass, nothing matches.
    const result = resolveActivatedEntries(
      makeInput(
        [
          makeEntry("anchor", { keys: ["gate"], content: "unrelated text" }),
          makeEntry("delayed", { keys: ["deepsignal"], delayUntilRecursion: true }),
        ],
        RECURSION_LB,
        { messages: [{ role: "user", content: "gate" }] },
      ),
    );

    expectActivated(result, ["anchor"]);
    expect(activated(result, "delayed")).toBeUndefined();
  });
});
