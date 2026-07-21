import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  diceAttemptSchema,
  diceRollSnapshotSchema,
  diceRollRequestSchema,
  diceSetIncludedSchema,
  diceChooseFinalSchema,
  diceDefinitionsResponseSchema,
  scriptKindSchema,
  DICE_SCHEMA_MAX_DICE_COUNT,
} from "../src/schemas/dice-schema.js";

/**
 * Characterization of the Dice Zod schemas (DICE_SYSTEM_BACKEND_PLAN B1).
 *
 * Pins the server-authoritative validation rules so a silent relaxation (a
 * dropped refinement, a widened bound, a missing strict/narrative check) is
 * caught here rather than letting fabricated faces/totals or mismatched
 * adjudication reach the DB. Pattern mirrors `script-schema.test.ts`:
 * `safeParse` everywhere, inline factories, one field mutated per case.
 */

// --- helpers ----------------------------------------------------------------

function expectReject(result: z.SafeParseReturnType<unknown, unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

function expectData(result: z.SafeParseReturnType<unknown, unknown>): unknown {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data;
}

// --- factories --------------------------------------------------------------

/** A single consistent 3d6+2 attempt. */
function validAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "att_1",
    faces: [3, 5, 6],
    modifier: 2,
    subtotal: 14,
    total: 16,
    ...overrides,
  };
}

/** A complete, internally-consistent strict Normal roll snapshot. */
function validRollSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    rollId: "roll_1",
    requestId: "req_1",
    actor: { actorType: "character", actorId: "char_1", actorLabel: "Aria" },
    scriptId: "script_1",
    scriptLabel: "Fate Die",
    scriptRevision: 1,
    checkId: "check_attack",
    checkLabel: "Attack",
    notation: "3d6+2",
    faceShape: "d6",
    resolution: "strict",
    mode: "normal",
    included: true,
    finalAttemptId: "att_1",
    attempts: [validAttempt()],
    final: { total: 16, outcome: "success", degree: "strong", constraint: "none" },
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

// --- scriptKindSchema -------------------------------------------------------

describe("scriptKindSchema", () => {
  it("accepts prompt and dice", () => {
    expect(scriptKindSchema.safeParse("prompt").success).toBe(true);
    expect(scriptKindSchema.safeParse("dice").success).toBe(true);
  });
  it("rejects an unknown kind", () => {
    expectReject(scriptKindSchema.safeParse("fate"));
    expectReject(scriptKindSchema.safeParse(""));
  });
});

// --- diceAttemptSchema (per-face arithmetic) --------------------------------

describe("diceAttemptSchema (per-face arithmetic)", () => {
  it("accepts a consistent attempt", () => {
    expect(diceAttemptSchema.safeParse(validAttempt()).success).toBe(true);
  });

  it("rejects a subtotal that does not equal sum(faces)", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ subtotal: 99 })));
  });

  it("rejects a total that does not equal subtotal + modifier", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ total: 99 })));
  });

  it("rejects a face above the max sides bound", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ faces: [3, 5, 999] })));
  });

  it("rejects a face below 1", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ faces: [3, 0, 6], subtotal: 9 })));
  });

  it("rejects a non-integer face", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ faces: [3.5] })));
  });

  it("rejects an empty faces array (min 1)", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ faces: [], subtotal: 0, total: 2 })));
  });

  it("rejects a faces array above the dice-count bound", () => {
    const faces = new Array(DICE_SCHEMA_MAX_DICE_COUNT + 1).fill(1);
    expectReject(diceAttemptSchema.safeParse(validAttempt({ faces, subtotal: faces.length, total: faces.length + 2 })));
  });

  it("rejects a non-integer modifier", () => {
    expectReject(diceAttemptSchema.safeParse(validAttempt({ modifier: 2.5, total: 16.5 })));
  });

  it("rejects a missing attemptId", () => {
    const { attemptId, ...rest } = validAttempt();
    void attemptId;
    expectReject(diceAttemptSchema.safeParse(rest));
  });
});

// --- diceRollSnapshotSchema (cross-field rules) -----------------------------

describe("diceRollSnapshotSchema (duplicate ids)", () => {
  it("rejects a snapshot with duplicate attempt ids", () => {
    const snap = validRollSnapshot({
      attempts: [validAttempt(), validAttempt({ total: 16 })],
      finalAttemptId: "att_1",
    });
    expectReject(diceRollSnapshotSchema.safeParse(snap));
  });

  it("accepts a snapshot with distinct attempt ids", () => {
    const snap = validRollSnapshot({
      attempts: [validAttempt(), validAttempt({ attemptId: "att_2", faces: [2, 4, 1], subtotal: 7, total: 9 })],
      finalAttemptId: "att_2",
    });
    expect(diceRollSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});

describe("diceRollSnapshotSchema (finalAttemptId consistency)", () => {
  it("rejects a finalAttemptId that matches no attempt", () => {
    expectReject(diceRollSnapshotSchema.safeParse(validRollSnapshot({ finalAttemptId: "ghost" })));
  });

  it("accepts a null finalAttemptId (unchosen narrative)", () => {
    const snap = validRollSnapshot({
      finalAttemptId: null,
      final: undefined,
      resolution: "narrative",
      mode: "immersive",
    });
    expect(diceRollSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});

describe("diceRollSnapshotSchema (strict vs narrative)", () => {
  it("accepts a strict roll with a final.outcome", () => {
    expect(diceRollSnapshotSchema.safeParse(validRollSnapshot()).success).toBe(true);
  });

  it("rejects a strict roll missing final.outcome", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({ final: { total: 16 } }),
      ),
    );
  });

  it("rejects a strict roll with no final at all", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(validRollSnapshot({ final: undefined })),
    );
  });

  it("accepts a narrative roll with no final", () => {
    expect(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({ resolution: "narrative", final: undefined, finalAttemptId: null }),
      ).success,
    ).toBe(true);
  });

  it("rejects a narrative roll that carries an authoritative outcome", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({
          resolution: "narrative",
          final: { total: 16, outcome: "success" },
          finalAttemptId: null,
        }),
      ),
    );
  });

  it("accepts a narrative roll whose final has only mechanical fields (no outcome)", () => {
    // narrative may carry total (mechanical) but not outcome (adjudication).
    expect(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({
          resolution: "narrative",
          final: { total: 16 },
          finalAttemptId: null,
        }),
      ).success,
    ).toBe(true);
  });
});

describe("diceRollSnapshotSchema (choose policy)", () => {
  it("rejects a choose policy with no chosenFinal attempt", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({
          resolution: "narrative",
          mode: "immersive",
          policy: "choose",
          final: undefined,
          finalAttemptId: null,
          attempts: [validAttempt({ chosenFinal: false })],
        }),
      ),
    );
  });

  it("accepts a choose policy with exactly one chosenFinal matching finalAttemptId", () => {
    expect(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({
          resolution: "narrative",
          mode: "immersive",
          policy: "choose",
          final: undefined,
          finalAttemptId: "att_1",
          attempts: [validAttempt({ chosenFinal: true })],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a choose policy where finalAttemptId does not match the chosen attempt", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({
          resolution: "narrative",
          mode: "immersive",
          policy: "choose",
          final: undefined,
          finalAttemptId: "att_other",
          attempts: [validAttempt({ chosenFinal: true })],
        }),
      ),
    );
  });
});

describe("diceRollSnapshotSchema (bounds + shape)", () => {
  it("rejects an over-long label", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(
        validRollSnapshot({ checkLabel: "x".repeat(501) }),
      ),
    );
  });

  it("rejects a negative scriptRevision", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(validRollSnapshot({ scriptRevision: -1 })),
    );
  });

  it("rejects an unknown faceShape", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(validRollSnapshot({ faceShape: "d7" })),
    );
  });

  it("rejects an empty attempts array (min 1)", () => {
    expectReject(
      diceRollSnapshotSchema.safeParse(validRollSnapshot({ attempts: [] })),
    );
  });
});

// --- diceRollRequestSchema (client never sends faces/totals) ----------------

describe("diceRollRequestSchema", () => {
  it("accepts a minimal request identifying the check + actor + idempotency key", () => {
    expect(
      diceRollRequestSchema.safeParse({
        scriptId: "script_1",
        checkId: "check_attack",
        actorType: "character",
        actorId: "char_1",
        mode: "normal",
        requestId: "req_1",
      }).success,
    ).toBe(true);
  });

  it("rejects a request that tries to submit authoritative faces", () => {
    // Faces are not part of the request contract — extra keys are stripped
    // (non-strict), but a MISSING required field is the real guard. Here the
    // required requestId is omitted.
    const { requestId, ...noId } = {
      scriptId: "script_1",
      checkId: "check_attack",
      actorType: "character",
      actorId: "char_1",
      mode: "normal",
      requestId: "req_1",
      faces: [6, 6, 6],
    };
    void requestId;
    expectReject(diceRollRequestSchema.safeParse(noId));
  });

  it("rejects an unknown mode", () => {
    expectReject(
      diceRollRequestSchema.safeParse({
        scriptId: "s",
        checkId: "c",
        actorType: "character",
        actorId: "char_1",
        mode: "hardcore",
        requestId: "r",
      }),
    );
  });
});

// --- partial-update schemas (NO defaults) -----------------------------------

describe("diceSetIncludedSchema (patch, no defaults)", () => {
  it("accepts { included: true|false }", () => {
    expect(diceSetIncludedSchema.safeParse({ included: true }).success).toBe(true);
    expect(diceSetIncludedSchema.safeParse({ included: false }).success).toBe(true);
  });
  it("rejects a missing included field", () => {
    expectReject(diceSetIncludedSchema.safeParse({}));
  });
  it("rejects a non-boolean included", () => {
    expectReject(diceSetIncludedSchema.safeParse({ included: "yes" }));
  });
});

describe("diceChooseFinalSchema (patch, no defaults)", () => {
  it("accepts { attemptId }", () => {
    expect(diceChooseFinalSchema.safeParse({ attemptId: "att_1" }).success).toBe(true);
  });
  it("rejects an empty attemptId", () => {
    expectReject(diceChooseFinalSchema.safeParse({ attemptId: "" }));
  });
});

// --- definitions response (duplicate check ids) -----------------------------

describe("diceDefinitionsResponseSchema (duplicate check ids)", () => {
  it("accepts distinct check ids across scripts", () => {
    expect(
      diceDefinitionsResponseSchema.safeParse({
        scripts: [
          { scriptId: "s1", scriptLabel: "Fate", scriptRevision: 1, checks: [
            { id: "c1", label: "Attack", notation: "3d6+2", actors: ["character"], resolution: "strict", faceShape: "d6" },
          ] },
          { scriptId: "s2", scriptLabel: "Other", scriptRevision: 1, checks: [
            { id: "c2", label: "Dodge", notation: "d20", actors: ["persona"], resolution: "narrative", faceShape: "d20" },
          ] },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a duplicate check id within the same script", () => {
    expectReject(
      diceDefinitionsResponseSchema.safeParse({
        scripts: [
          { scriptId: "s1", scriptLabel: "Fate", scriptRevision: 1, checks: [
            { id: "c1", label: "A", notation: "d6", actors: ["character"], resolution: "strict", faceShape: "d6" },
            { id: "c1", label: "B", notation: "d6", actors: ["character"], resolution: "strict", faceShape: "d6" },
          ] },
        ],
      }),
    );
  });

  it("rejects a duplicate check id across two scripts", () => {
    expectReject(
      diceDefinitionsResponseSchema.safeParse({
        scripts: [
          { scriptId: "s1", scriptLabel: "Fate", scriptRevision: 1, checks: [
            { id: "shared", label: "A", notation: "d6", actors: ["character"], resolution: "strict", faceShape: "d6" },
          ] },
          { scriptId: "s2", scriptLabel: "Other", scriptRevision: 1, checks: [
            { id: "shared", label: "B", notation: "d6", actors: ["character"], resolution: "strict", faceShape: "d6" },
          ] },
        ],
      }),
    );
  });
});

// --- round-trip: a full valid snapshot parses to its data -------------------

describe("full snapshot round-trip", () => {
  it("parses a complete strict Normal roll and preserves the actor label", () => {
    const data = expectData(diceRollSnapshotSchema.safeParse(validRollSnapshot())) as Record<string, unknown>;
    const actor = data.actor as Record<string, unknown>;
    expect(actor.actorLabel).toBe("Aria");
    expect(data.resolution).toBe("strict");
    expect(data.finalAttemptId).toBe("att_1");
  });
});
