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
  INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT,
  INTERACTIVE_SCHEMA_MAX_DEPTH,
  INTERACTIVE_SCHEMA_MAX_ID,
  INTERACTIVE_SCHEMA_MAX_SETUP_FIELDS,
  INTERACTIVE_SCHEMA_MAX_SETUP_OPTIONS,
  INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  INTERACTIVE_SCHEMA_MAX_STRING,
  boundedJsonValue,
  experienceActionSchema,
  experienceCapabilitySchema,
  experienceChatterRequestSchema,
  experienceChatterViewSchema,
  experienceContextModeSchema,
  experienceControllerSchema,
  experienceDefinitionSchema,
  experienceEffectKindSchema,
  experienceEffectStatusSchema,
  experienceEventVisibilitySchema,
  experienceParticipantSchema as experienceParticipantResponseSchema,
  experienceStartParticipantSchema as experienceParticipantSchema,
  experienceProjectedViewSchema,
  experienceReducerStatusSchema,
  experienceSessionResponseSchema,
  experienceSessionStatusSchema,
  experienceSetupDefinitionSchema,
  experienceSetupFieldSchema,
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

// --- experienceParticipantSchema (IR-70E model-seat binding) ----------------

describe("experienceParticipantSchema (IR-70E model-seat assignment)", () => {
  function validHuman() {
    return { id: "p1", label: "You", controller: "human" };
  }
  function validModel() {
    return { id: "ai", label: "AI", controller: "model", providerProfileId: "pp_1", modelId: "m_1" };
  }

  it("accepts a valid model participant with both pinned ids", () => {
    expect(experienceParticipantSchema.safeParse(validModel()).success).toBe(true);
  });

  it("accepts a valid human/script participant with neither id", () => {
    expect(experienceParticipantSchema.safeParse(validHuman()).success).toBe(true);
    expect(
      experienceParticipantSchema.safeParse({ id: "bot", label: "Bot", controller: "script" }).success,
    ).toBe(true);
  });

  it("keeps legacy model participants valid on persisted/response boundaries", () => {
    const legacy = { id: "legacy-ai", label: "Legacy AI", controller: "model" };
    expect(experienceParticipantResponseSchema.safeParse(legacy).success).toBe(true);
    expect(experienceSessionResponseSchema.safeParse({
      sessionId: "xs_1",
      chatId: "c_1",
      branchId: "b_1",
      manifest: { id: "legacy", name: "Legacy" },
      apiVersion: 1,
      status: "active",
      revision: 0,
      reportFrontier: 0,
      view: { state: {}, actions: [], revision: 0, status: "active" },
      capabilityGrants: ["model"],
      contextMode: "none",
      participants: [legacy],
      visualId: null,
      visualSource: null,
      visualSourceHash: null,
    }).success).toBe(true);
  });

  it("rejects a model participant missing the providerProfileId", () => {
    const { providerProfileId: _omit, ...rest } = validModel();
    void _omit;
    expectReject(experienceParticipantSchema.safeParse(rest));
  });

  it("rejects a model participant missing the modelId", () => {
    const { modelId: _omit, ...rest } = validModel();
    void _omit;
    expectReject(experienceParticipantSchema.safeParse(rest));
  });

  it("rejects a model participant missing BOTH ids", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ id: "ai", label: "AI", controller: "model" }),
    );
  });

  it("rejects a human participant carrying a providerProfileId", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ ...validHuman(), providerProfileId: "pp_1" }),
    );
  });

  it("rejects a human participant carrying a modelId", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ ...validHuman(), modelId: "m_1" }),
    );
  });

  it("rejects a script participant carrying either id", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ id: "bot", label: "Bot", controller: "script", providerProfileId: "pp_1" }),
    );
    expectReject(
      experienceParticipantSchema.safeParse({ id: "bot", label: "Bot", controller: "script", modelId: "m_1" }),
    );
  });

  it("rejects a blank providerProfileId on a model seat", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ ...validModel(), providerProfileId: "" }),
    );
  });

  it("rejects a blank modelId on a model seat", () => {
    expectReject(
      experienceParticipantSchema.safeParse({ ...validModel(), modelId: "" }),
    );
  });

  it("rejects an oversized providerProfileId on a model seat", () => {
    expectReject(
      experienceParticipantSchema.safeParse({
        ...validModel(),
        providerProfileId: "x".repeat(INTERACTIVE_SCHEMA_MAX_ID + 1),
      }),
    );
  });

  it("rejects an oversized modelId on a model seat", () => {
    expectReject(
      experienceParticipantSchema.safeParse({
        ...validModel(),
        modelId: "x".repeat(INTERACTIVE_SCHEMA_MAX_ID + 1),
      }),
    );
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

  it("accepts a timer effect transition", () => {
    expect(
      experienceTransitionSchema.safeParse({
        ...validTransition(),
        effects: [{ kind: "timer", request: { viewer: "model", actionType: "tick", afterMs: 5000 } }],
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
      visualId: null,
      visualSource: null,
      visualSourceHash: null,
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

  // ── IR-70G: pinned visual source snapshot fields ───────────────────────

  it("accepts the all-null no-visual triplet (visualId/source/hash)", () => {
    const data = expectData(experienceSessionResponseSchema.safeParse(validResponse()));
    expect((data as { visualId: string | null }).visualId).toBeNull();
    expect((data as { visualSource: string | null }).visualSource).toBeNull();
    expect((data as { visualSourceHash: string | null }).visualSourceHash).toBeNull();
  });

  it("accepts the all-non-null pinned-visual triplet", () => {
    const pinned = {
      ...validResponse(),
      visualId: "vis_1",
      visualSource: "<visual source/>",
      visualSourceHash: "hash_abc",
    };
    const data = expectData(experienceSessionResponseSchema.safeParse(pinned));
    expect((data as { visualId: string }).visualId).toBe("vis_1");
    expect((data as { visualSource: string }).visualSource).toBe("<visual source/>");
    expect((data as { visualSourceHash: string }).visualSourceHash).toBe("hash_abc");
  });

  it("rejects a mixed triplet: visualId non-null but source/hash null", () => {
    expectReject(
      experienceSessionResponseSchema.safeParse({
        ...validResponse(),
        visualId: "vis_1",
        visualSource: null,
        visualSourceHash: null,
      }),
    );
  });

  it("rejects a mixed triplet: visualId null but source non-null", () => {
    expectReject(
      experienceSessionResponseSchema.safeParse({
        ...validResponse(),
        visualId: null,
        visualSource: "<visual/>",
        visualSourceHash: null,
      }),
    );
  });

  it("rejects a mixed triplet: hash non-null but visualId/source null", () => {
    expectReject(
      experienceSessionResponseSchema.safeParse({
        ...validResponse(),
        visualId: null,
        visualSource: null,
        visualSourceHash: "orphan_hash",
      }),
    );
  });

  it("rejects a response missing visualSource (required nullable, not optional)", () => {
    const { visualSource: _omit, ...rest } = validResponse();
    void _omit;
    expectReject(experienceSessionResponseSchema.safeParse(rest));
  });

  it("rejects a response missing visualSourceHash (required nullable, not optional)", () => {
    const { visualSourceHash: _omit, ...rest } = validResponse();
    void _omit;
    expectReject(experienceSessionResponseSchema.safeParse(rest));
  });

  it("rejects a response missing visualId (required nullable, not optional)", () => {
    const { visualId: _omit, ...rest } = validResponse();
    void _omit;
    expectReject(experienceSessionResponseSchema.safeParse(rest));
  });
});

// ─── Setup descriptor (IR-70F) ───────────────────────────────────────────────

function validDefinition() {
  return {
    apiVersion: 1,
    manifest: { id: "ttt", name: "Tic-Tac-Toe" },
    declaredCapabilities: [],
  };
}

describe("experienceSetupFieldSchema — round-trip preserves author omission (IR-70F)", () => {
  // Each case is a field declared with only the keys the author provided.
  // Parsing must return exactly those keys — no fabricated defaults.
  const cases: Array<{ name: string; input: unknown; expected: unknown }> = [
    {
      name: "text: minimal",
      input: { kind: "text", id: "name", label: "Name" },
      expected: { kind: "text", id: "name", label: "Name" },
    },
    {
      name: "text: full",
      input: {
        kind: "text", id: "name", label: "Name", description: "d", placeholder: "p",
        required: true, default: "hi", minLength: 1, maxLength: 10,
      },
      expected: {
        kind: "text", id: "name", label: "Name", description: "d", placeholder: "p",
        required: true, default: "hi", minLength: 1, maxLength: 10,
      },
    },
    {
      name: "number: minimal",
      input: { kind: "number", id: "lvl", label: "Level" },
      expected: { kind: "number", id: "lvl", label: "Level" },
    },
    {
      name: "number: with bounds/default",
      input: {
        kind: "number", id: "lvl", label: "Level", default: 5, min: 1, max: 10, step: 1,
      },
      expected: {
        kind: "number", id: "lvl", label: "Level", default: 5, min: 1, max: 10, step: 1,
      },
    },
    {
      name: "boolean: minimal",
      input: { kind: "boolean", id: "hc", label: "Hardcore" },
      expected: { kind: "boolean", id: "hc", label: "Hardcore" },
    },
    {
      name: "boolean: with default",
      input: { kind: "boolean", id: "hc", label: "Hardcore", default: true },
      expected: { kind: "boolean", id: "hc", label: "Hardcore", default: true },
    },
    {
      name: "select: minimal single option",
      input: {
        kind: "select", id: "diff", label: "Difficulty",
        options: [{ value: "easy", label: "Easy" }],
      },
      expected: {
        kind: "select", id: "diff", label: "Difficulty",
        options: [{ value: "easy", label: "Easy" }],
      },
    },
    {
      name: "select: with default",
      input: {
        kind: "select", id: "diff", label: "Difficulty", default: "hard",
        options: [{ value: "easy", label: "Easy" }, { value: "hard", label: "Hard" }],
      },
      expected: {
        kind: "select", id: "diff", label: "Difficulty", default: "hard",
        options: [{ value: "easy", label: "Easy" }, { value: "hard", label: "Hard" }],
      },
    },
  ];

  for (const c of cases) {
    it(`round-trips ${c.name}`, () => {
      expect(expectData(experienceSetupFieldSchema.safeParse(c.input))).toEqual(c.expected);
    });
  }
});

describe("experienceSetupFieldSchema — rejections (strict + cross-field)", () => {
  const rejectCases: Array<{ name: string; input: unknown }> = [
    { name: "unknown field key (strict)", input: { kind: "text", id: "a", label: "A", extra: 1 } },
    { name: "unknown kind discriminator", input: { kind: "color", id: "a", label: "A" } },
    { name: "missing id", input: { kind: "text", label: "A" } },
    { name: "empty option value (bounded id)", input: { kind: "select", id: "a", label: "A", options: [{ value: "", label: "L" }] } },
    { name: "duplicate option values", input: { kind: "select", id: "a", label: "A", options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] } },
    { name: "unknown option key (strict)", input: { kind: "select", id: "a", label: "A", options: [{ value: "x", label: "X", extra: 1 }] } },
    { name: "select default not in options", input: { kind: "select", id: "a", label: "A", default: "z", options: [{ value: "x", label: "X" }] } },
    { name: "select zero options", input: { kind: "select", id: "a", label: "A", options: [] } },
    { name: "number min > max", input: { kind: "number", id: "a", label: "A", min: 10, max: 1 } },
    { name: "number step <= 0", input: { kind: "number", id: "a", label: "A", step: 0 } },
    { name: "number non-finite default", input: { kind: "number", id: "a", label: "A", default: Infinity } },
    { name: "number default below min", input: { kind: "number", id: "a", label: "A", default: 0, min: 1 } },
    { name: "number default above max", input: { kind: "number", id: "a", label: "A", default: 11, max: 10 } },
    { name: "text minLength > maxLength", input: { kind: "text", id: "a", label: "A", minLength: 10, maxLength: 1 } },
    { name: "text minLength out of bound", input: { kind: "text", id: "a", label: "A", minLength: 2001 } },
    { name: "text default too long", input: { kind: "text", id: "a", label: "A", default: "12345", maxLength: 3 } },
    { name: "text default too short", input: { kind: "text", id: "a", label: "A", default: "x", minLength: 3 } },
  ];
  for (const c of rejectCases) {
    it(`rejects ${c.name}`, () => {
      expectReject(experienceSetupFieldSchema.safeParse(c.input));
    });
  }

  it(`rejects more than ${INTERACTIVE_SCHEMA_MAX_SETUP_OPTIONS} select options`, () => {
    const options = Array.from({ length: INTERACTIVE_SCHEMA_MAX_SETUP_OPTIONS + 1 }, (_, i) => ({
      value: `opt${i}`,
      label: `Opt ${i}`,
    }));
    expectReject(
      experienceSetupFieldSchema.safeParse({ kind: "select", id: "a", label: "A", options }),
    );
  });
});

describe("experienceSetupDefinitionSchema (IR-70F)", () => {
  it("round-trips a multi-field setup preserving field order + omissions", () => {
    const setup = {
      fields: [
        { kind: "text", id: "name", label: "Name", default: "hero" },
        { kind: "number", id: "level", label: "Level", min: 1, max: 5 },
        { kind: "boolean", id: "hardcore", label: "Hardcore" },
        {
          kind: "select", id: "style", label: "Style", default: "aggressive",
          options: [
            { value: "aggressive", label: "Aggressive" },
            { value: "cautious", label: "Cautious" },
          ],
        },
      ],
    };
    expect(expectData(experienceSetupDefinitionSchema.safeParse(setup))).toEqual(setup);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expectReject(experienceSetupDefinitionSchema.safeParse({ fields: [], extra: 1 }));
  });

  it("rejects duplicate field ids", () => {
    expectReject(
      experienceSetupDefinitionSchema.safeParse({
        fields: [
          { kind: "text", id: "dup", label: "A" },
          { kind: "number", id: "dup", label: "B" },
        ],
      }),
    );
  });

  it(`rejects more than ${INTERACTIVE_SCHEMA_MAX_SETUP_FIELDS} fields`, () => {
    const fields = Array.from({ length: INTERACTIVE_SCHEMA_MAX_SETUP_FIELDS + 1 }, (_, i) => ({
      kind: "boolean",
      id: `f${i}`,
      label: `F${i}`,
    }));
    expectReject(experienceSetupDefinitionSchema.safeParse({ fields }));
  });
});

describe("experienceDefinitionSchema setup (IR-70F)", () => {
  it("accepts a definition WITHOUT setup and omits it from parsed data", () => {
    const data = expectData(experienceDefinitionSchema.safeParse(validDefinition())) as Record<
      string,
      unknown
    >;
    expect(data.setup).toBeUndefined();
  });

  it("accepts a definition WITH a valid setup and preserves it", () => {
    const withSetup = {
      ...validDefinition(),
      setup: {
        fields: [
          { kind: "text", id: "strength", label: "Strength", default: "strong" },
        ],
      },
    };
    const data = expectData(experienceDefinitionSchema.safeParse(withSetup));
    expect(data).toEqual(withSetup);
  });

  it("rejects a definition with a malformed setup (duplicate field id)", () => {
    expectReject(
      experienceDefinitionSchema.safeParse({
        ...validDefinition(),
        setup: {
          fields: [
            { kind: "text", id: "dup", label: "A" },
            { kind: "text", id: "dup", label: "B" },
          ],
        },
      }),
    );
  });
});

describe("experienceChatterRequestSchema / experienceChatterViewSchema (async flavor chatter, item 4)", () => {
  it("accepts a valid chatter request with optional fallback", () => {
    const data = expectData(
      experienceChatterRequestSchema.safeParse({
        seatId: "ai1",
        instructions: "short reaction",
        fallback: "…thinking…",
      }),
    );
    expect(data).toEqual({ seatId: "ai1", instructions: "short reaction", fallback: "…thinking…" });
  });

  it("accepts a chatter request without fallback", () => {
    const data = expectData(
      experienceChatterRequestSchema.safeParse({ seatId: "ai1", instructions: "react" }),
    );
    expect(data).toEqual({ seatId: "ai1", instructions: "react" });
  });

  it("rejects a chatter request missing seatId or instructions", () => {
    expectReject(experienceChatterRequestSchema.safeParse({ instructions: "react" }));
    expectReject(experienceChatterRequestSchema.safeParse({ seatId: "ai1" }));
    expectReject(experienceChatterRequestSchema.safeParse({}));
  });

  it("rejects a chatter request with blank seatId", () => {
    expectReject(experienceChatterRequestSchema.safeParse({ seatId: "", instructions: "react" }));
  });

  it("rejects instructions exceeding the bounded string limit", () => {
    expectReject(
      experienceChatterRequestSchema.safeParse({
        seatId: "ai1",
        instructions: "x".repeat(INTERACTIVE_SCHEMA_MAX_STRING + 1),
      }),
    );
  });

  it("accepts a resolved chatter view with text and a failed view with fallback", () => {
    expectData(
      experienceChatterViewSchema.safeParse({
        status: "resolved",
        seatId: "ai1",
        text: "nice move!",
      }),
    );
    expectData(
      experienceChatterViewSchema.safeParse({
        status: "failed",
        seatId: "ai1",
        fallback: "…",
      }),
    );
  });

  it("rejects a chatter view with an unknown status or oversized text", () => {
    expectReject(experienceChatterViewSchema.safeParse({ status: "done", seatId: "ai1" }));
    expectReject(
      experienceChatterViewSchema.safeParse({
        status: "resolved",
        seatId: "ai1",
        text: "x".repeat(INTERACTIVE_SCHEMA_MAX_CHATTER_TEXT + 1),
      }),
    );
  });
});
