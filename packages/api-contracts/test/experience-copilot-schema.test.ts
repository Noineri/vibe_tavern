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
  copilotProfileCreateSchema,
  COPILOT_TOOL_KEYS,
  sidechatOocToolSetSchema,
  SIDECHAT_OOC_TOOL_KEYS,
  agentToolSetSchema,
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

describe("experienceCopilotStreamRequestSchema (ER-6)", () => {
  test("accepts a minimal request body", () => {
    const payload = { content: "hi", providerProfileId: "p1" };
    expect(experienceCopilotStreamRequestSchema.parse(payload)).toEqual({
      content: "hi",
      providerProfileId: "p1",
    });
  });

  test("preserves review metadata on a content request without defaulting absent fields", () => {
    const reviewSnapshot = {
      targets: [{
        target: "rules" as const,
        roundId: "a1b2c3",
        outcome: "applied" as const,
        hunks: { accepted: 2, rejected: 0, pending: 1 },
      }],
    };
    const parsed = experienceCopilotStreamRequestSchema.parse({
      content: "continue",
      providerProfileId: "p1",
      reviewSnapshot,
      rulesSaved: false,
      visualSaved: false,
    });
    expect(parsed).toEqual({
      content: "continue",
      providerProfileId: "p1",
      reviewSnapshot,
      rulesSaved: false,
      visualSaved: false,
    });
  });

  test("retains an explicit empty review snapshot on a content request", () => {
    expect(experienceCopilotStreamRequestSchema.parse({
      content: "continue",
      providerProfileId: "p1",
      reviewSnapshot: { targets: [] },
    })).toEqual({
      content: "continue",
      providerProfileId: "p1",
      reviewSnapshot: { targets: [] },
    });
  });

  test("accepts the Try sandbox launch context", () => {
    const launchContext = {
      participants: [
        { id: "you", label: "You", controller: "human" as const },
        { id: "bot", label: "Bot", controller: "script" as const },
      ],
      capabilityGrants: ["participants" as const],
      settings: { targetScore: 5 },
      seed: "round-seed",
      humanSeatId: "you",
    };

    expect(experienceCopilotStreamRequestSchema.parse({
      content: "test this",
      providerProfileId: "p1",
      launchContext,
    }).launchContext).toEqual(launchContext);
  });

  test("rejects an unknown launch-context capability", () => {
    expect(() => experienceCopilotStreamRequestSchema.parse({
      content: "test this",
      providerProfileId: "p1",
      launchContext: {
        participants: [],
        capabilityGrants: ["network"],
        settings: {},
      },
    })).toThrow();
  });

  // ─── SC-17: attached RP variants (the "discuss in the sidechat" wire arm) ───

  test("accepts attachedVariants as plain (messageId, variantId) pairs", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      content: "compare those takes",
      providerProfileId: "p1",
      attachedVariants: [
        { messageId: "msg_1", variantId: "mvar_1a" },
        { messageId: "msg_1", variantId: "mvar_1b" },
        { messageId: "msg_2", variantId: "mvar_2a" },
      ],
    });
    expect(parsed.attachedVariants).toEqual([
      { messageId: "msg_1", variantId: "mvar_1a" },
      { messageId: "msg_1", variantId: "mvar_1b" },
      { messageId: "msg_2", variantId: "mvar_2a" },
    ]);
  });

  test("a pair carrying a selected marker is rejected — the request can never set it (SC-17)", () => {
    // The pair schema is strict: `selected` is not a wire field. The server
    // reads the RP's own `message_variants.is_selected` at freeze time.
    expect(() => experienceCopilotStreamRequestSchema.parse({
      content: "compare those takes",
      providerProfileId: "p1",
      attachedVariants: [{ messageId: "msg_1", variantId: "mvar_1a", selected: true }],
    })).toThrow();
    expect(() => experienceCopilotStreamRequestSchema.parse({
      content: "compare those takes",
      providerProfileId: "p1",
      attachedVariants: [{ messageId: "", variantId: "mvar_1a" }],
    })).toThrow();
  });

  test("a 65-element attachedVariants array validates — the length cap is gone (SC-21b)", () => {
    // Was: `.max(64)` (SC-17) claimed to mirror the pinned-context links'
    // bound — which itself claimed to mirror the co-author's, and the
    // co-author has none. Now: the cap was invented provenance (no owner
    // decision set it), dropped by owner review 2026-10-21; attaching every
    // variant of a message with 65+ swipes must not fail validation.
    // Element validation is unchanged (still strict messageId/variantId).
    const pairs = Array.from({ length: 65 }, (_, i) => ({
      messageId: `msg_${i}`,
      variantId: `mvar_${i}`,
    }));
    const parsed = experienceCopilotStreamRequestSchema.parse({
      content: "compare every take",
      providerProfileId: "p1",
      attachedVariants: pairs,
    });
    expect(parsed.attachedVariants).toHaveLength(65);
    expect(parsed.attachedVariants?.[64]).toEqual({ messageId: "msg_64", variantId: "mvar_64" });
  });
});

// ─── TAG-5: split-turn answer mode on the stream request body ─────────────────

describe("experienceCopilotStreamRequestSchema — answer mode (TAG-5)", () => {
  const base = { providerProfileId: "p1" };

  test("answer-only is accepted (with text)", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", text: "make it blue" },
    });
    expect(parsed.answer).toEqual({ toolCallId: "tc_1", text: "make it blue" });
  });

  test("preserves review metadata on an answer request while keeping the nested answer strict", () => {
    const reviewSnapshot = {
      targets: [{
        target: "visual" as const,
        roundId: "d4e5f6",
        outcome: "applied-partial" as const,
      }],
    };
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", skipped: true },
      reviewSnapshot,
      rulesSaved: false,
      visualSaved: false,
    });
    expect(parsed).toEqual({
      ...base,
      answer: { toolCallId: "tc_1", skipped: true },
      reviewSnapshot,
      rulesSaved: false,
      visualSaved: false,
    });
    expect(() => experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", skipped: true, reviewSnapshot },
    })).toThrow();
  });

  test("answer-only is accepted (skip)", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", skipped: true },
    });
    expect(parsed.answer).toEqual({ toolCallId: "tc_1", skipped: true });
  });

  test("content + answer together are rejected (exactly-one mode)", () => {
    // AP-9 re-capture (was: /not both/) — the mode vocabulary grew to three
    // (content / answer / regenerate), so the multiple-modes refusal names
    // all three and says "only one".
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        content: "hi",
        answer: { toolCallId: "tc_1", text: "blue" },
      }),
    ).toThrow(/only one/);
  });

  test("neither content nor answer is rejected (exactly-one-of)", () => {
    expect(() => experienceCopilotStreamRequestSchema.parse(base)).toThrow(/either/);
  });

  test("a skipped answer carrying text is rejected", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_1", skipped: true, text: "but actually…" },
      }),
    ).toThrow(/skipped answer cannot carry text/i);
  });

  test("an answer with neither text nor skipped is rejected", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({ ...base, answer: { toolCallId: "tc_1" } }),
    ).toThrow(/either `text` or `skipped`/);
  });

  test("answer rejects unknown keys (strict) and empty toolCallId", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_1", text: "x", bogus: 1 },
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({ ...base, answer: { text: "x" } }),
    ).toThrow();
  });

  // ── SC-23e: the permission decision family joins the answer union ──

  test("a permission decision answer is accepted (allow and deny)", () => {
    const allow = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_perm_1", decision: "allow" },
    });
    expect(allow.answer).toEqual({ toolCallId: "tc_perm_1", decision: "allow" });
    const deny = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_perm_1", decision: "deny" },
    });
    expect(deny.answer).toEqual({ toolCallId: "tc_perm_1", decision: "deny" });
  });

  test("a permission decision rejects the ask family's fields and unknown decisions (strict)", () => {
    // `text`/`skipped` belong to the ask member — a permission body is
    // strict and carries neither.
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_perm_1", decision: "allow", text: "why not" },
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_perm_1", decision: "maybe" },
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({ ...base, answer: { decision: "allow" } }),
    ).toThrow();
  });
});

// ─── AP-9: regenerate mode joins the exclusive mode set ───────────────────────

describe("experienceCopilotStreamRequestSchema — regenerate mode (AP-9)", () => {
  const base = { providerProfileId: "p1" };

  test("regenerate-only is accepted", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      regenerate: true,
    });
    expect(parsed.regenerate).toBe(true);
  });

  test("regenerate rides along the other request fields like any mode", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      regenerate: true,
      rulesSaved: false,
      visualSaved: true,
    });
    expect(parsed.regenerate).toBe(true);
    expect(parsed.rulesSaved).toBe(false);
    expect(parsed.visualSaved).toBe(true);
  });

  test("an explicit regenerate:false is the absent mode — a content turn carrying it stays a content turn", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      regenerate: false,
      content: "hi",
    });
    expect(parsed.content).toBe("hi");
    expect(parsed.regenerate).toBe(false);
  });

  test("regenerate:false alone is rejected (no mode present)", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({ ...base, regenerate: false }),
    ).toThrow(/either/);
  });

  test("content + regenerate is rejected (exactly-one mode)", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        regenerate: true,
        content: "hi",
      }),
    ).toThrow(/only one/);
  });

  test("answer + regenerate is rejected (exactly-one mode)", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        regenerate: true,
        answer: { toolCallId: "tc_1", text: "blue" },
      }),
    ).toThrow(/only one/);
  });

  test("all three modes together are rejected", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        regenerate: true,
        content: "hi",
        answer: { toolCallId: "tc_1", skipped: true },
      }),
    ).toThrow(/only one/);
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
      todo: [],
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
      todo: [],
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("accepts a thread carrying a todo step-plan (TAG-6, restored PM-7)", () => {
    const payload = {
      id: "thread_004",
      scriptId: "script_abc",
      draftSessionId: null,
      title: "Plan",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      metrics: null,
      contextLinks: [],
      todo: [
        { title: "Write the rules buffer", status: "active" as const },
        { title: "Bind a visual", status: "pending" as const },
      ],
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a thread missing the todo field (required — TAG-6, restored PM-7)", () => {
    expect(() =>
      experienceCopilotThreadSchema.parse({
        id: "thread_005",
        scriptId: null,
        draftSessionId: null,
        title: "No todo",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metrics: null,
        contextLinks: [],
      }),
    ).toThrow();
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

  test("accepts plan/read_plan/ask_user booleans", () => {
    const payload = { plan: true, read_plan: true, ask_user: false };
    expect(copilotToolSetSchema.parse(payload)).toEqual(payload);
  });

  test("accepts todo/plan/read_plan together (PM-7 coexistence)", () => {
    // Owner ruling 2026-10-11: todo (the session checklist) and the plan
    // tools coexist — a profile may enable all three at once.
    const payload = { todo: true, plan: true, read_plan: true };
    expect(copilotToolSetSchema.parse(payload)).toEqual(payload);
  });

  test("COPILOT_TOOL_KEYS lists exactly the 9 toggleable tools (no read_skill_file)", () => {
    expect(COPILOT_TOOL_KEYS).toEqual([
      "write_buffer",
      "edit_buffer",
      "run_test",
      "run_simulate",
      "suggest_visual_binding",
      "plan",
      "read_plan",
      "todo",
      "ask_user",
    ]);
  });
});

// ─── SC-5: the sidechat-ooc tool set (keys before tools — the TAG-1 pattern) ──

describe("sidechatOocToolSetSchema (SIDECHAT_PLAN SC-5)", () => {
  test("accepts each of the 5 Wave-3 toggles with either boolean, and {} (all off)", () => {
    for (const key of SIDECHAT_OOC_TOOL_KEYS) {
      expect(sidechatOocToolSetSchema.parse({ [key]: true })).toEqual({ [key]: true });
      expect(sidechatOocToolSetSchema.parse({ [key]: false })).toEqual({ [key]: false });
    }
    expect(sidechatOocToolSetSchema.parse({})).toEqual({});
  });

  test("rejects the other kinds' keys and unknown keys (strict)", () => {
    // Experience keys, the script kind's key, and the always-on channel are
    // all foreign to the sidechat — rejected, never silently stripped.
    expect(() => sidechatOocToolSetSchema.parse({ write_buffer: true })).toThrow();
    expect(() => sidechatOocToolSetSchema.parse({ run_script_test: true })).toThrow();
    expect(() => sidechatOocToolSetSchema.parse({ read_skill_file: true })).toThrow();
    expect(() => sidechatOocToolSetSchema.parse({ search_contex: true })).toThrow();
  });

  test("SIDECHAT_OOC_TOOL_KEYS lists exactly the 6 toggles in definition order", () => {
    expect(SIDECHAT_OOC_TOOL_KEYS).toEqual([
      "search_context",
      "read_context_item",
      "propose_objective",
      "todo",
      "read_plan",
      "read_message_prompt",
    ]);
  });

  test("agentToolSetSchema carries the sidechat member: a sidechat set passes the union, a cross-kind mix fails", () => {
    expect(agentToolSetSchema.safeParse({ search_context: true, read_plan: false }).success).toBe(true);
    // Mixing sidechat and experience keys matches NO member — rejected.
    expect(
      agentToolSetSchema.safeParse({ search_context: true, write_buffer: true }).success,
    ).toBe(false);
    // The pre-existing members are untouched: experience and script sets
    // still pass, exactly as before the third member joined.
    expect(agentToolSetSchema.safeParse({ write_buffer: true }).success).toBe(true);
    expect(agentToolSetSchema.safeParse({ run_script_test: true }).success).toBe(true);
  });
});

// ─── CP-1: copilot profiles ─────────────────────────────────────────────

// ─── TAG-1 (restored PM-7): copilot todo schemas ──────────────────────────

describe("copilotTodoItemSchema (TAG-1, restored PM-7)", () => {
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

describe("copilotTodoListSchema (TAG-1, restored PM-7)", () => {
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
  test("accepts a valid profile (no description/openingMessage/skillIds)", () => {
    const payload = {
      id: "profile_1",
      name: "Card games",
      isBuiltIn: false,
      basePrompt: "You are a card-game experience author.",
      toolSet: { edit_buffer: true, run_test: true },
      // AS-3: profiles carry their owning kind.
      agentKind: "experience",
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
        toolSet: {},
        agentKind: "experience",
      }),
    ).toThrow();
  });

  // PM-8 (owner ruling 2026-10-12): `skillIds` is retired — skills are
  // ungated, so the field no longer exists. The schema is `.strict()`: a
  // stale client sending `skillIds` is rejected, not silently stripped.
  test("strict-rejects a retired skillIds payload (PM-8)", () => {
    const base = {
      id: "x",
      name: "X",
      isBuiltIn: false,
      basePrompt: "p",
      toolSet: {},
      agentKind: "experience",
    };
    expect(() => copilotProfileSchema.parse({ ...base, skillIds: ["experience-authoring"] })).toThrow();
    expect(() =>
      copilotProfileCreateSchema.parse({
        name: "X",
        basePrompt: "p",
        toolSet: {},
        skillIds: [],
      }),
    ).toThrow();
  });

  // maxSteps is REMOVED from the wire (TAG-10) and the schema is `.strict()`:
  // unknown keys are rejected outright (a payload carrying maxSteps throws,
  // never yielding a parsed object with the field).
  test("strict-rejects unknown keys incl. retired maxSteps (TAG-10)", () => {
    const base = {
      id: "x",
      name: "X",
      isBuiltIn: false,
      basePrompt: "p",
      toolSet: {},
      agentKind: "experience",
    };
    expect(() => copilotProfileSchema.parse({ ...base, maxSteps: 5 })).toThrow();
  });
});

// ─── CX-1: pinned-context links ─────────────────────────────────────────────

describe("experienceCopilotContextLinkSchema + setCopilotContextLinksSchema (CX-1)", () => {
  test("accepts all six target types including skill and prompt_preset (SC-23c)", () => {
    for (const targetType of ["character", "persona", "lorebook", "script", "skill", "prompt_preset"] as const) {
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

  test("set schema accepts a valid array and rejects extras; a 65-link body validates — the length cap is gone (SC-21b)", () => {
    const links = [{ targetType: "skill" as const, targetId: "my-skill" }];
    expect(setCopilotContextLinksSchema.parse({ links })).toEqual({ links });
    expect(() => setCopilotContextLinksSchema.parse({ links, extra: 1 })).toThrow();
    // Was: 65 links rejected (`.max(64)` claimed to mirror the co-author's
    // pragmatic bound — which never existed). Now: invented provenance,
    // dropped by owner review 2026-10-21; element validation is unchanged.
    const many = Array.from({ length: 65 }, () => links[0]);
    expect(setCopilotContextLinksSchema.parse({ links: many })).toEqual({ links: many });
  });
});

describe("experienceCopilotContextMetricsSchema (SC-0j kind-provided segments)", () => {
  const base = {
    systemTokens: 1000,
    digestTokens: 0,
    historyTokens: 500,
    attachedTokens: 0,
    totalTokens: 1500,
    budgetTokens: 16000,
    reserveTokens: 1000,
    source: "estimate" as const,
    measuredAt: "2026-10-18T00:00:00.000Z",
  };

  test("segments are absent by default (existing producers stay valid)", () => {
    const parsed = experienceCopilotContextMetricsSchema.parse(base);
    expect("segments" in parsed).toBe(false);
  });

  test("accepts a kind-provided segments array round-trip", () => {
    const segments = [
      { key: "cards_lore", tokens: 800 },
      { key: "rp_messages", tokens: 700 },
    ];
    expect(experienceCopilotContextMetricsSchema.parse({ ...base, segments }).segments).toEqual(segments);
  });

  test("rejects a segment with an empty key, fractional tokens, or an unknown key", () => {
    expect(() =>
      experienceCopilotContextMetricsSchema.parse({ ...base, segments: [{ key: "", tokens: 10 }] }),
    ).toThrow();
    expect(() =>
      experienceCopilotContextMetricsSchema.parse({ ...base, segments: [{ key: "lore", tokens: 1.5 }] }),
    ).toThrow();
    expect(() =>
      experienceCopilotContextMetricsSchema.parse(
        { ...base, segments: [{ key: "lore", tokens: 10, extra: 1 }] },
      ),
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
