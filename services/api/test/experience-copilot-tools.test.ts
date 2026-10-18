import { describe, test, expect } from "bun:test";
import {
  buildExperienceCopilotTools,
  type ExperienceCopilotRunSimulateDigest,
  type ExperienceCopilotRunTestDigest,
} from "../src/domain/interactive/copilot/experience-copilot-tools.js";
import type { ExperienceCopilotTodoResult } from "../src/domain/interactive/copilot/copilot-todo-tool.js";

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

/** The report's corrected reference Round (P3.7): proposal validation must
 *  accept the same participants-based example the copilot is told to author. */
const REFERENCE_ROUND_RULES = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "round", name: "Round" },
  capabilities: [{ capability: "participants", reason: "per-player turns and scores" }],
  create(context) {
    var ids = context.participants.map(function (p) { return p.id; });
    var names = context.participants.map(function (p) { return p.label || p.id; });
    return { round: 1, turn: 0, ids: ids, names: names, scores: ids.map(function () { return 0; }) };
  },
  project(context) {
    var s = context.state;
    return {
      round: s.round,
      activePlayer: s.names[s.turn] || s.names[0],
      scores: s.scores.slice(),
      names: s.names.slice()
    };
  },
  actions(context, viewer) {
    var s = context.state;
    if (!viewer || viewer.participantId !== s.ids[s.turn]) return [];
    return [
      { type: "score", label: "Score" },
      { type: "pass", label: "Pass turn" }
    ];
  },
  choose(context) {
    var s = context.state;
    return { type: s.scores[s.turn] < s.round ? "score" : "pass" };
  },
  reduce(context, action) {
    var s = context.state;
    if (action.participantId !== s.ids[s.turn]) {
      return { state: s, status: "active", events: [] };
    }
    if (action.type === "score") {
      var scores = s.scores.slice(); scores[s.turn] += 1;
      return { state: { round: s.round, turn: s.turn, ids: s.ids, names: s.names, scores: scores }, status: "active", events: [{ visibility: "public", type: "scored" }] };
    }
    if (action.type === "pass") {
      var next = (s.turn + 1) % s.ids.length;
      var round = next === 0 ? s.round + 1 : s.round;
      return { state: { round: round, turn: next, ids: s.ids, names: s.names, scores: s.scores.slice() }, status: "active", events: [{ visibility: "public", type: "turn_passed" }] };
    }
    return { state: s, status: "active", events: [] };
  }
});
`;

/** A two-seat-capable round that exposes settings/seed use in projected state
 *  and can start on the script seat without changing roster order. */
const GROUNDED_ROUND_RULES = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "grounded_round", name: "Grounded Round" },
  capabilities: [
    { capability: "participants", reason: "turn owners" },
    { capability: "deterministic_random", reason: "seeded opening" }
  ],
  create(context, settings) {
    var ids = context.participants.map(function (participant) { return participant.id; });
    return {
      turn: settings && settings.botFirst ? "bot" : ids[0],
      ids: ids,
      marker: settings && settings.marker ? settings.marker : null,
      roll: context.random.int(0, 1000000000)
    };
  },
  project(context) { return context.state; },
  actions(context, viewer) {
    return viewer && viewer.participantId === context.state.turn ? [{ type: "pass" }] : [];
  },
  choose(context, { legal }) { return legal[0]; },
  reduce(context, action) {
    return {
      state: {
        turn: action.participantId === "bot" ? "you" : "bot",
        ids: context.state.ids,
        marker: context.state.marker,
        roll: context.state.roll
      },
      status: "active",
      events: []
    };
  }
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

/** AS-8e7b no-caps fixture (owner 2026-10-18: the assistant sees everything
 *  the script produced — no invented economies): create() logs 30 console
 *  lines and returns a state whose JSON runs past 2 000 chars, so a digest
 *  that still capped either would visibly drop content. */
const VERBOSE_RULES = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "verbose", name: "Verbose" },
  capabilities: [],
  create() {
    for (var i = 1; i <= 30; i++) {
      console.log("boot line " + i);
    }
    var chunk = "";
    for (var j = 0; j < 25; j++) {
      chunk = chunk + "0123456789abcdefghij"; // 25 × 20 = 500-char chunk
    }
    var blob = "";
    for (var k = 0; k < 5; k++) {
      blob = blob + chunk; // 5 × 500 = 2 500 chars → state JSON ≈ 2.5 KB
    }
    return { blob: blob, marker: "verbose-state" };
  },
  project(context) { return context.state; },
  actions() { return [{ type: "noop", label: "No-op" }]; },
  reduce(context) { return { state: context.state, status: "active", events: [] }; },
});
`;

/** The exact 2 500-char blob VERBOSE_RULES' create() builds (the chunk string
 *  repeated 125 times) — lets the no-caps pin assert stateSummary is the
 *  COMPLETE JSON.stringify of the projected state, not a capped prefix. */
const VERBOSE_BLOB = "0123456789abcdefghij".repeat(125);

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
    ).rejects.toThrow(
      /write_buffer: proposed rules failed validation .*launchContext=\{"source":"derived","seats":\[\{"id":"you","controller":"human"\}\],"grants":\[\]\}/,
    );
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

  test("the corrected reference Round passes proposal validation under the derived launch context", async () => {
    const tools = buildExperienceCopilotTools();
    const out = await tools.write_buffer.execute(
      { target: "rules", content: REFERENCE_ROUND_RULES, summary: "Reference Round" },
      ctx,
    );
    expect(out).toMatchObject({ target: "rules", proposed: REFERENCE_ROUND_RULES });
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

  test("returns the WHOLE 30-entry console and the FULL state JSON — no caps (AS-8e7b)", async () => {
    // Owner 2026-10-18: the assistant sees everything the script produced.
    // The old caps kept the last 20 console entries and 1 500 state chars.
    const tools = buildExperienceCopilotTools({ rules: VERBOSE_RULES });
    const digest = await tools.run_test.execute({}, ctx) as ExperienceCopilotRunTestDigest;

    expect(digest.ok).toBe(true);
    // All 30 create() console lines, in order — no 20-entry tail.
    expect(digest.consoleTail).toEqual(
      Array.from({ length: 30 }, (_, i) => `log: boot line ${i + 1}`),
    );
    // The ~2.5 KB state JSON comes back COMPLETE: byte-equal to the full
    // stringify of the projected state, with no trailing «…» truncation mark.
    expect(digest.stateSummary).toBe(JSON.stringify({ blob: VERBOSE_BLOB, marker: "verbose-state" }));
    expect(digest.stateSummary?.endsWith("\u2026")).toBe(false);
  });

  test("derived context is echoed with the default seats/grants and per-seat legality", async () => {
    const tools = buildExperienceCopilotTools({ rules: REFERENCE_ROUND_RULES });
    const digest = await tools.run_test.execute({}, ctx) as ExperienceCopilotRunTestDigest;

    expect(digest.ok).toBe(true);
    expect(digest.legalActionTypes).toEqual(["score", "pass"]);
    expect(digest.seatLegality?.turnOwners).toEqual(["you"]);
    expect(digest.launchContext).toEqual({
      source: "derived",
      seats: [{ id: "you", controller: "human" }],
      grants: ["participants"],
    });
  });

  test("an explicit sandbox context uses its settings, selected seat, grants, and seed verbatim", async () => {
    const launchContext = {
      participants: [
        { id: "you", label: "You", controller: "human" as const },
        { id: "bot", label: "Bot", controller: "script" as const },
      ],
      capabilityGrants: ["participants" as const, "deterministic_random" as const],
      settings: { botFirst: true, marker: "sandbox-value" },
      seed: "seed-alpha",
      humanSeatId: "bot",
    };
    const tools = buildExperienceCopilotTools({ rules: GROUNDED_ROUND_RULES, launchContext });
    const digest = await tools.run_test.execute({}, ctx) as ExperienceCopilotRunTestDigest;

    expect(digest.ok).toBe(true);
    expect(digest.legalActionTypes).toEqual(["pass"]);
    expect(digest.stateSummary).toContain("sandbox-value");
    expect(digest.launchContext).toEqual({
      source: "sandbox",
      seats: [
        { id: "you", controller: "human" },
        { id: "bot", controller: "script" },
      ],
      grants: ["participants", "deterministic_random"],
      seed: "seed-alpha",
    });

    const differentSeedTools = buildExperienceCopilotTools({
      rules: GROUNDED_ROUND_RULES,
      launchContext: { ...launchContext, seed: "seed-beta" },
    });
    const differentSeed = await differentSeedTools.run_test.execute({}, ctx) as ExperienceCopilotRunTestDigest;
    expect(differentSeed.stateSummary).not.toBe(digest.stateSummary);
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
    // With the derived human seat, this ungated counter stops at its human boundary.
    expect(digest.ok).toBe(true);
    expect(typeof digest.stopReason).toBe("string");
    expect(typeof digest.iterations).toBe("number");
  });

  test("an explicit human+script sandbox advances the script seat past iteration zero", async () => {
    const tools = buildExperienceCopilotTools({
      rules: GROUNDED_ROUND_RULES,
      launchContext: {
        participants: [
          { id: "you", label: "You", controller: "human" },
          { id: "bot", label: "Bot", controller: "script" },
        ],
        capabilityGrants: ["participants", "deterministic_random"],
        settings: { botFirst: true },
        seed: "simulation-seed",
        humanSeatId: "you",
      },
    });
    const digest = await tools.run_simulate.execute({}, ctx) as ExperienceCopilotRunSimulateDigest;

    expect(digest.ok).toBe(true);
    expect(digest.iterations).toBe(1);
    expect(digest.stopReason).toBe("awaiting_human");
    expect(digest.launchContext?.source).toBe("sandbox");
  });

  test("returns the WHOLE 30-entry console — no tail cap (AS-8e7b)", async () => {
    // Owner 2026-10-18: the assistant sees everything the script produced —
    // the simulation digest carries every create() line, not the last 20.
    const tools = buildExperienceCopilotTools({ rules: VERBOSE_RULES });
    const digest = await tools.run_simulate.execute({}, ctx) as ExperienceCopilotRunSimulateDigest;

    expect(digest.ok).toBe(true);
    expect(digest.consoleTail).toEqual(
      Array.from({ length: 30 }, (_, i) => `log: boot line ${i + 1}`),
    );
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

describe("experience-copilot-tools: plan/read_plan", () => {
  test("plan writes the full script-owned plan and returns its summary envelope", async () => {
    let saved: unknown = null;
    const tools = buildExperienceCopilotTools({
      loadPlan: async () => saved as never,
      savePlan: async (plan) => {
        saved = plan;
      },
    });
    const plan = {
      goal: "Build the mini-app",
      constraints: [],
      tasks: [
        { id: "scaffold", title: "Scaffold the mini-app", body: "", status: "pending" },
        { id: "reducer", title: "Wire the reducer", body: "", status: "active" },
      ],
    };

    const result = (await tools.plan.execute({ plan }, ctx)) as never;
    expect(result).toEqual({ ok: true, activeTitle: "Wire the reducer", remaining: 2 });
    expect(await tools.read_plan.execute({}, ctx)).toEqual(plan);
  });

  test("plan input schema is an OBJECT root `{plan}`", () => {
    const tools = buildExperienceCopilotTools() as unknown as { plan: ToolSchemaProbe };
    const plan = { goal: "x", constraints: [], tasks: [] };
    expect(tools.plan.inputSchema.safeParse(plan).success).toBe(false);
    expect(tools.plan.inputSchema.safeParse({}).success).toBe(false);
    expect(tools.plan.inputSchema.safeParse({ plan }).success).toBe(true);
  });
});

describe("experience-copilot-tools: todo (full-list rewrite + saveTodo, restored PM-7)", () => {
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

    const r1 = (await tools.todo.execute({ items: first }, ctx)) as ExperienceCopilotTodoResult;
    const r2 = (await tools.todo.execute({ items: second }, ctx)) as ExperienceCopilotTodoResult;

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
    const r = (await tools.todo.execute(
      { items: [{ title: "a", status: "pending" }] },
      ctx,
    )) as ExperienceCopilotTodoResult;
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

  test("PM-7: the todo description carries the todo-vs-plan choice guidance", () => {
    // Owner ruling 2026-10-11: todo and plan coexist; the CHOICE guidance
    // lives in the tool descriptions (prompt bytes stay untouched).
    const tools = buildExperienceCopilotTools({ saveTodo: async () => {} }) as unknown as {
      todo: { description?: string };
      plan: { description?: string };
    };
    expect(tools.todo.description).toContain("CURRENT session");
    expect(tools.todo.description).toContain("`plan` tool");
    expect(tools.plan.description).toContain("serious multi-step work");
    expect(tools.plan.description).toContain("`todo` tool");
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

describe("experience-copilot-tools: todo/plan/read_plan/ask_user gating", () => {
  test("absent/disabled toolSet drops todo, plan, read_plan, and ask_user", () => {
    const tools = buildExperienceCopilotTools({ toolSet: { run_test: true } }) as unknown as Record<
      string,
      unknown
    >;
    expect(tools.todo).toBeUndefined();
    expect(tools.plan).toBeUndefined();
    expect(tools.read_plan).toBeUndefined();
    expect(tools.ask_user).toBeUndefined();
  });

  test("enabled toolSet includes todo, plan, read_plan, and ask_user, keeps read_skill_file", () => {
    const tools = buildExperienceCopilotTools({
      toolSet: { todo: true, plan: true, read_plan: true, ask_user: true },
    }) as unknown as Record<string, unknown>;
    expect(tools.todo).toBeDefined();
    expect(tools.plan).toBeDefined();
    expect(tools.read_plan).toBeDefined();
    expect(tools.ask_user).toBeDefined();
    expect(tools.run_test).toBeUndefined();
    expect(tools.read_skill_file).toBeDefined();
  });
});

describe("experience-copilot-tools: ToolSet shape + gating", () => {
  test("all ten tools are present by default", () => {
    const tools = buildExperienceCopilotTools() as unknown as Record<string, unknown>;
    expect(tools.write_buffer).toBeDefined();
    expect(tools.edit_buffer).toBeDefined();
    expect(tools.run_test).toBeDefined();
    expect(tools.run_simulate).toBeDefined();
    expect(tools.suggest_visual_binding).toBeDefined();
    expect(tools.plan).toBeDefined();
    expect(tools.read_plan).toBeDefined();
    expect(tools.todo).toBeDefined();
    expect(tools.ask_user).toBeDefined();
    // read_skill_file is always included (reused from the Co-Author skill system).
    expect(tools.read_skill_file).toBeDefined();
    expect(Object.keys(tools).sort()).toEqual(
      ["ask_user", "edit_buffer", "plan", "read_plan", "read_skill_file", "run_simulate", "run_test", "suggest_visual_binding", "todo", "write_buffer"],
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

// ─── SS-4B: untrusted-script trust gate (SCRIPT_SAFETY_PLAN decision 10) ─────
//
// `rulesTrusted: false` models an IMPORTED, NEVER-ENABLED script: its code
// must not execute in the copilot. Runs refuse with a structured reason the
// model relays; rules proposals are accepted WITHOUT the sandbox run, marked.

describe("experience-copilot-tools: SS-4B trust gate (rulesTrusted: false)", () => {
  test("run_test refuses an untrusted script with a structured digest — the code never runs", async () => {
    // VALID rules prove non-execution: a real run would return ok:true; the
    // refusal fires before the sandbox is ever touched.
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES, rulesTrusted: false });
    const digest = (await tools.run_test.execute({}, ctx)) as unknown as {
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
    };
    expect(digest.ok).toBe(false);
    expect(digest.errorCode).toBe("script_not_trusted");
    expect(digest.errorMessage).toContain("imported and never enabled");
    expect(digest.errorMessage).toContain("enable it in the editor first");
  });

  test("run_simulate refuses an untrusted script with the same structured digest", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES, rulesTrusted: false });
    const digest = (await tools.run_simulate.execute({}, ctx)) as unknown as {
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
    };
    expect(digest.ok).toBe(false);
    expect(digest.errorCode).toBe("script_not_trusted");
    expect(digest.errorMessage).toContain("imported and never enabled");
  });

  test("write_buffer accepts a rules proposal WITHOUT validation and carries the «not validated» marker", async () => {
    // SYNTAX_ERROR rules would throw on the trusted path — acceptance proves
    // the sandbox run was skipped; the marker names the trust state.
    const tools = buildExperienceCopilotTools({ rulesTrusted: false });
    const out = (await tools.write_buffer.execute(
      { target: "rules", content: SYNTAX_ERROR_RULES, summary: "draft" },
      ctx,
    )) as unknown as { target: string; proposed: string; notValidated?: string };
    expect(out.target).toBe("rules");
    expect(out.proposed).toBe(SYNTAX_ERROR_RULES);
    expect(out.notValidated).toBe("not validated: script is imported and not yet enabled");
  });

  test("edit_buffer accepts invalid edits without validation and carries the marker; the buffer still advances", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES, rulesTrusted: false });
    const out = (await tools.edit_buffer.execute(
      {
        target: "rules",
        edits: [{ search: "context.experience.register({", replace: "context.experience.register({ !!broken" }],
        summary: "break",
      },
      ctx,
    )) as unknown as { notValidated?: string };
    expect(out.notValidated).toBe("not validated: script is imported and not yet enabled");
    // The working buffer advanced (no validation throw, no rollback).
    const after = (await tools.edit_buffer.execute(
      { target: "rules", edits: [{ search: " !!broken", replace: "" }], summary: "fix" },
      ctx,
    )) as unknown as { proposed: string; notValidated?: string };
    expect(after.proposed).toContain("context.experience.register({");
    expect(after.notValidated).toBe("not validated: script is imported and not yet enabled");
  });

  test("visual proposals never carry the marker (no rules validation exists for visual)", async () => {
    const tools = buildExperienceCopilotTools({ rulesTrusted: false });
    const out = (await tools.write_buffer.execute(
      { target: "visual", content: "<div>x</div>", summary: "v" },
      ctx,
    )) as unknown as { target: string; proposed: string; notValidated?: string };
    expect(out.target).toBe("visual");
    expect(out.proposed).toBe("<div>x</div>");
    expect(out.notValidated).toBeUndefined();
  });
});

describe("experience-copilot-tools: SS-4B trusted parity (after first enable)", () => {
  test("rulesTrusted: true — run_test executes, rules proposals validate and carry NO marker", async () => {
    const tools = buildExperienceCopilotTools({ rules: VALID_RULES, rulesTrusted: true });
    const digest = (await tools.run_test.execute({}, ctx)) as unknown as {
      ok: boolean;
      legalActionTypes?: string[];
    };
    expect(digest.ok).toBe(true);
    expect(digest.legalActionTypes).toEqual(["increment", "reset"]);

    // Validation still throws on invalid rules for a trusted script.
    await expect(
      tools.write_buffer.execute({ target: "rules", content: SYNTAX_ERROR_RULES, summary: "bad" }, ctx),
    ).rejects.toThrow(/failed validation/);
    const out = (await tools.write_buffer.execute(
      { target: "rules", content: VALID_RULES, summary: "ok" },
      ctx,
    )) as unknown as { notValidated?: string };
    expect(out.notValidated).toBeUndefined();
  });
});

// ─── AS-2c buffer-tool description pin ───────────────────────────────────────
//
// The buffer-tool MECHANISM moved to domain/agent/agent-buffer-tools.ts and
// the experience wiring composes the strings from fragments. Tool descriptions
// are model-facing behavior (not byte-pinned by AS-1), so this pins the
// pre-AS-2c literals verbatim — copied from the pre-carve source, byte for
// byte — plus the target-enum describe texts (the one place the factory
// composes kind copy into the zod schema).

describe("experience-copilot-tools: buffer-tool description pin (AS-2c)", () => {
  test("write_buffer/edit_buffer descriptions are byte-identical to the pre-AS-2c literals", () => {
    const WRITE_BUFFER_DESCRIPTION =
      "Replace the ENTIRE rules OR visual buffer with `content`. EVERY call MUST include `target` ('rules' or 'visual') — a call missing it, or any required field, is rejected wholesale. " +
      "Use it for a ground-up rewrite of a buffer. " +
      "It must be the FIRST change to that buffer in a turn — once a buffer has been mutated, refine it with edit_buffer instead. " +
      "For target 'rules', the proposed source is validated by running it through the experience sandbox (a create-only test); an invalid proposal returns a tool-error so you can self-correct in the same turn. " +
      "For target 'visual', no validation runs (no validator exists). The proposed buffer is shown to the user as a diff before they bind it.";
    const EDIT_BUFFER_DESCRIPTION =
      "Apply exact SEARCH/REPLACE edits to the current rules OR visual buffer. EVERY call MUST include `target` ('rules' or 'visual') — a call missing it, or any required field, is rejected wholesale before any edit runs. " +
      "Each `search` must match exactly once in the current buffer text; use this for targeted incremental changes after the buffer exists. " +
      "For target 'rules', the RESULTING proposed source is validated by running it through the experience sandbox (a create-only test); an invalid result returns a tool-error. " +
      "Edits compose across calls within one turn. The proposed buffer is shown to the user as a diff before they bind it.";
    const WRITE_TARGET_DESCRIBE =
      "REQUIRED on every call. Which buffer to rewrite: 'rules' (the experience rules source) or 'visual' (the visual source). Never omit.";
    const EDIT_TARGET_DESCRIBE =
      "REQUIRED on every call. Which buffer to edit: 'rules' or 'visual'. Never omit.";

    const tools = buildExperienceCopilotTools();
    expect(tools.write_buffer.description).toBe(WRITE_BUFFER_DESCRIPTION);
    expect(tools.edit_buffer.description).toBe(EDIT_BUFFER_DESCRIPTION);

    // The zod target-enum describe texts, via a minimal shape probe.
    const writeSchema = tools.write_buffer.inputSchema as unknown as {
      shape: { target: { description: string } };
    };
    const editSchema = tools.edit_buffer.inputSchema as unknown as {
      shape: { target: { description: string } };
    };
    expect(writeSchema.shape.target.description).toBe(WRITE_TARGET_DESCRIBE);
    expect(editSchema.shape.target.description).toBe(EDIT_TARGET_DESCRIBE);
  });
});
