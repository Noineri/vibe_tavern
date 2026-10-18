/**
 * Script-agent tools acceptance (AGENT_SHELL_PLAN, Wave 3 / AS-7).
 *
 * Pins the model's channels for proposing code edits and testing the script:
 * - `write_buffer`/`edit_buffer` over the SINGLE `code` buffer (proposal
 *   semantics, first-mutation guard, exact-hunk validation) and the tool
 *   input schemas (edit hunks, run_script_test args, ask_user refine);
 * - `run_script_test` through the REAL tester the script-test route uses
 *   (`testScript` — prompt scripts: the seven-channel run; dice scripts:
 *   discovery + one deterministic sample roll per check), running the CURRENT
 *   working `code` buffer, not the stored code, and returning the FULL result
 *   (AS-8e2, owner 2026-10-18: a 5 000-char personality, a 2 000-char state
 *   and a 30-entry console come back whole — no invented economies);
 * - the HARD security pin (SCRIPT_SAFETY_PLAN): an UNTRUSTED script
 *   (imported, never enabled) NEVER executes — `run_script_test` refuses
 *   fail-closed BEFORE anything runs (not even the store read happens), with
 *   a structured refusal naming how trust is established.
 *
 * The store container enters through the same injected seam the route adapter
 * uses (T1); the sandbox itself is real. The second execute() argument (the
 * AI-SDK tool-call context) is ignored by every tool, so a stub cast `as
 * never` suffices (matches the experience-copilot tools suite).
 */

import { describe, test, expect } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { StoreContainer, ScriptRow } from "@vibe-tavern/db";
import { SCRIPT_AGENT_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import {
  buildScriptAgentTools,
  type ScriptAgentRunTestResult,
} from "../src/domain/agent/script-agent/script-agent-tools.js";
import { isScriptAuthoringTrusted } from "../src/domain/agent/script-agent/script-agent-module.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A tiny prompt script (sets the character's personality suffix). */
const TINY_PROMPT_CODE = "context.character.personality += ', brave';";

/** A tiny dice script (one strict d20+5 check with a final outcome — strict
 *  resolution REQUIRES `final`) — adapted from the script-test-service
 *  dispatch suite's fixture. */
const TINY_DICE_CODE = `
context.dice.register({
  id: 'attack', label: 'Attack Roll', notation: '1d20+5',
  actors: ['persona', 'character'], resolution: 'strict',
  resolve() {
    var r = context.dice.roll('1d20+5');
    return { faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total,
      final: { total: r.total, outcome: r.total >= 15 ? 'hit' : 'miss' } };
  }
});
`;

/** Build a script ROW (the store shape `testScript` reads) — the same
 *  fixture convention the experience kind-resolution suite uses. */
function makeScriptRow(overrides: Partial<ScriptRow> & { id: string; code: string }): ScriptRow {
  return {
    id: overrides.id,
    name: overrides.name ?? "Script",
    description: "",
    code: overrides.code,
    enabled: overrides.enabled ?? true,
    origin: overrides.origin ?? "in_app",
    firstEnabledAt: overrides.firstEnabledAt ?? null,
    scriptKind: overrides.scriptKind ?? "prompt",
    creationIntentId: null,
    scopeType: overrides.scopeType ?? "entity",
    sortOrder: overrides.sortOrder ?? 0,
    characterId: overrides.characterId ?? "character_1",
    personaId: overrides.personaId ?? null,
    chatId: overrides.chatId ?? null,
    defaultVisualId: null,
    copilotProfileId: null,
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Store container with a COUNTING scripts.getById — the counting is the
 *  non-execution proof for the trust-gate tests (the refusal must fire before
 *  even this read). Mirrors the dispatch suite's stub convention. */
function storesWith(script: ScriptRow): { stores: StoreContainer; getByIdCalls: () => number } {
  let calls = 0;
  const stores = {
    scripts: {
      getById: async () => {
        calls += 1;
        return { ...script };
      },
    },
  } as unknown as StoreContainer;
  return { stores, getByIdCalls: () => calls };
}

/** Shared tool-execution context stub — structurally the AI SDK's
 *  `ToolExecutionOptions` (every tool here ignores it; `buildScriptAgentTools`
 *  returns a `ToolSet`, so the loose element typing accepts this stub). */
const ctx: ToolExecutionOptions<unknown> = { toolCallId: "t", messages: [], context: undefined };

/** Minimal view of a built tool exposing its zod input schema for direct
 *  validation assertions (the AI SDK validates `inputSchema` at tool-call
 *  time — enum/min/max/refine rejections are asserted against the schema). */
interface ToolSchemaProbe {
  inputSchema: { safeParse(value: unknown): { success: boolean } };
}

function schemaOf(tools: Record<string, unknown>, name: string): ToolSchemaProbe {
  return tools[name] as ToolSchemaProbe;
}

// ─── Buffer tools over the single `code` buffer ──────────────────────────────

describe("script-agent-tools: write_buffer / edit_buffer over `code`", () => {
  test("write_buffer proposes the whole buffer; edit_buffer composes exact hunks on it", async () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "stored" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", code: TINY_PROMPT_CODE, codeTrusted: true, stores });

    const written = await tools.write_buffer.execute(
      { target: "code", content: TINY_PROMPT_CODE, summary: "Initial code." },
      ctx,
    );
    expect(written.target).toBe("code");
    expect(written.proposed).toBe(TINY_PROMPT_CODE);
    expect(written.summary).toBe("Initial code.");

    const edited = await tools.edit_buffer.execute(
      {
        target: "code",
        edits: [{ search: "', brave'", replace: "', very brave'" }],
        summary: "Stronger suffix.",
      },
      ctx,
    );
    expect(edited.proposed).toBe("context.character.personality += ', very brave';");
  });

  test("the first-mutation guard: a second whole-buffer rewrite is rejected, edits still compose", async () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores });
    await tools.write_buffer.execute(
      { target: "code", content: TINY_PROMPT_CODE, summary: "first" },
      ctx,
    );
    await expect(
      tools.write_buffer.execute({ target: "code", content: TINY_PROMPT_CODE, summary: "second" }, ctx),
    ).rejects.toThrow(/FIRST code change/);
    const edited = await tools.edit_buffer.execute(
      { target: "code", edits: [{ search: "brave", replace: "bold" }], summary: "reword" },
      ctx,
    );
    expect(edited.proposed).toContain("bold");
  });

  test("hunk validation: no match, ambiguous match, and a missing buffer all throw", async () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", code: "const a = 1; const a2 = 1;", codeTrusted: true, stores });

    await expect(
      tools.edit_buffer.execute(
        { target: "code", edits: [{ search: "not-there", replace: "x" }], summary: "s" },
        ctx,
      ),
    ).rejects.toThrow(/edit\.search not found/);
    await expect(
      tools.edit_buffer.execute(
        { target: "code", edits: [{ search: "const a", replace: "const b" }], summary: "s" },
        ctx,
      ),
    ).rejects.toThrow(/ambiguous \(2 matches\)/);

    const bare = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores });
    await expect(
      bare.edit_buffer.execute(
        { target: "code", edits: [{ search: "x", replace: "y" }], summary: "s" },
        ctx,
      ),
    ).rejects.toThrow(/no 'code' buffer in the working state/);
  });
});

// ─── Tool input schemas (c) ──────────────────────────────────────────────────

describe("script-agent-tools: input schema validation", () => {
  test("edit_buffer rejects a missing target, an empty edit list, and a foreign target", () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores }) as unknown as Record<string, unknown>;
    const schema = schemaOf(tools, "edit_buffer");

    expect(schema.inputSchema.safeParse({ edits: [{ search: "a", replace: "b" }], summary: "s" }).success).toBe(false);
    expect(schema.inputSchema.safeParse({ target: "code", edits: [], summary: "s" }).success).toBe(false);
    expect(schema.inputSchema.safeParse({ target: "rules", edits: [{ search: "a", replace: "b" }], summary: "s" }).success).toBe(false);
  });

  test("run_script_test rejects an empty character/persona name and an input past the chat-message cap", () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores }) as unknown as Record<string, unknown>;
    const schema = schemaOf(tools, "run_script_test");

    expect(schema.inputSchema.safeParse({ characterName: "" }).success).toBe(false);
    expect(schema.inputSchema.safeParse({ personaName: "" }).success).toBe(false);
    // AS-8e2 (owner 2026-10-18): the simulated message shares the chat
    // message cap (50 000, `experienceCopilotStreamRequestSchema.content`) —
    // was: rejected past 4 000. Names are unbounded — was: rejected past 200.
    expect(schema.inputSchema.safeParse({ input: "x".repeat(4001) }).success).toBe(true);
    expect(schema.inputSchema.safeParse({ input: "x".repeat(50_001) }).success).toBe(false);
    expect(schema.inputSchema.safeParse({ characterName: "N".repeat(201) }).success).toBe(true);
    // All-optional args and a short input parse fine.
    expect(schema.inputSchema.safeParse({}).success).toBe(true);
    expect(schema.inputSchema.safeParse({ input: "hello", characterName: "Aria" }).success).toBe(true);
  });

  test("ask_user's recommended must name one of the options (refine)", () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores }) as unknown as Record<string, unknown>;
    const schema = schemaOf(tools, "ask_user");

    expect(
      schema.inputSchema.safeParse({ question: "Which?", options: ["a", "b"], recommended: "c" }).success,
    ).toBe(false);
    expect(
      schema.inputSchema.safeParse({ question: "Which?", options: ["a", "b"], recommended: "b" }).success,
    ).toBe(true);
  });
});

// ─── run_script_test through the REAL tester (d) ─────────────────────────────

describe("script-agent-tools: run_script_test — real runtime, prompt path", () => {
  test("runs the CURRENT working buffer (not the stored code) through the seven-channel tester", async () => {
    // Stored code differs from the buffer — the digest must reflect the buffer.
    const script = makeScriptRow({ id: "s1", scriptKind: "prompt", code: "context.character.personality = 'STORED';" });
    const { stores } = storesWith(script);
    const tools = buildScriptAgentTools({ scriptId: "s1", code: TINY_PROMPT_CODE, codeTrusted: true, stores });

    const digest = (await tools.run_script_test.execute(
      { input: "hello", characterName: "Aria" },
      ctx,
    )) as ScriptAgentRunTestResult;

    expect(digest.kind).toBe("prompt");
    if (digest.kind !== "prompt") return;
    expect(digest.ok).toBe(true);
    // The default personality is "" — the buffer's append ran against it.
    expect(digest.personality).toBe(", brave");
    expect(digest.errors).toHaveLength(0);
    expect(digest.stateSummary).toBe("{}");
    expect(digest.console).toHaveLength(0);
  });

  test("the FULL result: a 5 000-char personality, a 2 000-char state and a 30-entry console come back whole", async () => {
    // AS-8e2 (owner 2026-10-18): the digest used to cap personality/scenario
    // at 2 000 chars, the state snapshot at 1 500 and the console at the last
    // 20 entries — every cap is gone; nothing the script produced is cut.
    const script = makeScriptRow({ id: "s1", scriptKind: "prompt", code: "" });
    const { stores } = storesWith(script);
    const code =
      `context.character.personality = ${JSON.stringify("P".repeat(5000))};\n` +
      `context.state.set('blob', ${JSON.stringify("S".repeat(2000))});\n` +
      `for (var i = 0; i < 30; i++) { console.log('line-' + i); }`;
    const tools = buildScriptAgentTools({ scriptId: "s1", code, codeTrusted: true, stores });

    const digest = (await tools.run_script_test.execute({}, ctx)) as ScriptAgentRunTestResult;
    expect(digest.kind).toBe("prompt");
    if (digest.kind !== "prompt") return;
    // Whole, byte-identical, no truncation ellipsis anywhere.
    expect(digest.personality).toBe("P".repeat(5000));
    expect(digest.personality).not.toContain("\u2026");
    expect(digest.stateSummary).toBe(JSON.stringify({ blob: "S".repeat(2000) }));
    expect(digest.stateSummary).not.toContain("\u2026");
    expect(digest.console).toHaveLength(30);
    expect(digest.console[0]).toBe("log: line-0");
    expect(digest.console[29]).toBe("log: line-29");
    expect(digest.ok).toBe(true);
  });

  test("a runtime error in the buffer surfaces as a typed digest error (self-correction loop)", async () => {
    const script = makeScriptRow({ id: "s1", scriptKind: "prompt", code: "" });
    const { stores } = storesWith(script);
    const tools = buildScriptAgentTools({
      scriptId: "s1",
      code: "context.state.count = 1; null.crash();",
      codeTrusted: true,
      stores,
    });

    const digest = (await tools.run_script_test.execute({}, ctx)) as ScriptAgentRunTestResult;
    expect(digest.kind).toBe("prompt");
    if (digest.kind !== "prompt") return;
    expect(digest.ok).toBe(false);
    expect(digest.errors.length).toBeGreaterThan(0);
    expect(digest.errors[0].error).toContain("crash");
  });

  test("no code buffer in the working state → typed tool error", async () => {
    const script = makeScriptRow({ id: "s1", scriptKind: "prompt", code: "" });
    const { stores } = storesWith(script);
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores });
    await expect(tools.run_script_test.execute({}, ctx)).rejects.toThrow(/no 'code' buffer/);
  });
});

describe("script-agent-tools: run_script_test — real runtime, dice path", () => {
  test("discovers the check and produces one deterministic sample roll", async () => {
    const script = makeScriptRow({ id: "s1", scriptKind: "dice", code: "// stale stored body" });
    const { stores } = storesWith(script);
    const tools = buildScriptAgentTools({ scriptId: "s1", code: TINY_DICE_CODE, codeTrusted: true, stores });

    const digest = (await tools.run_script_test.execute(
      { characterName: "Dragon", personaName: "Hero" },
      ctx,
    )) as ScriptAgentRunTestResult;

    expect(digest.kind).toBe("dice");
    if (digest.kind !== "dice") return;
    expect(digest.ok).toBe(true);
    expect(digest.discoveryError).toBeNull();
    expect(digest.checks).toEqual([
      { id: "attack", label: "Attack Roll", notation: "d20+5", actors: ["persona", "character"] },
    ]);
    expect(digest.sampleRolls).toHaveLength(1);
    const roll = digest.sampleRolls[0];
    expect(roll.checkId).toBe("attack");
    expect(roll.result.ok).toBe(true);
    if (roll.result.ok !== true) return;
    // 1d20+5: one face, arithmetic holds on the trimmed envelope, and the
    // strict final outcome is consistent with the total.
    expect(roll.result.faces).toHaveLength(1);
    expect(roll.result.total).toBe(roll.result.faces[0] + 5);
    expect(roll.result.final?.outcome).toBe(roll.result.total >= 15 ? "hit" : "miss");

    // Determinism: the tester's fixed-seed RNG — a rerun is byte-identical.
    const rerun = (await tools.run_script_test.execute(
      { characterName: "Dragon", personaName: "Hero" },
      ctx,
    )) as ScriptAgentRunTestResult;
    expect(JSON.stringify(rerun.sampleRolls)).toBe(JSON.stringify(digest.sampleRolls));
  });

  test("a syntax-broken dice buffer surfaces the discovery error, not a throw", async () => {
    const script = makeScriptRow({ id: "s1", scriptKind: "dice", code: "" });
    const { stores } = storesWith(script);
    const tools = buildScriptAgentTools({
      scriptId: "s1",
      code: "context.dice.register({ this is broken {{{",
      codeTrusted: true,
      stores,
    });

    const digest = (await tools.run_script_test.execute({}, ctx)) as ScriptAgentRunTestResult;
    expect(digest.kind).toBe("dice");
    if (digest.kind !== "dice") return;
    expect(digest.ok).toBe(false);
    expect(digest.discoveryError).not.toBeNull();
    expect(digest.checks).toHaveLength(0);
  });
});

// ─── The trust gate (e) — the unit's HARD security pin ───────────────────────

describe("script-agent-tools: run_script_test refuses UNTRUSTED scripts — fail-closed", () => {
  test("isScriptAuthoringTrusted: only imported-and-never-enabled is untrusted", () => {
    // The single derivation the assembly and the tool both consume.
    expect(isScriptAuthoringTrusted({ origin: "in_app", firstEnabledAt: null })).toBe(true);
    expect(isScriptAuthoringTrusted({ origin: "imported", firstEnabledAt: null })).toBe(false);
    expect(isScriptAuthoringTrusted({ origin: "imported", firstEnabledAt: "2026-10-01T00:00:00.000Z" })).toBe(true);
  });

  test("an untrusted script with a WORKING buffer refuses: structured envelope, and NOTHING executes", async () => {
    // The script row models the refusal trigger: imported, never enabled.
    const script = makeScriptRow({
      id: "s1",
      scriptKind: "dice",
      code: TINY_DICE_CODE,
      enabled: false,
      origin: "imported",
      firstEnabledAt: null,
    });
    const { stores, getByIdCalls } = storesWith(script);
    // A code buffer EXISTS (the model may still propose edits) — the refusal
    // must fire anyway, before ANY execution.
    const tools = buildScriptAgentTools({ scriptId: "s1", code: TINY_DICE_CODE, codeTrusted: false, stores });

    const digest = (await tools.run_script_test.execute({ characterName: "Dragon" }, ctx)) as {
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(digest.ok).toBe(false);
    expect(digest.errorCode).toBe("script_not_trusted");
    // The refusal names HOW trust is established (the model relays it).
    expect(digest.errorMessage).toContain("imported and never enabled");
    expect(digest.errorMessage).toContain("enable it in the editor first");
    // NO test execution happened: the refusal fired before even the store
    // read (the tester's first step) — fail-closed at the tool boundary.
    expect(getByIdCalls()).toBe(0);
  });

  test("a once-enabled import runs its test (the first enable is the trust moment)", async () => {
    const script = makeScriptRow({
      id: "s1",
      scriptKind: "prompt",
      code: "",
      origin: "imported",
      firstEnabledAt: "2026-10-01T00:00:00.000Z",
    });
    const { stores, getByIdCalls } = storesWith(script);
    const tools = buildScriptAgentTools({ scriptId: "s1", code: TINY_PROMPT_CODE, codeTrusted: true, stores });

    const digest = (await tools.run_script_test.execute({}, ctx)) as ScriptAgentRunTestResult;
    expect(digest.kind).toBe("prompt");
    if (digest.kind !== "prompt") return;
    expect(digest.ok).toBe(true);
    expect(getByIdCalls()).toBe(1);
  });
});

// ─── Tool-set shape + gating ─────────────────────────────────────────────────

describe("script-agent-tools: tool set shape and gating", () => {
  test("default set: every module tool plus always-on read_skill_file", () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({ scriptId: "s1", codeTrusted: true, stores }) as unknown as Record<string, unknown>;
    const names = Object.keys(tools).sort();
    expect(names).toEqual([...SCRIPT_AGENT_TOOL_KEYS, "read_skill_file"].sort());
  });

  test("toolSet gating filters the toggleable tools; read_skill_file stays on", () => {
    const { stores } = storesWith(makeScriptRow({ id: "s1", code: "" }));
    const tools = buildScriptAgentTools({
      scriptId: "s1",
      codeTrusted: true,
      stores,
      toolSet: { run_script_test: true },
    }) as unknown as Record<string, unknown>;
    expect(tools.run_script_test).toBeDefined();
    expect(tools.write_buffer).toBeUndefined();
    expect(tools.edit_buffer).toBeUndefined();
    expect(tools.plan).toBeUndefined();
    expect(tools.read_plan).toBeUndefined();
    expect(tools.ask_user).toBeUndefined();
    expect(tools.read_skill_file).toBeDefined();
  });
});
