/**
 * Pure Dice notation + roller kernel (DICE_SYSTEM_BACKEND_PLAN, Wave B1).
 *
 * This module is the server-authoritative core: notation parsing, bounded
 * limits, the per-face roller, and the arithmetic validators that every roll
 * result must satisfy before persistence. It is PURE — no I/O, no `node:crypto`,
 * no provider/assembly coupling. Production randomness comes from a
 * {@link RandomSource} injected by the server layer; tests inject deterministic
 * values. Advanced mechanics (advantage, keep-high/low, exploding dice, pools,
 * system-specific rules) are implemented by the Dice script through repeated
 * bounded {@link rollDice} calls and a validated result envelope, never by
 * growing this notation grammar.
 *
 * Dependency direction: imports only platform-constants (the enum literals).
 * The entity-level envelope types (DiceRollSnapshot / DiceAttempt / …) live in
 * `entities.ts`; this module deliberately owns just the bounded primitive
 * (notation + per-face result + arithmetic guard) so the Dice VM (Wave B2) and
 * the roll service (Wave B3) can compose it without pulling in entity baggage.
 */

import { DICE_FACE_SHAPE, type DiceFaceShape } from "./platform-constants.js";

// ─── Bounds ───────────────────────────────────────────────────────────────────
//
// Centralized limits enforced everywhere a notation is parsed and everywhere a
// result envelope is validated. The face-shape set is closed (d4/d6/d8/d10/d12/
// d20/d%), so `sides` is one of those seven values — no arbitrary polyhedrals.

/** Largest accepted dice count in one notation (`NdS`). */
export const DICE_MAX_DICE_COUNT = 32;
/** Smallest accepted dice count (a roll always produces at least one face). */
export const DICE_MIN_DICE_COUNT = 1;
/** Largest accepted |modifier| (`+/-M`). Generous; bounded to forbid abuse. */
export const DICE_MAX_MODIFIER = 1000;
/** Largest accepted face value (= the percentile's 100). */
export const DICE_MAX_SIDES = 100;

/**
 * The closed set of side counts the bounded notation accepts, mapped to their
 * face-shape hint. `d%` is the percentile (sides 100); writing `d100` is an
 * accepted alias that normalizes to `d%`.
 */
const SIDES_TO_FACE_SHAPE: ReadonlyMap<number, DiceFaceShape> = new Map([
  [4, DICE_FACE_SHAPE.d4],
  [6, DICE_FACE_SHAPE.d6],
  [8, DICE_FACE_SHAPE.d8],
  [10, DICE_FACE_SHAPE.d10],
  [12, DICE_FACE_SHAPE.d12],
  [20, DICE_FACE_SHAPE.d20],
  [100, DICE_FACE_SHAPE.dPercent],
]);

// ─── RandomSource ─────────────────────────────────────────────────────────────

/**
 * Source of randomness injected into {@link rollDice}. Production injects a
 * cryptographic source (server layer); tests inject a deterministic one. The
 * roller only ever asks for a uniform integer in `[0, maxExclusive)` — one call
 * per face — so a deterministic source fully pins a roll for tests.
 */
export interface RandomSource {
  /** Returns a uniformly distributed integer in `[0, maxExclusive)`. */
  intBelow(maxExclusive: number): number;
}

// ─── Notation ─────────────────────────────────────────────────────────────────

/** A parsed, validated dice notation. */
export interface DiceNotation {
  /** Canonical normalized notation string, e.g. `"3d6+2"`, `"d20"`, `"2d%"`. */
  notation: string;
  /** Number of dice rolled (`N`). */
  count: number;
  /** Sides per die (`S`): 4, 6, 8, 10, 12, 20, or 100 (percentile). */
  sides: number;
  /** Signed modifier (`+/-M`); `0` when absent. */
  modifier: number;
  /** Visualization hint derived from `sides`. */
  faceShape: DiceFaceShape;
}

/**
 * Error thrown by {@link parseDiceNotation} for any malformed or out-of-bounds
 * notation. Carries a stable message so callers (API layer, Zod refinement) can
 * surface a consistent validation error.
 */
export class DiceNotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiceNotationError";
  }
}

// Matches `[N]dS[+/-M]`, `d%`, `Nd%`, with optional surrounding whitespace.
//   - `N` (count) is optional, defaulting to 1.
//   - `S` is standard numeric sides, OR the literal `%` (percentile).
//   - `M` (modifier) is optional, signed; bare `+`/`-` without digits rejected.
const NOTATION_RE = /^\s*(\d+)?d(%|\d+)\s*([+-]\d+)?\s*$/i;

/**
 * Parse a bounded dice notation into a validated {@link DiceNotation}.
 *
 * Accepts `[N]dS[+/-M]` and `d%` (percentile; `d100` is an alias that
 * normalizes to `d%`). Rejects everything else: unknown shapes, out-of-range
 * count/modifier, bare signs, trailing tokens. Throws {@link DiceNotationError}
 * on any malformed input — never returns a partial/guessed result.
 *
 * @example parseDiceNotation("3d6+2")  → { count:3, sides:6, modifier:2, faceShape:"d6" }
 * @example parseDiceNotation("d%")     → { count:1, sides:100, modifier:0, faceShape:"d%" }
 * @example parseDiceNotation("2d20-1") → { count:2, sides:20, modifier:-1, faceShape:"d20" }
 */
export function parseDiceNotation(input: string): DiceNotation {
  if (typeof input !== "string") {
    throw new DiceNotationError("notation must be a string");
  }
  const match = NOTATION_RE.exec(input);
  if (!match) {
    throw new DiceNotationError(`invalid dice notation: ${JSON.stringify(input)}`);
  }
  const countRaw = match[1];
  const sidesToken = match[2];
  const modRaw = match[3];

  const count = countRaw === undefined ? 1 : parseInt(countRaw, 10);
  if (!Number.isInteger(count) || count < DICE_MIN_DICE_COUNT || count > DICE_MAX_DICE_COUNT) {
    throw new DiceNotationError(
      `dice count ${count} out of bounds [${DICE_MIN_DICE_COUNT}..${DICE_MAX_DICE_COUNT}]`,
    );
  }

  const sides = sidesToken === "%" ? 100 : parseInt(sidesToken, 10);
  const faceShape = SIDES_TO_FACE_SHAPE.get(sides);
  if (faceShape === undefined) {
    throw new DiceNotationError(`unsupported die sides: d${sidesToken}`);
  }

  const modifier = modRaw === undefined ? 0 : parseInt(modRaw, 10);
  if (!Number.isInteger(modifier) || Math.abs(modifier) > DICE_MAX_MODIFIER) {
    throw new DiceNotationError(
      `modifier ${modifier} out of bounds |±${DICE_MAX_MODIFIER}|`,
    );
  }

  // Canonical string: drop the count when 1, drop the modifier when 0, and
  // normalize the percentile to `d%` regardless of whether it was written
  // `d%` or `d100`. Stable so two equal notations serialize identically.
  const countStr = count === 1 ? "" : String(count);
  const sidesStr = sides === 100 ? "%" : String(sides);
  const modStr = modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : String(modifier);
  const notation = `${countStr}d${sidesStr}${modStr}`;

  return { notation, count, sides, modifier, faceShape };
}

// ─── Roller ───────────────────────────────────────────────────────────────────

/** A freshly rolled result from {@link rollDice}; per-face values + arithmetic. */
export interface DiceRollResult {
  notation: string;
  count: number;
  sides: number;
  modifier: number;
  faceShape: DiceFaceShape;
  /** One validated face value in `[1..sides]` per die, in roll order. */
  faces: number[];
  /** Sum of `faces`. */
  subtotal: number;
  /** `subtotal + modifier`. */
  total: number;
}

/**
 * Roll a parsed notation using the injected {@link RandomSource}. Produces
 * exactly `count` face values, each a uniform integer in `[1..sides]`, plus the
 * validated `subtotal` and `total`. Deterministic given a deterministic source.
 */
export function rollDice(notation: DiceNotation, rng: RandomSource): DiceRollResult {
  const faces: number[] = [];
  let subtotal = 0;
  for (let i = 0; i < notation.count; i += 1) {
    // intBelow(sides) ∈ [0..sides-1] → shift to [1..sides].
    const face = rng.intBelow(notation.sides) + 1;
    faces.push(face);
    subtotal += face;
  }
  const total = subtotal + notation.modifier;
  return {
    notation: notation.notation,
    count: notation.count,
    sides: notation.sides,
    modifier: notation.modifier,
    faceShape: notation.faceShape,
    faces,
    subtotal,
    total,
  };
}

// ─── Arithmetic validators ────────────────────────────────────────────────────

/**
 * Raw shape validated by {@link validateRollArithmetic}. Matches the per-face
 * slice stored on a {@link DiceAttempt} / {@link DiceRollResult}.
 */
export interface DiceRollArithmeticInput {
  sides: number;
  modifier: number;
  faces: readonly number[];
  subtotal: number;
  total: number;
}

/**
 * Validate that a face/modifier/subtotal/total tuple is internally consistent:
 * every face is an integer in `[1..sides]`, `subtotal === sum(faces)`, and
 * `total === subtotal + modifier`. Returns `null` when valid, or a stable error
 * reason string. This is the server-authoritative guard that rejects fabricated
 * or drifted faces/totals before persistence — the client never submits
 * authoritative faces/totals, but the same check defends against VM/script drift.
 */
export function validateRollArithmetic(input: DiceRollArithmeticInput): string | null {
  const { sides, modifier, faces, subtotal, total } = input;
  if (!Array.isArray(faces) || faces.length < DICE_MIN_DICE_COUNT || faces.length > DICE_MAX_DICE_COUNT) {
    return `face count ${faces?.length} out of bounds [${DICE_MIN_DICE_COUNT}..${DICE_MAX_DICE_COUNT}]`;
  }
  for (const face of faces) {
    if (typeof face !== "number" || !Number.isInteger(face) || face < 1 || face > sides) {
      return `face ${face} out of range [1..${sides}]`;
    }
  }
  if (typeof subtotal !== "number" || !Number.isInteger(subtotal)) {
    return `subtotal ${subtotal} is not an integer`;
  }
  let computed = 0;
  for (const face of faces) computed += face;
  if (subtotal !== computed) {
    return `subtotal ${subtotal} does not equal sum(faces) ${computed}`;
  }
  if (typeof total !== "number" || !Number.isInteger(total)) {
    return `total ${total} is not an integer`;
  }
  if (total !== subtotal + modifier) {
    return `total ${total} does not equal subtotal ${subtotal} + modifier ${modifier}`;
  }
  return null;
}

/**
 * Resolve the face-shape hint for a side count, or `null` if the sides are not
 * in the closed set. Convenience for code that already holds raw `sides`.
 */
export function faceShapeForSides(sides: number): DiceFaceShape | null {
  return SIDES_TO_FACE_SHAPE.get(sides) ?? null;
}

// ─── Prompt formatter input ───────────────────────────────────────────────────
//
// The stable input contract the prompt projection (Wave B5) formats from. B1
// only defines the shape + a tiny projection from a roll result, so the later
// wave builds a formatter against a frozen input rather than reaching into the
// raw result.

/** A single attempt projected for prompt formatting (Wave B5). */
export interface DiceFormatterAttempt {
  attemptId: string;
  faces: number[];
  modifier: number;
  total: number;
  grantReason?: string;
  chosenFinal?: boolean;
}

/** The frozen input the prompt formatter consumes (Wave B5). */
export interface DicePromptFormatterInput {
  actorLabel: string;
  checkLabel: string;
  notation: string;
  faceShape: DiceFaceShape;
  attempts: DiceFormatterAttempt[];
}

/**
 * Project a {@link DiceRollResult} into the formatter-input shape. Pure; the
 * Wave B5 formatter consumes the projection without touching the roller.
 */
export function toPromptFormatterInput(
  roll: DiceRollResult,
  labels: { attemptId: string; actorLabel: string; checkLabel: string },
): DicePromptFormatterInput {
  return {
    actorLabel: labels.actorLabel,
    checkLabel: labels.checkLabel,
    notation: roll.notation,
    faceShape: roll.faceShape,
    attempts: [
      {
        attemptId: labels.attemptId,
        faces: roll.faces,
        modifier: roll.modifier,
        total: roll.total,
      },
    ],
  };
}
