import { describe, expect, it } from "bun:test";
import {
  DICE_MAX_DICE_COUNT,
  DICE_MAX_MODIFIER,
  DiceNotationError,
  parseDiceNotation,
  rollDice,
  validateRollArithmetic,
  faceShapeForSides,
  toPromptFormatterInput,
  type RandomSource,
} from "../src/dice.js";

/**
 * Characterization of the pure Dice kernel (DICE_SYSTEM_BACKEND_PLAN B1).
 *
 * Pinned here so the bounded notation + roller + arithmetic validator keep
 * their server-authoritative contract while later waves (VM, roll service,
 * prompt projection) compose them. The bounds, the closed face-shape set, and
 * the per-face arithmetic guard are the load-bearing invariants: a drift here
 * would let fabricated/out-of-range faces or wrong totals through to the DB.
 */

// --- deterministic RNG ------------------------------------------------------

/** A scripted RNG that returns fixed face values (pre-shift: 0-based). */
class FixedRng implements RandomSource {
  constructor(private readonly values: number[]) {}
  private i = 0;
  intBelow(_maxExclusive: number): number {
    const v = this.values[this.i % this.values.length];
    this.i += 1;
    return v;
  }
}

/** Linear-congruential RNG seeded for stable pseudo-random rolls in tests. */
class SeededRng implements RandomSource {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  intBelow(maxExclusive: number): number {
    // Numerical Recipes constants; good enough distribution for test rolls.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state % maxExclusive;
  }
}

// --- parseDiceNotation ------------------------------------------------------

describe("parseDiceNotation", () => {
  it("parses NdS+M fully", () => {
    const n = parseDiceNotation("3d6+2");
    expect(n).toMatchObject({ count: 3, sides: 6, modifier: 2, faceShape: "d6" });
  });

  it("parses NdS-M (negative modifier)", () => {
    const n = parseDiceNotation("2d20-1");
    expect(n).toMatchObject({ count: 2, sides: 20, modifier: -1, faceShape: "d20" });
  });

  it("defaults count to 1 and modifier to 0 when omitted", () => {
    const n = parseDiceNotation("d8");
    expect(n.count).toBe(1);
    expect(n.modifier).toBe(0);
    expect(n.faceShape).toBe("d8");
  });

  it("parses the d% percentile token (sides 100, faceShape d%)", () => {
    const n = parseDiceNotation("d%");
    expect(n.sides).toBe(100);
    expect(n.faceShape).toBe("d%");
    expect(n.count).toBe(1);
  });

  it("parses Nd% (multiple percentile dice)", () => {
    const n = parseDiceNotation("2d%");
    expect(n.count).toBe(2);
    expect(n.sides).toBe(100);
    expect(n.faceShape).toBe("d%");
  });

  it("treats d100 as an alias that normalizes to d%", () => {
    const n = parseDiceNotation("d100");
    expect(n.sides).toBe(100);
    expect(n.faceShape).toBe("d%");
  });

  it("accepts every face-shape in the closed set", () => {
    for (const [sides, shape] of [
      [4, "d4"], [6, "d6"], [8, "d8"], [10, "d10"], [12, "d12"], [20, "d20"], [100, "d%"],
    ] as const) {
      const n = parseDiceNotation(`d${sides}`);
      expect(n.faceShape).toBe(shape);
    }
  });

  it("tolerates surrounding whitespace", () => {
    const n = parseDiceNotation("  d6+1  ");
    expect(n.count).toBe(1);
    expect(n.modifier).toBe(1);
  });

  it("produces a canonical normalized notation string", () => {
    expect(parseDiceNotation("d6").notation).toBe("d6");
    expect(parseDiceNotation("3d6+2").notation).toBe("3d6+2");
    expect(parseDiceNotation("d100").notation).toBe("d%");
    expect(parseDiceNotation("2d20-1").notation).toBe("2d20-1");
  });

  // ── rejections ──────────────────────────────────────────────────────────
  it("rejects an empty notation", () => {
    expect(() => parseDiceNotation("")).toThrow(DiceNotationError);
  });

  it("rejects an unsupported side count (d7, d3, d1000)", () => {
    expect(() => parseDiceNotation("d7")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("d3")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("d1000")).toThrow(DiceNotationError);
  });

  it("rejects a dice count below 1 (0d6)", () => {
    expect(() => parseDiceNotation("0d6")).toThrow(DiceNotationError);
  });

  it("rejects a dice count above the bound", () => {
    expect(() => parseDiceNotation(`${DICE_MAX_DICE_COUNT + 1}d6`)).toThrow(DiceNotationError);
  });

  it("accepts the maximum dice count", () => {
    const n = parseDiceNotation(`${DICE_MAX_DICE_COUNT}d6`);
    expect(n.count).toBe(DICE_MAX_DICE_COUNT);
  });

  it("rejects a modifier above the bound", () => {
    expect(() => parseDiceNotation(`d6+${DICE_MAX_MODIFIER + 1}`)).toThrow(DiceNotationError);
    expect(() => parseDiceNotation(`d6-${DICE_MAX_MODIFIER + 1}`)).toThrow(DiceNotationError);
  });

  it("rejects a bare sign without digits (+/- alone)", () => {
    expect(() => parseDiceNotation("d6+")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("d6-")).toThrow(DiceNotationError);
  });

  it("rejects garbage / unknown shapes", () => {
    expect(() => parseDiceNotation("roll 3d6")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("3d6+2+1")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("d")).toThrow(DiceNotationError);
    expect(() => parseDiceNotation("hello")).toThrow(DiceNotationError);
  });

  it("rejects a non-string input", () => {
    expect(() => parseDiceNotation(123 as unknown as string)).toThrow(DiceNotationError);
  });
});

// --- rollDice ───────────────────────────────────────────────────────────────

describe("rollDice", () => {
  it("produces exactly count faces, each in [1..sides]", () => {
    const n = parseDiceNotation("4d6");
    const result = rollDice(n, new SeededRng(42));
    expect(result.faces.length).toBe(4);
    for (const face of result.faces) {
      expect(face).toBeGreaterThanOrEqual(1);
      expect(face).toBeLessThanOrEqual(6);
    }
  });

  it("computes subtotal as the sum of faces and total as subtotal + modifier", () => {
    const n = parseDiceNotation("3d6+2");
    const result = rollDice(n, new FixedRng([2, 4, 5])); // 0-based → faces 3,5,6
    // FixedRng returns 0-based values; roller shifts +1 → faces [3,5,6].
    expect(result.faces).toEqual([3, 5, 6]);
    expect(result.subtotal).toBe(14);
    expect(result.total).toBe(16);
  });

  it("is deterministic given a deterministic source", () => {
    const n = parseDiceNotation("2d20-1");
    const a = rollDice(n, new FixedRng([0, 19]));
    const b = rollDice(n, new FixedRng([0, 19]));
    expect(a).toEqual(b);
    // 0-based 0,19 → faces 1,20 → subtotal 21 - 1 = 20.
    expect(a.faces).toEqual([1, 20]);
    expect(a.total).toBe(20);
  });

  it("rolls d% faces in [1..100] with the d% faceShape", () => {
    const n = parseDiceNotation("d%");
    const result = rollDice(n, new FixedRng([57]));
    expect(result.faces).toEqual([58]);
    expect(result.faceShape).toBe("d%");
    expect(result.subtotal).toBe(58);
  });

  it("carries the canonical notation through the result", () => {
    const result = rollDice(parseDiceNotation("d100"), new FixedRng([0]));
    expect(result.notation).toBe("d%");
  });
});

// --- validateRollArithmetic (server-authoritative guard) ─────────────────────

describe("validateRollArithmetic", () => {
  const ok = {
    sides: 6,
    modifier: 2,
    faces: [3, 5, 6] as const,
    subtotal: 14,
    total: 16,
  };

  it("accepts a consistent tuple", () => {
    expect(validateRollArithmetic(ok)).toBeNull();
  });

  it("accepts a zero-modifier roll", () => {
    expect(
      validateRollArithmetic({ sides: 20, modifier: 0, faces: [10], subtotal: 10, total: 10 }),
    ).toBeNull();
  });

  it("rejects a face above sides", () => {
    expect(
      validateRollArithmetic({ sides: 6, modifier: 0, faces: [7], subtotal: 7, total: 7 }),
    ).not.toBeNull();
  });

  it("rejects a face below 1 (zero)", () => {
    expect(
      validateRollArithmetic({ sides: 6, modifier: 0, faces: [0, 3], subtotal: 3, total: 3 }),
    ).not.toBeNull();
  });

  it("rejects a non-integer face", () => {
    expect(
      validateRollArithmetic({ sides: 6, modifier: 0, faces: [3.5], subtotal: 3.5, total: 3.5 }),
    ).not.toBeNull();
  });

  it("rejects a subtotal that does not equal sum(faces)", () => {
    // faces sum to 14 but subtotal claims 16.
    expect(
      validateRollArithmetic({ sides: 6, modifier: 2, faces: [3, 5, 6], subtotal: 16, total: 18 }),
    ).not.toBeNull();
  });

  it("rejects a total that does not equal subtotal + modifier", () => {
    // subtotal 14 + modifier 2 = 16, but total claims 18.
    expect(
      validateRollArithmetic({ sides: 6, modifier: 2, faces: [3, 5, 6], subtotal: 14, total: 18 }),
    ).not.toBeNull();
  });

  it("rejects a face count above the bound", () => {
    const faces = new Array(DICE_MAX_DICE_COUNT + 1).fill(1);
    expect(
      validateRollArithmetic({
        sides: 6,
        modifier: 0,
        faces,
        subtotal: faces.length,
        total: faces.length,
      }),
    ).not.toBeNull();
  });

  it("rejects an empty face array", () => {
    expect(
      validateRollArithmetic({ sides: 6, modifier: 0, faces: [], subtotal: 0, total: 0 }),
    ).not.toBeNull();
  });
});

// --- faceShapeForSides / projection helpers ─────────────────────────────────

describe("faceShapeForSides", () => {
  it("returns the shape for a known side count", () => {
    expect(faceShapeForSides(20)).toBe("d20");
    expect(faceShapeForSides(100)).toBe("d%");
  });

  it("returns null for an unknown side count", () => {
    expect(faceShapeForSides(7)).toBeNull();
    expect(faceShapeForSides(1000)).toBeNull();
  });
});

describe("toPromptFormatterInput", () => {
  it("projects a roll result into the formatter input shape", () => {
    const roll = rollDice(parseDiceNotation("3d6+2"), new FixedRng([2, 4, 5]));
    const projected = toPromptFormatterInput(roll, {
      attemptId: "att_1",
      actorLabel: "Aria",
      checkLabel: "Attack",
    });
    expect(projected.actorLabel).toBe("Aria");
    expect(projected.checkLabel).toBe("Attack");
    expect(projected.notation).toBe("3d6+2");
    expect(projected.faceShape).toBe("d6");
    expect(projected.attempts.length).toBe(1);
    expect(projected.attempts[0].attemptId).toBe("att_1");
    expect(projected.attempts[0].faces).toEqual([3, 5, 6]);
    expect(projected.attempts[0].total).toBe(16);
  });
});
