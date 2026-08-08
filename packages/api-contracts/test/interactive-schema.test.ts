import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_CONTEXT_MODE,
  EXPERIENCE_EFFECT_KIND,
  EXPERIENCE_EFFECT_STATUS,
  EXPERIENCE_EVENT_VISIBILITY,
  EXPERIENCE_SESSION_STATUS,
  EXPERIENCE_VIEWER_KIND,
} from "@vibe-tavern/domain";
import {
  INTERACTIVE_SCHEMA_MAX_DEPTH,
  INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  boundedJsonValue,
  experienceActionSchema,
  experienceCapabilitySchema,
  experienceContextModeSchema,
  experienceControllerSchema,
  experienceEffectKindSchema,
  experienceEffectStatusSchema,
  experienceEventVisibilitySchema,
  experienceProjectedViewSchema,
  experienceReducerStatusSchema,
  experienceSessionResponseSchema,
  experienceSessionStatusSchema,
  experienceStartRequestSchema,
  experienceTransitionSchema,
  experienceViewerKindSchema,
  experienceViewerSchema,
  jsonBoundsError,
} from "../src/schemas/interactive-schema.js";

/**
 * Characterization tests for the Interactive Runtime contract (IR-11).
 *
 * Pins the load-bearing invariants of the canonical wire schemas so a silent
 * drift (a dropped bound, a widened enum, a missing refinement, a literal that
 * diverges from the domain constants) is caught here rather than as a broken
 * host/visual/Writer boundary in a later wave.
 *
 * Pattern mirrors dice-schema.test.ts / script-schema.test.ts:
 *   - `safeParse` everywhere; `expectReject` / `expectData` helpers.
 *   - Inline factories return a fresh valid baseline; each `it` mutates one
 *     field to isolate the constraint under test.
 *   - Enum schemas are parity-checked against the domain `EXPERIENCE_*`
 *     constants (the schemas are a manual mirror, so a drifted literal is the
 *     failure mode this guard exists for).
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

/** The option list of a zod enum schema, as a sorted string array. */
function enumOptions(schema: z.ZodEnum<[string, ...string[]]>): string[] {
  return [...schema.options].sort();
}

/** The value list of a domain `as const` object, as a sorted string array. */
function constValues<const T>(obj: T): string[] {
  return Object.values(obj as Record<string, string>).sort();
}

// --- enum parity (schemas mirror domain constants exactly) ------------------

describe("interactive enum schemas mirror domain EXPERIENCE_* constants", () => {
  it("experienceCapabilitySchema mirrors EXPERIENCE_CAPABILITY", () => {
    expect(enumOptions(experienceCapabilitySchema)).toEqual(constValues(EXPERIENCE_CAPABILITY));
  });

  it("experienceControllerSchema mirrors EXPERIENCE_CONTROLLER", () => {
    expect(enumOptions(experienceControllerSchema)).toEqual(constValues(EXPERIENCE_CONTROLLER));
  });

  it("experienceViewerKindSchema mirrors EXPERIENCE_VIEWER_KIND", () => {
    expect(enumOptions(experienceViewerKindSchema)).toEqual(constValues(EXPERIENCE_VIEWER_KIND));
  });

  it("experienceSessionStatusSchema mirrors EXPERIENCE_SESSION_STATUS", () => {
    expect(enumOptions(experienceSessionStatusSchema)).toEqual(constValues(EXPERIENCE_SESSION_STATUS));
  });

  it("experienceEventVisibilitySchema mirrors EXPERIENCE_EVENT_VISIBILITY", () => {
    expect(enumOptions(experienceEventVisibilitySchema)).toEqual(constValues(EXPERIENCE_EVENT_VISIBILITY));
  });

  it("experienceEffectStatusSchema mirrors EXPERIENCE_EFFECT_STATUS", () => {
    expect(enumOptions(experienceEffectStatusSchema)).toEqual(constValues(EXPERIENCE_EFFECT_STATUS));
  });

  it("experienceEffectKindSchema mirrors EXPERIENCE_EFFECT_KIND", () => {
    expect(enumOptions(experienceEffectKindSchema)).toEqual(constValues(EXPERIENCE_EFFECT_KIND));
  });

  it("experienceContextModeSchema mirrors EXPERIENCE_CONTEXT_MODE", () => {
    expect(enumOptions(experienceContextModeSchema)).toEqual(constValues(EXPERIENCE_CONTEXT_MODE));
  });
});

// --- reducer status narrowing ------------------------------------------------

describe("experienceReducerStatusSchema (transition output is active|completed only)", () => {
  // `interrupted` is host-only (an explicit user end). A reducer returning it
  // must be rejected before persistence, so the transition schema narrows to
  // the active|completed subset of session status.
  it("accepts 'active' and 'completed'", () => {
    expect(experienceReducerStatusSchema.safeParse("active").success).toBe(true);
    expect(experienceReducerStatusSchema.safeParse("completed").success).toBe(true);
  });

  it("rejects 'interrupted' (host-only status)", () => {
    expectReject(experienceReducerStatusSchema.safeParse("interrupted"));
  });
});

// --- jsonBoundsError (the pure guard the kernel reuses) ---------------------

describe("jsonBoundsError", () => {
  it("accepts plain JSON values (null/bool/number/string/array/object/nested)", () => {
    expect(jsonBoundsError(null, { maxDepth: 8, maxBytes: 1024 })).toBeNull();
    expect(jsonBoundsError(true, { maxDepth: 8, maxBytes: 1024 })).toBeNull();
    expect(jsonBoundsError(42, { maxDepth: 8, maxBytes: 1024 })).toBeNull();
    expect(jsonBoundsError("hi", { maxDepth: 8, maxBytes: 1024 })).toBeNull();
    expect(jsonBoundsError([1, { a: "b" }], { maxDepth: 8, maxBytes: 1024 })).toBeNull();
    expect(jsonBoundsError({ a: [1, 2, { b: null }] }, { maxDepth: 8, maxBytes: 1024 })).toBeNull();
  });

  it("rejects undefined / function / symbol / bigint (not JSON-safe)", () => {
    expect(jsonBoundsError(undefined, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
    expect(jsonBoundsError(() => 1, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
    expect(jsonBoundsError(Symbol("x"), { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
    expect(jsonBoundsError(10n, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
  });

  it("rejects non-finite numbers (NaN / Infinity)", () => {
    expect(jsonBoundsError(NaN, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
    expect(jsonBoundsError(Infinity, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
    expect(jsonBoundsError(-Infinity, { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
  });

  it("rejects a cyclic structure", () => {
    const a: unknown[] = [];
    a.push(a);
    expect(jsonBoundsError(a, { maxDepth: 8, maxBytes: 1024 })).toMatch(/cyclic/);
  });

  it("rejects nesting deeper than maxDepth", () => {
    // maxDepth counts container levels; a chain deeper than the limit is rejected.
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(jsonBoundsError(deep, { maxDepth: 2, maxBytes: 1024 })).toMatch(/depth/);
    // and accepted when the limit is generous.
    expect(jsonBoundsError(deep, { maxDepth: 8, maxBytes: 1024 })).toBeNull();
  });

  it("rejects a serialized size above maxBytes", () => {
    const big = "x".repeat(500);
    expect(jsonBoundsError(big, { maxDepth: 8, maxBytes: 100 })).toMatch(/size/);
    expect(jsonBoundsError(big, { maxDepth: 8, maxBytes: 1000 })).toBeNull();
  });

  it("treats an undefined array element as non-JSON-safe (round-trip lossy)", () => {
    // JSON.stringify([undefined]) === "[null]" — the undefined is lost, so a
    // strict round-trip guard rejects it rather than silently coercing to null.
    expect(jsonBoundsError([undefined], { maxDepth: 8, maxBytes: 1024 })).not.toBeNull();
  });
});

describe("boundedJsonValue (zod schema built on jsonBoundsError)", () => {
  const schema = boundedJsonValue({
    maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
    maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  });

  it("accepts a bounded JSON object", () => {
    expect(schema.safeParse({ score: 3, board: [null, "x", "o"] }).success).toBe(true);
  });

  it("rejects a function value via the refine", () => {
    expectReject(schema.safeParse({ fn: () => 1 }));
  });

  it("rejects an oversized serialized value", () => {
    const huge = "z".repeat(INTERACTIVE_SCHEMA_MAX_STATE_BYTES + 10);
    expectReject(schema.safeParse({ big: huge }));
  });
});

// --- experienceViewerSchema refinement --------------------------------------

describe("experienceViewerSchema", () => {
  it("accepts a human/script/model viewer with a participantId", () => {
    for (const kind of ["human", "script", "model"] as const) {
      expect(
        experienceViewerSchema.safeParse({ kind, participantId: "p1" }).success,
      ).toBe(true);
    }
  });

  it("accepts an observer viewer WITHOUT a participantId", () => {
    expect(experienceViewerSchema.safeParse({ kind: "observer" }).success).toBe(true);
  });

  it("rejects a seat viewer missing participantId", () => {
    for (const kind of ["human", "script", "model"] as const) {
      expectReject(experienceViewerSchema.safeParse({ kind }));
    }
  });

  it("rejects an observer viewer carrying a participantId", () => {
    expectReject(experienceViewerSchema.safeParse({ kind: "observer", participantId: "p1" }));
  });
});

// --- experienceTransitionSchema ---------------------------------------------

describe("experienceTransitionSchema", () => {
  function validTransition() {
    return {
      state: { turn: "x", moves: 1 },
      status: "active",
      events: [{ visibility: "public", type: "move", detail: { to: 4 } }],
    };
  }

  it("accepts a minimal valid transition", () => {
    expect(experienceTransitionSchema.safeParse(validTransition()).success).toBe(true);
  });

  it("accepts a completed transition with effects", () => {
    expect(
      experienceTransitionSchema.safeParse({
        ...validTransition(),
        status: "completed",
        effects: [{ kind: "model", request: { prompt: "pick" } }],
        message: "Checkmate",
      }).success,
    ).toBe(true);
  });

  it("rejects status 'interrupted' (host-only, not reducer output)", () => {
    expectReject(experienceTransitionSchema.safeParse({ ...validTransition(), status: "interrupted" }));
  });

  it("rejects a transition whose state is not JSON-safe", () => {
    expectReject(
      experienceTransitionSchema.safeParse({ ...validTransition(), state: { fn: () => 1 } }),
    );
  });

  it("rejects an unknown effect kind", () => {
    expectReject(
      experienceTransitionSchema.safeParse({
        ...validTransition(),
        effects: [{ kind: "network", request: {} }],
      }),
    );
  });
});

// --- experienceActionSchema (CAS + idempotency carriers) --------------------

describe("experienceActionSchema", () => {
  function validAction() {
    return { type: "place", requestId: "req_1", expectedRevision: 3 };
  }

  it("accepts a minimal action", () => {
    expect(experienceActionSchema.safeParse(validAction()).success).toBe(true);
  });

  it("accepts an optional bounded payload and participantId", () => {
    expect(
      experienceActionSchema.safeParse({ ...validAction(), participantId: "p1", payload: { cell: 4 } })
        .success,
    ).toBe(true);
  });

  it("rejects a negative expectedRevision", () => {
    expectReject(experienceActionSchema.safeParse({ ...validAction(), expectedRevision: -1 }));
  });

  it("rejects a missing requestId (idempotency is mandatory)", () => {
    const { requestId: _omit, ...rest } = validAction();
    void _omit;
    expectReject(experienceActionSchema.safeParse(rest));
  });

  it("rejects a non-JSON-safe payload", () => {
    expectReject(
      experienceActionSchema.safeParse({ ...validAction(), payload: { fn: () => 1 } }),
    );
  });
});

// --- experienceProjectedViewSchema ------------------------------------------

describe("experienceProjectedViewSchema", () => {
  it("accepts a valid projected view", () => {
    expect(
      experienceProjectedViewSchema.safeParse({
        state: { board: ["x", null, "o"] },
        actions: [{ type: "place", participantId: "p1" }],
        revision: 2,
        status: "active",
      }).success,
    ).toBe(true);
  });

  it("rejects hidden/private leaks is a kernel concern; schema rejects oversized state", () => {
    // Schema boundary: oversized projected state is rejected.
    expectReject(
      experienceProjectedViewSchema.safeParse({
        state: { big: "q".repeat(INTERACTIVE_SCHEMA_MAX_STATE_BYTES + 10) },
        actions: [],
        revision: 0,
        status: "active",
      }),
    );
  });
});

// --- session lifecycle request/response envelopes ---------------------------

describe("experienceStartRequestSchema", () => {
  function validStart() {
    return { branchId: "br_1" };
  }

  it("accepts a minimal config-driven start and defaults participants to []", () => {
    const data = expectData(experienceStartRequestSchema.safeParse(validStart())) as Record<
      string,
      unknown
    >;
    expect(data.participants).toEqual([]);
    expect(data.branchId).toBe("br_1");
  });

  it("accepts settings + a participant roster", () => {
    expect(
      experienceStartRequestSchema.safeParse({
        ...validStart(),
        settings: { difficulty: "hard" },
        participants: [{ id: "p1", label: "Player 1", controller: "human" }],
      }).success,
    ).toBe(true);
  });

  it("is config-driven: scriptId/visualId/grants/contextMode are NOT accepted fields", () => {
    // The start request carries only branch/settings/roster; the setup is
    // resolved server-side from the chat config. Extra unknown fields are
    // ignored by Zod, but the canonical fields are branchId + settings +
    // participants (asserted by the minimal-start default above).
    const data = expectData(
      experienceStartRequestSchema.safeParse({ ...validStart(), scriptId: "sc_1" }),
    ) as Record<string, unknown>;
    expect(data.participants).toEqual([]);
  });

  it("rejects a missing branchId", () => {
    expectReject(experienceStartRequestSchema.safeParse({ participants: [] }));
  });
});

describe("experienceSessionResponseSchema", () => {
  function validResponse() {
    return {
      sessionId: "s_1",
      chatId: "c_1",
      branchId: "br_1",
      manifest: { id: "ttt", name: "Tic-Tac-Toe" },
      apiVersion: 1,
      status: "active",
      revision: 0,
      reportFrontier: 0,
      view: { state: {}, actions: [], revision: 0, status: "active" },
      capabilityGrants: [],
      contextMode: "none",
      participants: [],
    };
  }

  it("accepts a valid session response", () => {
    expect(experienceSessionResponseSchema.safeParse(validResponse()).success).toBe(true);
  });

  it("rejects a response missing the projected view", () => {
    const { view: _omit, ...rest } = validResponse();
    void _omit;
    expectReject(experienceSessionResponseSchema.safeParse(rest));
  });

  it("rejects an unknown session status", () => {
    expectReject(
      experienceSessionResponseSchema.safeParse({ ...validResponse(), status: "paused" }),
    );
  });
});
