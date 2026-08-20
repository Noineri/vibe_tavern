import { describe, test, expect } from "bun:test";
import {
  experienceCopilotTargetSchema,
  experienceCopilotToolOutputSchema,
  experienceCopilotStepSchema,
  experienceCopilotStreamRequestSchema,
  experienceCopilotThreadSchema,
  experienceCopilotMessageSchema,
  experienceCopilotBoundVisualSchema,
  experienceCopilotContextMetricsSchema,
  experienceCopilotContextLinkSchema,
  setCopilotContextLinksSchema,
  copilotTodoItemSchema,
  copilotTodoListSchema,
  copilotToolSetSchema,
  copilotProfileSchema,
  COPILOT_TOOL_KEYS,
} from "../src/schemas/experience-copilot-schema.js";

// ─── ER-4 / ER-6 regression pin (existing schemas unchanged) ──────────────────

describe("experienceCopilotTargetSchema (ER-4, unchanged)", () => {
  test("accepts the two named buffers", () => {
    expect(experienceCopilotTargetSchema.parse("rules")).toBe("rules");
    expect(experienceCopilotTargetSchema.parse("visual")).toBe("visual");
  });
  test("rejects an unknown buffer", () => {
    expect(() => experienceCopilotTargetSchema.parse("greeting")).toThrow();
  });
});

describe("experienceCopilotToolOutputSchema (ER-4, unchanged)", () => {
  test("accepts a full proposal triple", () => {
    const payload = { target: "rules" as const, proposed: "new text", summary: "rewrote" };
    expect(experienceCopilotToolOutputSchema.parse(payload)).toEqual(payload);
  });
  test("rejects a missing field", () => {
    expect(() =>
      experienceCopilotToolOutputSchema.parse({ target: "rules", proposed: "x" }),
    ).toThrow();
  });
});

describe("experienceCopilotStepSchema (ER-5, unchanged)", () => {
  test("accepts the three authoring steps", () => {
    expect(experienceCopilotStepSchema.parse("rules")).toBe("rules");
    expect(experienceCopilotStepSchema.parse("visual")).toBe("visual");
    expect(experienceCopilotStepSchema.parse("test")).toBe("test");
  });
});

describe("experienceCopilotStreamRequestSchema (ER-6, unchanged)", () => {
  test("accepts a minimal request body", () => {
    const payload = { content: "hi", providerProfileId: "p1" };
    expect(experienceCopilotStreamRequestSchema.parse(payload)).toEqual({
      content: "hi",
      providerProfileId: "p1",
    });
  });
});

// ─── ER-7: new thread / message / bound-visual schemas ─────────────────────────

describe("experienceCopilotThreadSchema (ER-7)", () => {
  test("accepts a valid active thread (archivedAt null)", () => {
    const payload = {
      id: "thread_001",
      scriptId: "script_abc",
      draftSessionId: null,
      title: "My experience",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      metrics: null,
      contextLinks: [],
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("accepts a valid archived thread (archivedAt ISO)", () => {
    const payload = {
      id: "thread_002",
      scriptId: null,
      draftSessionId: "sess_xyz",
      title: "Old draft",
      archivedAt: "2026-01-03T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      metrics: null,
      contextLinks: [],
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a thread missing the id field", () => {
    expect(() =>
      experienceCopilotThreadSchema.parse({
        scriptId: null,
        draftSessionId: null,
        title: "No id",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metrics: null,
      }),
    ).toThrow();
  });

  test("rejects a thread with a non-null number for a nullable field", () => {
    expect(() =>
      experienceCopilotThreadSchema.parse({
        id: "thread_003",
        scriptId: 123,
        draftSessionId: null,
        title: "Bad scriptId",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metrics: null,
      }),
    ).toThrow();
  });
});

// ─── CM-1: segmented context metrics schema ────────────────────────────────

describe("experienceCopilotContextMetricsSchema (CM-1)", () => {
  const valid = {
    systemTokens: 1000,
    digestTokens: 0,
    historyTokens: 500,
    attachedTokens: 0,
    totalTokens: 1500,
    budgetTokens: 16000,
    reserveTokens: 1000,
    source: "estimate" as const,
    measuredAt: "2026-06-15T00:00:00.000Z",
  };

  test("accepts a valid estimate-sourced metrics object", () => {
    expect(experienceCopilotContextMetricsSchema.parse(valid)).toEqual(valid);
  });

  test("accepts source: provider", () => {
    expect(experienceCopilotContextMetricsSchema.parse({ ...valid, source: "provider" }).source).toBe("provider");
  });

  test("rejects an unknown source (source union is closed)", () => {
    expect(() => experienceCopilotContextMetricsSchema.parse({ ...valid, source: "measured" })).toThrow();
  });

  test("rejects an unknown key (strict)", () => {
    expect(() => experienceCopilotContextMetricsSchema.parse({ ...valid, extra: 1 })).toThrow();
  });

  test("rejects a fractional token count (all plain ints)", () => {
    expect(() => experienceCopilotContextMetricsSchema.parse({ ...valid, totalTokens: 1.5 })).toThrow();
  });
});

describe("experienceCopilotMessageSchema (ER-7)", () => {
  test("accepts a valid assistant message (tool fields null)", () => {
    const payload = {
      id: "msg_001",
      threadId: "thread_001",
      role: "assistant",
      content: "Hello!",
      toolCallsJson: null,
      toolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(experienceCopilotMessageSchema.parse(payload)).toEqual(payload);
  });

  test("accepts a valid tool-call message (tool fields present)", () => {
    const payload = {
      id: "msg_002",
      threadId: "thread_001",
      role: "assistant",
      content: "",
      toolCallsJson: '[{"id":"call_1","name":"write_buffer"}]',
      toolCallId: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    expect(experienceCopilotMessageSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a message with createdAt as a number", () => {
    expect(() =>
      experienceCopilotMessageSchema.parse({
        id: "msg_003",
        threadId: "thread_001",
        role: "user",
        content: "hi",
        toolCallsJson: null,
        toolCallId: null,
        createdAt: 1735689600000,
      }),
    ).toThrow();
  });

  test("rejects a message missing the threadId field", () => {
    expect(() =>
      experienceCopilotMessageSchema.parse({
        id: "msg_004",
        role: "user",
        content: "hi",
        toolCallsJson: null,
        toolCallId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("experienceCopilotBoundVisualSchema (ER-7)", () => {
  test("accepts a valid bound-visual descriptor", () => {
    const payload = { id: "vis_001", name: "Battle HUD", kind: "visual" };
    expect(experienceCopilotBoundVisualSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a bound visual missing the kind field", () => {
    expect(() =>
      experienceCopilotBoundVisualSchema.parse({ id: "vis_002", name: "Panel" }),
    ).toThrow();
  });

  test("rejects a bound visual with a non-string name", () => {
    expect(() =>
      experienceCopilotBoundVisualSchema.parse({ id: "vis_003", name: 42, kind: "visual" }),
    ).toThrow();
  });
});

// ─── CP-1: copilot toolset + profile schemas ────────────────────────────────

describe("copilotToolSetSchema (CP-1)", () => {
  test("accepts all 5 toggleable tools", () => {
    const payload = {
      write_buffer: true,
      edit_buffer: true,
      run_test: false,
      run_simulate: true,
      suggest_visual_binding: false,
    };
    expect(copilotToolSetSchema.parse(payload)).toEqual(payload);
  });

  test("accepts an empty toolSet (all tools off)", () => {
    expect(copilotToolSetSchema.parse({})).toEqual({});
  });

  test("rejects an unknown key (typo safety)", () => {
    expect(() => copilotToolSetSchema.parse({ writ_buffer: true })).toThrow();
  });

  test("rejects read_skill_file (always-on, not toggleable)", () => {
    expect(() => copilotToolSetSchema.parse({ read_skill_file: true })).toThrow();
  });

  test("accepts todo/ask_user booleans (TAG-1)", () => {
    const payload = { todo: true, ask_user: false };
    expect(copilotToolSetSchema.parse(payload)).toEqual(payload);
  });

  test("COPILOT_TOOL_KEYS lists exactly the 7 toggleable tools (no read_skill_file)", () => {
    expect(COPILOT_TOOL_KEYS).toEqual([
      "write_buffer",
      "edit_buffer",
      "run_test",
      "run_simulate",
      "suggest_visual_binding",
      "todo",
      "ask_user",
    ]);
  });
});

// ─── TAG-1: copilot todo schemas ─────────────────────────────────────────────

describe("copilotTodoItemSchema (TAG-1)", () => {
  test("accepts a valid item in each status", () => {
    for (const status of ["pending", "active", "completed", "abandoned"] as const) {
      const payload = { title: "Write the reduce loop", status };
      expect(copilotTodoItemSchema.parse(payload)).toEqual(payload);
    }
  });

  test("rejects an unknown status", () => {
    expect(() => copilotTodoItemSchema.parse({ title: "x", status: "in_progress" })).toThrow();
  });

  test("rejects an empty title", () => {
    expect(() => copilotTodoItemSchema.parse({ title: "", status: "pending" })).toThrow();
  });

  test("rejects an oversized title (cap 200)", () => {
    expect(() => copilotTodoItemSchema.parse({ title: "y".repeat(201), status: "pending" })).toThrow();
  });

  test("rejects an unknown key (strict)", () => {
    expect(() => copilotTodoItemSchema.parse({ title: "x", status: "pending", done: true })).toThrow();
  });
});

describe("copilotTodoListSchema (TAG-1)", () => {
  const item = { title: "step", status: "active" as const };

  test("accepts a list at the cap (30 items)", () => {
    const list = Array.from({ length: 30 }, () => item);
    expect(copilotTodoListSchema.parse(list).length).toBe(30);
  });

  test("rejects a list over the cap (31 items)", () => {
    const list = Array.from({ length: 31 }, () => item);
    expect(() => copilotTodoListSchema.parse(list)).toThrow();
  });
});

describe("copilotProfileSchema (CP-1)", () => {
  test("accepts a valid profile (no description/openingMessage)", () => {
    const payload = {
      id: "profile_1",
      name: "Card games",
      isBuiltIn: false,
      basePrompt: "You are a card-game experience author.",
      skillIds: ["experience-authoring"],
      toolSet: { edit_buffer: true, run_test: true },
      maxSteps: 20,
    };
    expect(copilotProfileSchema.parse(payload)).toEqual(payload);
  });

  test("rejects empty basePrompt (inline text required)", () => {
    expect(() =>
      copilotProfileSchema.parse({
        id: "x",
        name: "X",
        isBuiltIn: false,
        basePrompt: "",
        skillIds: [],
        toolSet: {},
        maxSteps: 20,
      }),
    ).toThrow();
  });

  test("rejects maxSteps out of bounds", () => {
    const base = {
      id: "x",
      name: "X",
      isBuiltIn: false,
      basePrompt: "p",
      skillIds: [],
      toolSet: {},
    };
    expect(() => copilotProfileSchema.parse({ ...base, maxSteps: 0 })).toThrow();
    expect(() => copilotProfileSchema.parse({ ...base, maxSteps: 51 })).toThrow();
  });
});

// ─── CX-1: pinned-context links ─────────────────────────────────────────────

describe("experienceCopilotContextLinkSchema + setCopilotContextLinksSchema (CX-1)", () => {
  test("accepts all five target types including skill", () => {
    for (const targetType of ["character", "persona", "lorebook", "script", "skill"] as const) {
      expect(experienceCopilotContextLinkSchema.parse({ targetType, targetId: "id_1" })).toEqual({
        targetType,
        targetId: "id_1",
      });
    }
  });

  test("rejects an unknown targetType and an empty/oversized targetId", () => {
    expect(() => experienceCopilotContextLinkSchema.parse({ targetType: "emoji", targetId: "x" })).toThrow();
    expect(() => experienceCopilotContextLinkSchema.parse({ targetType: "character" })).toThrow();
    expect(() => experienceCopilotContextLinkSchema.parse({ targetType: "character", targetId: "" })).toThrow();
    expect(() =>
      experienceCopilotContextLinkSchema.parse({ targetType: "character", targetId: "y".repeat(201) }),
    ).toThrow();
  });

  test("set schema accepts a valid array and rejects extras/oversize", () => {
    const links = [{ targetType: "skill" as const, targetId: "my-skill" }];
    expect(setCopilotContextLinksSchema.parse({ links })).toEqual({ links });
    expect(() => setCopilotContextLinksSchema.parse({ links, extra: 1 })).toThrow();
    expect(() =>
      setCopilotContextLinksSchema.parse({ links: Array.from({ length: 65 }, () => links[0]) }),
    ).toThrow();
  });
});

describe("experienceCopilotContextMetricsSchema (CX-1 additions)", () => {
  test("requires attachedTokens (strict)", () => {
    const base = {
      systemTokens: 1000,
      digestTokens: 0,
      historyTokens: 500,
      totalTokens: 1500,
      budgetTokens: 16000,
      reserveTokens: 1000,
      source: "estimate" as const,
      measuredAt: "2026-08-18T00:00:00.000Z",
    };
    expect(() => experienceCopilotContextMetricsSchema.parse(base)).toThrow();
    expect(
      experienceCopilotContextMetricsSchema.parse({ ...base, attachedTokens: 42 }).attachedTokens,
    ).toBe(42);
  });
});;
