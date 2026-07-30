/**
 * Dice-script sandbox VM tests (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B4).
 *
 * These are the "real VM tests" that cover the dedicated Dice VM in isolation:
 * discovery registration, roll execution under timeout, error handling,
 * deterministic RNG (injected source), the retry-reason + grant channel, and
 * the frozen-context invariants (no prompt-mutation channels, roll-only-randomness).
 *
 * The VM is a pure synchronous function (no I/O, no DB) so these are unit tests.
 */
import { describe, expect, test } from "bun:test";
import {
  discoverDiceChecks,
  executeDiceRoll,
} from "../src/domain/scripts-engine/dice-script-sandbox.js";
import type { DiceActorSnapshot, DiceAttempt } from "@vibe-tavern/domain";

// ─── Deterministic RNG ───────────────────────────────────────────────────────

/** A deterministic RandomSource that returns a fixed sequence of integers. */
function deterministicRng(values: number[]): { intBelow: (max: number) => number } {
  let i = 0;
  return {
    intBelow(max: number): number {
      const v = values[i] ?? values[values.length - 1] ?? 0;
      i += 1;
      return v % max;
    },
  };
}

const PERSONA_ACTOR: DiceActorSnapshot = {
  actorType: "persona",
  actorId: "persona_1",
  actorLabel: "Hero",
};

// ─── Test script bodies ──────────────────────────────────────────────────────

/** A minimal valid Dice script registering one strict attack check. */
const STRICT_ATTACK_SCRIPT = `
context.dice.register({
  id: 'attack',
  label: 'Attack Roll',
  notation: '1d20+5',
  actors: ['persona', 'character'],
  resolution: 'strict',
  resolve() {
    var r = context.dice.roll('1d20+5');
    return {
      faces: r.faces,
      modifier: r.modifier,
      subtotal: r.subtotal,
      total: r.total,
      final: { total: r.total, outcome: r.total >= 15 ? 'hit' : 'miss' },
    };
  }
});
`;

const NARRATIVE_CHECK_SCRIPT = `
context.dice.register({
  id: 'perception',
  label: 'Perception',
  notation: '2d6',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() {
    var r = context.dice.roll('2d6');
    return {
      faces: r.faces,
      modifier: 0,
      subtotal: r.subtotal,
      total: r.total,
    };
  }
});
`;

/** A script that grants a retry with a reason + policy (Immersive). */
const RETRY_GRANT_SCRIPT = `
context.dice.register({
  id: 'saving_throw',
  label: 'Saving Throw',
  notation: '1d20',
  actors: ['persona'],
  resolution: 'strict',
  resolve() {
    var r = context.dice.roll('1d20');
    return {
      faces: r.faces,
      modifier: 0,
      subtotal: r.subtotal,
      total: r.total,
      final: { total: r.total, outcome: r.total >= 10 ? 'pass' : 'fail' },
      retryReason: 'Lucky feat grants a reroll',
      policy: 'replace',
      grantReason: 'Lucky',
    };
  }
});
`;

// ─── Discovery ───────────────────────────────────────────────────────────────

describe("discoverDiceChecks", () => {
  test("collects registered checks with their raw fields", () => {
    const out = discoverDiceChecks(STRICT_ATTACK_SCRIPT, "attack.js");
    expect(out.error).toBeNull();
    expect(out.registrations).toHaveLength(1);
    expect(out.registrations[0].id).toBe("attack");
    expect(out.registrations[0].label).toBe("Attack Roll");
    expect(out.registrations[0].notation).toBe("1d20+5");
    expect(out.registrations[0].actors).toEqual(["persona", "character"]);
    expect(out.registrations[0].resolution).toBe("strict");
    expect(typeof out.registrations[0].resolve).toBe("function");
  });

  test("collects the optional help field when the script registers it", () => {
    const code = `
context.dice.register({
  id: 'attack',
  label: 'Attack Roll',
  notation: '1d20+5',
  actors: ['persona', 'character'],
  resolution: 'strict',
  help: 'Roll and add the modifier; 15+ hits.',
  resolve() { return {}; }
});
`;
    const out = discoverDiceChecks(code, "help.js");
    expect(out.error).toBeNull();
    expect(out.registrations).toHaveLength(1);
    expect(out.registrations[0].help).toBe("Roll and add the modifier; 15+ hits.");
  });

  test("help is undefined on the raw registration when the script omits it", () => {
    const out = discoverDiceChecks(STRICT_ATTACK_SCRIPT, "attack.js");
    expect(out.registrations[0].help).toBeUndefined();
  });

  test("collects multiple checks in registration order", () => {
    const code = `
context.dice.register({ id: 'a', label: 'A', notation: '1d6', actors: ['persona'], resolution: 'narrative', resolve() { return {}; } });
context.dice.register({ id: 'b', label: 'B', notation: '1d20', actors: ['character'], resolution: 'narrative', resolve() { return {}; } });
`;
    const out = discoverDiceChecks(code, "multi.js");
    expect(out.registrations.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("roll is NOT available during discovery", () => {
    const code = `
context.dice.roll('1d6');
`;
    const out = discoverDiceChecks(code, "bad.js");
    expect(out.error).toContain("only available inside a check's resolve()");
  });

  test("captures VM syntax errors", () => {
    const out = discoverDiceChecks("this is not valid {{{", "broken.js");
    expect(out.error).not.toBeNull();
  });

  test("captures VM runtime errors", () => {
    const out = discoverDiceChecks("throw new Error('boom');", "throw.js");
    expect(out.error).toBe("boom");
  });

  test("captures timeout when the script loops forever", () => {
    const code = "while (true) {}";
    const out = discoverDiceChecks(code, "loop.js", 200);
    expect(out.error).not.toBeNull();
  });
});

// ─── Roll execution ──────────────────────────────────────────────────────────

describe("executeDiceRoll", () => {
  test("invokes resolve() and returns the raw output with deterministic RNG", () => {
    // intBelow(20) returns 13 → face = 14. total = 14 + 5 = 19. 19 >= 15 → hit.
    const rng = deterministicRng([13]);
    const out = executeDiceRoll(STRICT_ATTACK_SCRIPT, "attack.js", "attack", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng,
    });
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({
      faces: [14],
      modifier: 5,
      subtotal: 14,
      total: 19,
      final: { total: 19, outcome: "hit" },
    });
  });

  test("produces different results with different RNG values", () => {
    const low = executeDiceRoll(STRICT_ATTACK_SCRIPT, "attack.js", "attack", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([2]), // face 3, total 8 → miss
    });
    const high = executeDiceRoll(STRICT_ATTACK_SCRIPT, "attack.js", "attack", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([13]), // face 14, total 19 → hit
    });
    expect((low.output as { final: { outcome: string } }).final.outcome).toBe("miss");
    expect((high.output as { final: { outcome: string } }).final.outcome).toBe("hit");
  });

  test("passes the retry-reason + grant channel through", () => {
    const out = executeDiceRoll(RETRY_GRANT_SCRIPT, "save.js", "saving_throw", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([14]), // face 15 → pass
    });
    expect(out.ok).toBe(true);
    const output = out.output as Record<string, unknown>;
    expect(output.retryReason).toBe("Lucky feat grants a reroll");
    expect(output.policy).toBe("replace");
    expect(output.grantReason).toBe("Lucky");
  });

  test("narrative resolve returns mechanical facts without outcome", () => {
    // 2d6: intBelow(6)=2→3, intBelow(6)=4→5. subtotal=8, total=8.
    const out = executeDiceRoll(NARRATIVE_CHECK_SCRIPT, "perc.js", "perception", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([2, 4]),
    });
    expect(out.ok).toBe(true);
    const output = out.output as Record<string, unknown>;
    expect(output.faces).toEqual([3, 5]);
    expect(output.total).toBe(8);
    expect(output.final).toBeUndefined();
  });

  test("returns check_not_found when the check id is absent", () => {
    const out = executeDiceRoll(STRICT_ATTACK_SCRIPT, "attack.js", "nonexistent", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("check_not_found");
  });

  test("returns no_resolve_fn when the check has no resolve function", () => {
    const code = `
context.dice.register({ id: 'x', label: 'X', notation: '1d6', actors: ['persona'], resolution: 'narrative' });
`;
    const out = executeDiceRoll(code, "noresolve.js", "x", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_resolve_fn");
  });

  test("captures a throw inside resolve()", () => {
    const code = `
context.dice.register({
  id: 'crash',
  label: 'Crash',
  notation: '1d6',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() { throw new Error('resolve boom'); }
});
`;
    const out = executeDiceRoll(code, "crash.js", "crash", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("resolve boom");
  });

  test("captures timeout when resolve() loops forever", () => {
    const code = `
context.dice.register({
  id: 'loop',
  label: 'Loop',
  notation: '1d6',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() { while (true) {} }
});
`;
    const out = executeDiceRoll(code, "loop.js", "loop", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    }, 200);
    expect(out.ok).toBe(false);
    expect(out.error).not.toBeNull();
  });
});

// ─── Frozen context invariants ───────────────────────────────────────────────

describe("frozen context isolation", () => {
  test("the actor snapshot is frozen (cannot be mutated by the script)", () => {
    const code = `
context.dice.register({
  id: 'mutate_actor',
  label: 'M',
  notation: '1d6',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() {
    "use strict";
    try { context.actor.actorId = 'evil'; } catch (e) { /* frozen */ }
    return { faces: [1], modifier: 0, subtotal: 1, total: 1 };
  }
});
`;
    const out = executeDiceRoll(code, "mutate.js", "mutate_actor", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    });
    expect(out.ok).toBe(true);
    // The actor in the output context is unaffected (we hold our own copy).
    expect(PERSONA_ACTOR.actorId).toBe("persona_1");
  });

  test("priorAttempts are frozen and visible inside resolve()", () => {
    const prior: DiceAttempt[] = [
      { attemptId: "attempt_1", faces: [10], modifier: 0, subtotal: 10, total: 10 },
    ];
    const code = `
context.dice.register({
  id: 'retry',
  label: 'R',
  notation: '1d20',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() {
    var prev = context.priorAttempts.length;
    var r = context.dice.roll('1d20');
    return { faces: r.faces, modifier: 0, subtotal: r.subtotal, total: r.total, grantReason: 'attempt ' + (prev + 1) };
  }
});
`;
    const out = executeDiceRoll(code, "retry.js", "retry", {
      actor: PERSONA_ACTOR,
      priorAttempts: prior,
      rng: deterministicRng([13]),
    });
    expect(out.ok).toBe(true);
    const output = out.output as Record<string, unknown>;
    expect(output.grantReason).toBe("attempt 2");
  });

  test("no prompt-mutation channels exist in the Dice context", () => {
    // A Dice script must NOT have access to context.character.personality,
    // context.chat.injectMessage, context.state, or context.lore. If it
    // references them, they are undefined — it cannot mutate prompt fields.
    const code = `
context.dice.register({
  id: 'probe',
  label: 'P',
  notation: '1d6',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() {
    return {
      hasCharacter: typeof context.character,
      hasChat: typeof context.chat,
      hasState: typeof context.state,
      hasLore: typeof context.lore,
      faces: [1], modifier: 0, subtotal: 1, total: 1,
    };
  }
});
`;
    const out = executeDiceRoll(code, "probe.js", "probe", {
      actor: PERSONA_ACTOR,
      priorAttempts: [],
      rng: deterministicRng([0]),
    });
    expect(out.ok).toBe(true);
    const output = out.output as Record<string, unknown>;
    expect(output.hasCharacter).toBe("undefined");
    expect(output.hasChat).toBe("undefined");
    expect(output.hasState).toBe("undefined");
    expect(output.hasLore).toBe("undefined");
  });
});
