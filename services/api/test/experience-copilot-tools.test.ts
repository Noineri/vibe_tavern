import { describe, test, expect } from "bun:test";
import { buildExperienceCopilotTools } from "../src/domain/interactive/copilot/experience-copilot-tools.js";

/**
 * Experience-Copilot tools propose rules/visual edits and run read-only tests;
 * they never write to a store. These tests pin the proposing contract
 * (write_buffer/edit_buffer), the rules-validation guard, the read-only digests
 * (run_test), and the ToolSet shape + gating — mirroring coauthor-tools.test.ts.
 *
 * The second execute() argument (the AI-SDK tool-call context) is ignored by
 * every tool here, so a stub cast `as never` suffices (matches coauthor test).
 */

/** A minimal VALID experience rules script (counter) — discover + create +
 *  project + legal actions all succeed. Adapted from experience-kernel.test.ts. */
const VALID_RULES = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter" },
  capabilities: [],
  create(context, settings) {
    const start = (settings && typeof settings.start === "number") ? settings.start : 0;
    return { count: start };
  },
  project(context, viewer) { return { count: context.state.count }; },
  actions(context, viewer) { return [{ type: "increment", label: "+" }, { type: "reset" }]; },
  reduce(context, action) {
    if (action.type === "increment") return { state: { count: context.state.count + 1 }, status: "active", events: [] };
    if (action.type === "reset") return { state: { count: 0 }, status: "completed", events: [] };
    return { state: context.state, status: "active", events: [] };
  },
});
`;

/** Rules with a JS syntax error — discovery fails before registration. */
const SYNTAX_ERROR_RULES = "context.experience.register({ this is broken {{{";

/** Rules that register but are missing mandatory methods (project/actions/reduce). */
const MISSING_METHOD_RULES = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "x", name: "X" },
  capabilities: [],
  create() { return {}; },
});
`;

/** Shared tool-execution context stub (the tools ignore it). */
const ctx = { messages: [], toolCallId: "t", abort: () => {} } as never;

/** Minimal view of a built tool exposing its zod input schema for direct
 *  validation assertions — the AI SDK validates `inputSchema` at tool-call time
 *  and `execute` receives already-validated args, so cap/status/enum/recommended
 *  rejections are asserted against the schema, not through execute. */
interface ToolSchemaProbe {
  inputSchema: { safeParse(value: unknown): { success: boolean } };
}

describe("experience-copilot-tools: write_buffer (rules)", () => {
  test("valid rules → returns { target, proposed, summary } and advances the working buffer", async () => {
    const tools = buildExperienceCopilotTools();
    const out = (await tools.write_buffer.execute(
      { target: "rules", content: VALID_RULES, summary: "Initial rules." },
      ctx,
    )) as never;

    expect(out.target).toBe("rules");
    expect(out.summary).toBe("Initial rules.");
    // proposed echoes the content verbatim (no canonicalization for rules).
    expect(out.proposed).toBe(VALID_RULES);

    // The working buffer advanced: a later edit_buffer searching the written
    // content succeeds, proving workingRules == the written source.
    const edited = (await tools.edit_buffer.execute(
      {
        target: "rules",
        edits: [{ search: 'manifest: { id: "counter"', replace: 'manifest: { id: "renamed"' }],
        summary: "Rename.",
      },
      ctx,
    )) as never;
    expect(edited.proposed).toContain('manifest: { id: "renamed"');
  });

  test("rejects empty content", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(
      tools.write_buffer.execute({ target: "rules", content: "   ", summary: "x" }, ctx),
    ).rejects.toThrow(/empty/);
  });
});

describe("experience-copilot-tools: write_buffer rules-validation guard", () => {
  test("a syntactically-bad rules proposal throws (model would self-correct)", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(
      tools.write_buffer.execute(
        { target: "rules", content: SYNTAX_ERROR_RULES, summary: "bad" },
        ctx,
      ),
    ).rejects.toThrow(/write_buffer: proposed rules failed validation/);
  });

  test("a missing-method rules proposal throws naming the typed error", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(
      tools.write_buffer.execute(
        { target: "rules", content: MISSING_METHOD_RULES, summary: "bad" },
        ctx,
      ),
    ).rejects.toThrow(/write_buffer: proposed rules failed validation/);
  });

  test("a rejected proposal does NOT advance the buffer (non-poisoning)", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(
      tools.write_buffer.execute(
        { target: "rules", content: SYNTAX_ERROR_RULES, summary: "bad" },
        ctx,
      ),
    ).rejects.toThrow(/failed validation/);
    // The buffer is still empty: a valid write_buffer (first mutation) succeeds.
    const out = (await tools.write_buffer.execute(
      { target: "rules", content: VALID_RULES, summary: "ok" },
      ctx,
    )) as never;
    expect(out.target).toBe("rules");
  });
});

describe("experience-copilot-tools: write_buffer first-mutation guard", () => {
  test("a second whole-buffer rules rewrite is rejected; edit_buffer still works", async () => {
    const tools = buildExperienceCopilotTools();
    await tools.write_buffer.execute(
      { target: "rules", content: VALID_RULES, summary: "first" },
      ctx,
    );
    await expect(
      tools.write_buffer.execute(
        { target: "rules", content: VALID_RULES, summary: "second" },
        ctx,
      ),
    ).rejects.toThrow(/FIRST rules change/);
    // edit_buffer composes on the committed buffer.
    const edited = (await tools.edit_buffer.execute(
      { target: "rules", edits: [{ search: "Counter", replace: "Tally" }], summary: "rename" },
      ctx,
    )) as never;
    expect(edited.proposed).toContain("Tally");
  });
});

describe("experience-copilot-tools: write_buffer (visual, no validation)", () => {
  test("any content is accepted (no validator exists)", async () => {
    const tools = buildExperienceCopilotTools();
    const out = (await tools.write_buffer.execute(
      { target: "visual", content: "<div>hello</div>", summary: "v" },
      ctx,
    )) as never;
    expect(out.target).toBe("visual");
    expect(out.proposed).toBe("<div>hello</div>");
  });

  test("a second whole-buffer visual rewrite is rejected", async () => {
    const tools = buildExperienceCopilotTools();
    await tools.write_buffer.execute(
      { target: "visual", content: "<a/>", summary: "first" },
      ctx,
    );
    await expect(
      tools.write_buffer.execute(
        { target: "visual", content: "<b/>", summary: "second" },
        ctx,
      ),
    ).rejects.toThrow(/FIRST visual change/);
  });
});

describe("experience-copilot-tools: edit_buffer", () => {
  test("exact edits compose on a seeded buffer and return the proposed rules", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES });
    const out = (await tools.edit_buffer.execute(
      {
        target: "rules",
        edits: [{ search: 'id: "counter", name: "Counter"', replace: 'id: "counter", name: "Tally"' }],
        summary: "Rename.",
      },
      ctx,
    )) as never;
    expect(out.target).toBe("rules");
    expect(out.proposed).toContain('name: "Tally"');
    // Validation passed (still valid rules) — the result is a valid proposal.
  });

  test("edit_buffer rejects when no buffer exists in the working state", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(
      tools.edit_buffer.execute(
        { target: "rules", edits: [{ search: "x", replace: "y" }], summary: "s" },
        ctx,
      ),
    ).rejects.toThrow(/use write_buffer to set the buffer first/);
  });

  test("edit_buffer that produces invalid rules throws the validation error", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES });
    // Replace the registration with a syntax-broken variant.
    await expect(
      tools.edit_buffer.execute(
        {
          target: "rules",
          edits: [{ search: "context.experience.register({", replace: "context.experience.register({ !!broken" }],
          summary: "break",
        },
        ctx,
      ),
    ).rejects.toThrow(/edit_buffer: proposed rules failed validation/);
    // The buffer is untouched (atomic on failure): a valid edit still applies.
    const ok = (await tools.edit_buffer.execute(
      {
        target: "rules",
        edits: [{ search: "Counter", replace: "Tally" }],
        summary: "ok",
      },
      ctx,
    )) as never;
    expect(ok.proposed).toContain("Tally");
  });
});

describe("experience-copilot-tools: run_test (read-only digest)", () => {
  test("on valid rules returns an ok digest with legal action types and does NOT mutate the buffer", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES });
    const digest = (await tools.run_test.execute({}, ctx)) as never;

    expect(digest.ok).toBe(true);
    expect(digest.status).toBe("active");
    expect(digest.revision).toBe(0);
    expect(digest.legalActionTypes).toEqual(["increment", "reset"]);
    expect(digest.stateSummary).toContain("count");
    // Read-only: the buffer is unchanged — a search for original content still
    // applies via edit_buffer (run_test did not mutate workingRules).
    const edited = (await tools.edit_buffer.execute(
      { target: "rules", edits: [{ search: "Counter", replace: "Tally" }], summary: "after-run" },
      ctx,
    )) as never;
    expect(edited.proposed).toContain("Tally");
  });

  test("on invalid (seeded) rules returns a structured error digest (ok:false)", async () => {
    const tools = buildExperienceCopilotTools({ rules: SYNTAX_ERROR_RULES });
    const digest = (await tools.run_test.execute({}, ctx)) as never;

    expect(digest.ok).toBe(false);
    expect(typeof digest.errorCode).toBe("string");
    expect(digest.errorCode.length).toBeGreaterThan(0);
    expect(typeof digest.errorMessage).toBe("string");
  });

  test("throws when no rules buffer exists", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(tools.run_test.execute({}, ctx)).rejects.toThrow(/no rules buffer/);
  });
});

describe("experience-copilot-tools: run_simulate (read-only digest)", () => {
  test("on valid rules returns a digest with a stop reason and iteration count", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES });
    const digest = (await tools.run_simulate.execute({}, ctx)) as never;
    // With no participants the simulation finds no actor → no_legal_action.
    expect(digest.ok).toBe(true);
    expect(typeof digest.stopReason).toBe("string");
    expect(typeof digest.iterations).toBe("number");
  });
});

describe("experience-copilot-tools: suggest_visual_binding", () => {
  test("returns a non-binding suggestion echoing the reason and optional id", async () => {
    const tools = buildExperienceCopilotTools();
    const withId = (await tools.suggest_visual_binding.execute(
      { reason: "A scoreboard visual fits this counter.", visualId: "vis-1" },
      ctx,
    )) as never;
    expect(withId.suggestedVisualId).toBe("vis-1");
    expect(withId.reason).toBe("A scoreboard visual fits this counter.");

    const withoutId = (await tools.suggest_visual_binding.execute(
      { reason: "Consider a visual." },
      ctx,
    )) as never;
    expect(withoutId.suggestedVisualId).toBeUndefined();
    expect(withoutId.reason).toBe("Consider a visual.");
  });
});

describe("experience-copilot-tools: todo (full-list rewrite + saveTodo)", () => {
  test("full-list rewrite — second call fully replaces the list and returns the summary", async () => {
    const calls: { title: string; status: string }[][] = [];
    const tools = buildExperienceCopilotTools({
      saveTodo: async (items) => {
        calls.push(items.map((i) => ({ title: i.title, status: i.status })));
      },
    });

    const first = [
      { title: "scaffold the mini-app", status: "pending" },
      { title: "wire the reducer", status: "active" },
    ];
    const second = [{ title: "bind the visual", status: "active" }];

    const r1 = (await tools.todo.execute({ items: first }, ctx)) as never;
    const r2 = (await tools.todo.execute({ items: second }, ctx)) as never;

    expect(r1.ok).toBe(true);
    expect(r1.activeTitle).toBe("wire the reducer");
    expect(r1.remaining).toBe(2);
    expect(r2.ok).toBe(true);
    expect(r2.activeTitle).toBe("bind the visual");
    expect(r2.remaining).toBe(1);
    // saveTodo saw exactly two full-list writes; the last is the replacement.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([{ title: "bind the visual", status: "active" }]);
  });

  test("saveTodo failure returns ok:false envelope (does NOT throw)", async () => {
    const tools = buildExperienceCopilotTools({
      saveTodo: async () => {
        throw new Error("db down");
      },
    });
    const r = (await tools.todo.execute({ items: [{ title: "a", status: "pending" }] }, ctx)) as never;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).toContain("db down");
  });

  test("throws when no saveTodo writer is wired (precondition miss)", async () => {
    const tools = buildExperienceCopilotTools();
    await expect(tools.todo.execute({ items: [{ title: "a", status: "pending" }] }, ctx)).rejects.toThrow(
      /no todo writer wired/,
    );
  });

  test("input schema rejects a list over the 30-item cap", () => {
    const tools = buildExperienceCopilotTools({ saveTodo: async () => {} }) as unknown as {
      todo: ToolSchemaProbe;
    };
    const items = Array.from({ length: 31 }, (_, i) => ({ title: `step ${i}`, status: "pending" }));
    expect(tools.todo.inputSchema.safeParse({ items }).success).toBe(false);
  });

  test("input schema is an OBJECT root `{items}` — bare arrays and `{}` are rejected (2026-08-21 incident pin)", () => {
    // Incident: a bare-array root made the model emit `{}` three times in a
    // row — tool-calling arguments are JSON objects, so every call failed
    // "expected array, received object" and the turn died. The object root is
    // the model-friendly contract; the pin guards against re-flattening it.
    const tools = buildExperienceCopilotTools({ saveTodo: async () => {} }) as unknown as {
      todo: ToolSchemaProbe;
    };
    expect(tools.todo.inputSchema.safeParse([{ title: "a", status: "pending" }]).success).toBe(false);
    expect(tools.todo.inputSchema.safeParse({}).success).toBe(false);
    expect(tools.todo.inputSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      tools.todo.inputSchema.safeParse({ items: [{ title: "a", status: "active" }] }).success,
    ).toBe(true);
  });

  test("input schema rejects an invalid status", () => {
    const tools = buildExperienceCopilotTools({ saveTodo: async () => {} }) as unknown as {
      todo: ToolSchemaProbe;
    };
    expect(tools.todo.inputSchema.safeParse({ items: [{ title: "a", status: "in-progress" }] }).success).toBe(false);
  });
});

describe("experience-copilot-tools: ask_user (awaiting marker)", () => {
  test("returns awaiting_answer carrying question/options/recommended verbatim", async () => {
    const tools = buildExperienceCopilotTools();
    const r = (await tools.ask_user.execute(
      { question: "Which layout?", options: ["tabs", "accordion"], recommended: "tabs" },
      ctx,
    )) as never;
    expect(r.status).toBe("awaiting_answer");
    expect(r.question).toBe("Which layout?");
    expect(r.options).toEqual(["tabs", "accordion"]);
    expect(r.recommended).toBe("tabs");
  });

  test("free-text question (no options) returns no options/recommended", async () => {
    const tools = buildExperienceCopilotTools();
    const r = (await tools.ask_user.execute({ question: "What should the win condition be?" }, ctx)) as never;
    expect(r.status).toBe("awaiting_answer");
    expect(r.question).toBe("What should the win condition be?");
    expect(r.options).toBeUndefined();
    expect(r.recommended).toBeUndefined();
  });

  test("input schema rejects recommended not in options", () => {
    const tools = buildExperienceCopilotTools() as unknown as { ask_user: ToolSchemaProbe };
    expect(
      tools.ask_user.inputSchema.safeParse({ question: "q", options: ["A", "B"], recommended: "C" }).success,
    ).toBe(false);
  });

  test("input schema rejects recommended without options", () => {
    const tools = buildExperienceCopilotTools() as unknown as { ask_user: ToolSchemaProbe };
    expect(tools.ask_user.inputSchema.safeParse({ question: "q", recommended: "A" }).success).toBe(false);
  });

  test("input schema rejects more than 6 options", () => {
    const tools = buildExperienceCopilotTools() as unknown as { ask_user: ToolSchemaProbe };
    expect(
      tools.ask_user.inputSchema.safeParse({
        question: "q",
        options: ["1", "2", "3", "4", "5", "6", "7"],
      }).success,
    ).toBe(false);
  });
});

describe("experience-copilot-tools: todo/ask_user gating", () => {
  test("absent/disabled toolSet drops todo and ask_user", () => {
    const tools = buildExperienceCopilotTools({ toolSet: { run_test: true } }) as unknown as Record<
      string,
      unknown
    >;
    expect(tools.todo).toBeUndefined();
    expect(tools.ask_user).toBeUndefined();
  });

  test("enabled toolSet includes todo and ask_user, keeps read_skill_file", () => {
    const tools = buildExperienceCopilotTools({ toolSet: { todo: true, ask_user: true } }) as unknown as Record<
      string,
      unknown
    >;
    expect(tools.todo).toBeDefined();
    expect(tools.ask_user).toBeDefined();
    expect(tools.run_test).toBeUndefined();
    expect(tools.read_skill_file).toBeDefined();
  });
});

describe("experience-copilot-tools: ToolSet shape + gating", () => {
  test("all eight tools are present by default", () => {
    const tools = buildExperienceCopilotTools() as unknown as Record<string, unknown>;
    expect(tools.write_buffer).toBeDefined();
    expect(tools.edit_buffer).toBeDefined();
    expect(tools.run_test).toBeDefined();
    expect(tools.run_simulate).toBeDefined();
    expect(tools.suggest_visual_binding).toBeDefined();
    expect(tools.todo).toBeDefined();
    expect(tools.ask_user).toBeDefined();
    // read_skill_file is always included (reused from the Co-Author skill system).
    expect(tools.read_skill_file).toBeDefined();
    expect(Object.keys(tools).sort()).toEqual(
      ["ask_user", "edit_buffer", "read_skill_file", "run_simulate", "run_test", "suggest_visual_binding", "todo", "write_buffer"],
    );
  });

  test("toolSet gating drops a disabled tool but keeps read_skill_file", () => {
    const tools = buildExperienceCopilotTools({
      toolSet: { write_buffer: true, run_test: false },
    }) as unknown as Record<string, unknown>;
    expect(tools.write_buffer).toBeDefined();
    expect(tools.run_test).toBeUndefined();
    expect(tools.edit_buffer).toBeUndefined();
    expect(tools.read_skill_file).toBeDefined();
  });

  test("toolSet gating filters the authoring/diagnostic tools independently", () => {
    const tools = buildExperienceCopilotTools({
      toolSet: { run_test: true, run_simulate: true },
    }) as unknown as Record<string, unknown>;
    expect(tools.run_test).toBeDefined();
    expect(tools.run_simulate).toBeDefined();
    expect(tools.write_buffer).toBeUndefined();
    expect(tools.edit_buffer).toBeUndefined();
    expect(tools.suggest_visual_binding).toBeUndefined();
    // read_skill_file is always on regardless of toolSet.
    expect(tools.read_skill_file).toBeDefined();
  });
});
