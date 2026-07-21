/**
 * Dice message formatter unit tests (DICE_SYSTEM_BACKEND_PLAN, Wave B5 / DICE-B13).
 *
 * Pure-function tests for {@link formatDiceMessageBlock}: strict/narrative
 * distinction, multiple checks, multiple attempts (Immersive), grant reasons,
 * chosen markers, and the empty-rolls no-op. These pin the exact format shape
 * the model receives; the assembly-integration tests (absence no-op, token
 * accounting, single derivation) live in assemble.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { formatDiceMessageBlock } from "../src/dice-message-format.ts";
import { brandId, type DiceRollSnapshot, type DiceRollId, type MessageId } from "@vibe-tavern/domain";

function makeRoll(overrides: Partial<DiceRollSnapshot> = {}): DiceRollSnapshot {
  return {
    rollId: brandId<DiceRollId>("roll_1"),
    requestId: "req_1",
    actor: { actorType: "character", actorId: "char_1", actorLabel: "Theron" },
    scriptId: "script_1",
    scriptLabel: "Combat",
    scriptRevision: 1,
    checkId: "check_1",
    checkLabel: "Stealth Check",
    notation: "2d6+1",
    faceShape: "d6",
    resolution: "strict",
    mode: "normal",
    included: true,
    finalAttemptId: "att_1",
    attempts: [
      { attemptId: "att_1", faces: [3, 5], modifier: 1, subtotal: 8, total: 9 },
    ],
    final: { total: 9, outcome: "success", degree: "hard", constraint: "must remain unseen" },
    boundMessageId: brandId<MessageId>("msg_1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatDiceMessageBlock", () => {
  it("returns empty string for no rolls (absence no-op)", () => {
    expect(formatDiceMessageBlock([])).toBe("");
  });

  it("formats a strict check with binding adjudication (outcome + degree + constraint)", () => {
    const block = formatDiceMessageBlock([makeRoll()]);
    expect(block).toBe(
      "[Dice]\n" +
      "Stealth Check (2d6+1) — Theron: [3,5]+1 = 9. Adjudication: success (hard). Binding constraint: must remain unseen.",
    );
  });

  it("omits adjudication for narrative checks (mechanical facts only)", () => {
    const roll = makeRoll({
      rollId: brandId<DiceRollId>("roll_2"),
      checkLabel: "Athletics",
      notation: "d20",
      faceShape: "d20",
      resolution: "narrative",
      attempts: [{ attemptId: "att_1", faces: [14], modifier: 0, subtotal: 14, total: 14 }],
      final: undefined,
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toBe("[Dice]\nAthletics (d20) — Theron: [14] = 14.");
  });

  it("formats multiple checks in one block (order preserved)", () => {
    const block = formatDiceMessageBlock([
      makeRoll({ checkLabel: "Stealth Check" }),
      makeRoll({
        rollId: brandId<DiceRollId>("roll_2"),
        checkId: "check_2",
        checkLabel: "Perception",
        notation: "d20",
        faceShape: "d20",
        resolution: "narrative",
        attempts: [{ attemptId: "att_1", faces: [14], modifier: 0, subtotal: 14, total: 14 }],
        final: undefined,
      }),
    ]);
    const lines = block.split("\n");
    expect(lines[0]).toBe("[Dice]");
    expect(lines[1]).toContain("Stealth Check");
    expect(lines[1]).toContain("Adjudication: success");
    expect(lines[2]).toContain("Perception");
    expect(lines[2]).not.toContain("Adjudication");
  });

  it("omits modifier when zero", () => {
    const roll = makeRoll({
      notation: "2d6",
      attempts: [{ attemptId: "att_1", faces: [3, 5], modifier: 0, subtotal: 8, total: 8 }],
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toContain("[3,5] = 8");
    expect(block).not.toContain("[3,5]+0");
  });

  it("handles negative modifiers", () => {
    const roll = makeRoll({
      notation: "d20-2",
      attempts: [{ attemptId: "att_1", faces: [10], modifier: -2, subtotal: 10, total: 8 }],
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toContain("[10]-2 = 8");
  });

  it("formats multiple Immersive attempts with grant reason and chosen marker", () => {
    const roll = makeRoll({
      mode: "immersive",
      policy: "choose",
      finalAttemptId: "att_2",
      attempts: [
        { attemptId: "att_1", faces: [5], modifier: 3, subtotal: 5, total: 8 },
        {
          attemptId: "att_2",
          faces: [12],
          modifier: 3,
          subtotal: 12,
          total: 15,
          grantReason: "Lucky Reroll",
          chosenFinal: true,
        },
      ],
      final: { total: 15, outcome: "hit" },
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toContain("attempt 1: [5]+3 = 8");
    expect(block).toContain("attempt 2: [12]+3 = 15 (Lucky Reroll) (chosen)");
    expect(block).toContain("Adjudication: hit.");
  });

  it("includes outcome without degree or constraint when those are absent", () => {
    const roll = makeRoll({
      final: { total: 9, outcome: "success" },
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toContain("Adjudication: success.");
    expect(block).not.toContain("(hard)");
    expect(block).not.toContain("Binding constraint");
  });

  it("includes degree without outcome (partial adjudication)", () => {
    const roll = makeRoll({
      final: { total: 9, degree: "marginal" },
    });
    const block = formatDiceMessageBlock([roll]);
    expect(block).toContain("Adjudication: (marginal).");
    expect(block).not.toContain("Binding constraint");
  });
});
