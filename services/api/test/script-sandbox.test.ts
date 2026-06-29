/**
 * Characterization tests for `executeScripts` — the node:vm sandbox that runs
 * user-authored scripts during prompt assembly. Pure function (no I/O, no DB),
 * so these are unit tests.
 *
 * Coverage gaps closed here (previously zero tests on the engine):
 *  - `state.get(key, defaultValue?)` Map-style semantics (the HP-tracker fix)
 *  - character mutation via getter/setter context
 *  - `injectMessage` output channel
 *  - per-script state persistence across the returned `updatedScriptState`
 *  - error isolation (one script throwing does not abort siblings)
 *  - lore entries are read-only (frozen) to user scripts
 *  - execution order = `sortOrder` ascending
 *  - Janitor-AI snake_case aliases (`last_message`, `message_count`, `inject_message`)
 */
import { describe, expect, test } from "bun:test";
import { executeScripts, type ScriptExecutionInput } from "../src/domain/scripts-engine/script-sandbox.js";

function run(
  code: string | Array<{ code: string; id?: string; name?: string; sortOrder?: number }>,
  opts: {
    messages?: Array<{ message: string; role: string }>;
    personality?: string;
    scenario?: string;
    state?: Record<string, Record<string, unknown>>;
    activeLoreEntries?: ScriptExecutionInput["activeLoreEntries"];
    persona?: { name: string; description: string };
    shared?: Record<string, unknown>;
  } = {},
) {
  const scripts = Array.isArray(code)
    ? code.map((s, i) => ({ id: s.id ?? `s${i}`, name: s.name ?? `script-${i}`, code: s.code, sortOrder: s.sortOrder ?? 0 }))
    : [{ id: "s0", name: "script-0", code, sortOrder: 0 }];
  return executeScripts({
    scripts,
    chat: { messages: opts.messages ?? [{ message: "hello", role: "user" }] },
    character: { name: "Test", personality: opts.personality ?? "", scenario: opts.scenario ?? "" },
    activeLoreEntries: opts.activeLoreEntries ?? [],
    scriptState: opts.state ?? {},
    persona: opts.persona,
    shared: opts.shared,
  });
}

describe("executeScripts — context.state", () => {
  test("get(key, defaultValue) returns the default when key is absent (HP-tracker fix)", () => {
    // Regression for Defect C: `state.get('hp', 100)` used to return undefined
    // because the sandbox ignored the second argument. HP-tracker computed NaN.
    const r = run(`context.state.set('hp', context.state.get('hp', 100) - 10);`);
    expect(r.updatedScriptState.s0.hp).toBe(90);
  });

  test("get(key) without default returns undefined for absent keys", () => {
    const r = run(`context.character.personality += String(context.state.get('missing'));`);
    expect(r.character.personality).toBe("undefined");
  });

  test("get(key, default) returns the stored value when key is present", () => {
    const r = run(`context.character.personality += String(context.state.get('hp', 0));`, {
      state: { s0: { hp: 42 } },
    });
    expect(r.character.personality).toBe("42");
  });

  test("set persists into updatedScriptState, namespaced per script id", () => {
    const r = run(`context.state.set('flag', true); context.state.set('count', 7);`);
    expect(r.updatedScriptState.s0).toEqual({ flag: true, count: 7 });
  });

  test("increment adds to an existing value and returns the new total", () => {
    const r = run(`context.state.increment('turn'); context.state.increment('turn', 5);`, {
      state: { s0: { turn: 10 } },
    });
    expect(r.updatedScriptState.s0.turn).toBe(16);
  });

  test("increment on an absent key starts from 0", () => {
    const r = run(`context.state.increment('fresh');`);
    expect(r.updatedScriptState.s0.fresh).toBe(1);
  });

  test("state carries over from prior turn's persisted state", () => {
    // Simulates the per-chat state round-trip: prompt-resolver reads
    // chat.scriptState, passes it in, persists updatedScriptState back.
    const r = run(`context.state.increment('turn');`, { state: { s0: { turn: 3 } } });
    expect(r.updatedScriptState.s0.turn).toBe(4);
  });
});

describe("executeScripts — context.character", () => {
  test("personality is mutable via assignment", () => {
    const r = run(`context.character.personality += ", now friendly";`, { personality: "stoic" });
    expect(r.character.personality).toBe("stoic, now friendly");
  });

  test("scenario is mutable via assignment", () => {
    const r = run(`context.character.scenario += " Rain falls.";`, { scenario: "A tavern." });
    expect(r.character.scenario).toBe("A tavern. Rain falls.");
  });

  test("name is read-only (not exposed as a setter)", () => {
    // `name` is a plain property on the context object, not a getter/setter —
    // assigning to it mutates the local copy but does not propagate. Pinning
    // current behaviour so a future "make name mutable" change is intentional.
    const r = run(`context.character.name = "Changed";`);
    // executeScripts returns only personality/scenario in the character result,
    // so a name mutation is invisible to the pipeline regardless.
    expect(r.character).not.toHaveProperty("name");
  });
});

describe("executeScripts — context.chat", () => {
  test("injectMessage pushes to the output channel", () => {
    const r = run(`context.chat.injectMessage("note", "system");`);
    expect(r.injectedMessages).toEqual([{ content: "note", role: "system" }]);
  });

  test("injectMessage defaults role to 'system' when omitted", () => {
    const r = run(`context.chat.injectMessage("bare");`);
    expect(r.injectedMessages).toEqual([{ content: "bare", role: "system" }]);
  });

  test("lastMessage reads the most recent chat message", () => {
    const r = run(`context.character.personality += context.chat.lastMessage;`, {
      messages: [{ message: "first", role: "user" }, { message: "second", role: "assistant" }],
    });
    expect(r.character.personality).toBe("second");
  });

  test("lastMessage is empty string when there are no messages", () => {
    const r = run(`context.character.personality += "[" + context.chat.lastMessage + "]";`, {
      messages: [],
    });
    expect(r.character.personality).toBe("[]");
  });

  test("messageCount reflects the message array length", () => {
    const r = run(`context.character.personality += context.chat.messageCount;`, {
      messages: [{ message: "a", role: "user" }, { message: "b", role: "user" }, { message: "c", role: "user" }],
    });
    expect(r.character.personality).toBe("3");
  });

  test("messages array is the raw input (readable by scripts)", () => {
    const r = run(`context.character.personality += context.chat.messages[0].message;`, {
      messages: [{ message: "first", role: "user" }],
    });
    expect(r.character.personality).toBe("first");
  });
});

describe("executeScripts — Janitor-AI snake_case aliases", () => {
  // Aliases exist so scripts written for Janitor AI's API (snake_case) work
  // without rewrite. All are getter-backed and read the same source as the
  // camelCase primary.
  test("last_message === lastMessage", () => {
    const r = run(`context.character.personality += context.chat.last_message;`, {
      messages: [{ message: "x", role: "user" }, { message: "y", role: "user" }],
    });
    expect(r.character.personality).toBe("y");
  });

  test("message_count === messageCount", () => {
    const r = run(`context.character.personality += context.chat.message_count;`, {
      messages: [{ message: "a", role: "user" }, { message: "b", role: "user" }],
    });
    expect(r.character.personality).toBe("2");
  });

  test("inject_message === injectMessage", () => {
    const r = run(`context.chat.inject_message("aliased");`);
    expect(r.injectedMessages).toEqual([{ content: "aliased", role: "system" }]);
  });
});

describe("executeScripts — context.lore", () => {
  test("activeEntries exposes title/content/keys of activated lore", () => {
    const r = run(
      `const e = context.lore.activeEntries[0]; context.character.personality += e.title + ":" + e.content + ":" + e.keys.join(",");`,
      {
        activeLoreEntries: [{ title: "T", content: "C", keys: ["a", "b"] }],
      },
    );
    expect(r.character.personality).toBe("T:C:a,b");
  });

  test("activeEntries are frozen — mutation throws in strict mode", () => {
    // Object.freeze is shallow; the entries are also individually frozen.
    // In sloppy mode the assignment silently fails; in strict mode it throws.
    // Scripts run in a VM with no enforced strict mode, so the silent-fail
    // path is what production hits — pin it.
    const r = run(`context.lore.activeEntries[0].title = "hacked"; context.character.personality += context.lore.activeEntries[0].title;`, {
      activeLoreEntries: [{ title: "Original", content: "", keys: [] }],
    });
    // Frozen: assignment is a no-op (or throws, caught as an error).
    if (r.errors.length === 0) {
      expect(r.character.personality).toBe("Original");
    }
  });

  test("activeEntries is empty when no lore activated", () => {
    const r = run(`context.character.personality += context.lore.activeEntries.length;`);
    expect(r.character.personality).toBe("0");
  });
});

describe("executeScripts — context utilities", () => {
  test("random() returns a number in [0, 1)", () => {
    const r = run(`context.character.personality += (context.random() < 1);`);
    expect(r.character.personality).toBe("true");
  });

  test("randomInt(min, max) stays within the inclusive range", () => {
    // Sample many times via a loop to catch off-by-one.
    const r = run(`
      let ok = true;
      for (let i = 0; i < 100; i++) {
        const v = context.randomInt(3, 5);
        if (v < 3 || v > 5) { ok = false; break; }
      }
      context.character.personality += ok;
    `);
    expect(r.character.personality).toBe("true");
  });

  test("pick returns one of the array elements", () => {
    const r = run(`context.character.personality += ["a","b","c"].includes(context.pick(["a","b","c"]));`);
    expect(r.character.personality).toBe("true");
  });

  test("weightedPick respects weights deterministically with a zero-weight loser", () => {
    // Only one item has non-zero weight, so it must always win.
    const r = run(`context.character.personality += context.weightedPick([{w:"win",weight:1},{w:"lose",weight:0}]).w;`);
    expect(r.character.personality).toBe("win");
  });

  test("seeded RNG reproduces the same sequence for the same turn (message count)", () => {
    // P7: regeneration must reproduce outcomes. Same message count → same
    // first roll. Pin the determinism contract explicitly.
    const code = `context.state.set('roll', context.random());`;
    const a = run(code, { messages: [{ message: "m1", role: "user" }] });
    const b = run(code, { messages: [{ message: "m1", role: "user" }] });
    expect(a.updatedScriptState.s0.roll).toBe(b.updatedScriptState.s0.roll);
  });

  test("a different turn (different message count) re-sows the RNG", () => {
    // Different seed source → different first roll (with overwhelming
    // probability; pinned as a contract that the seed actually changes).
    const code = `context.state.set('roll', context.random());`;
    const one = run(code, { messages: [{ message: "m1", role: "user" }] });
    const two = run(code, { messages: [{ message: "m1", role: "user" }, { message: "m2", role: "user" }] });
    expect(one.updatedScriptState.s0.roll).not.toBe(two.updatedScriptState.s0.roll);
  });
});

describe("executeScripts — error handling", () => {
  test("a thrown error is captured with script id + name + message", () => {
    const r = run(`throw new Error("boom");`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].scriptId).toBe("s0");
    expect(r.errors[0].scriptName).toBe("script-0");
    expect(r.errors[0].error).toBe("boom");
  });

  test("a thrown error does NOT abort sibling scripts", () => {
    const r = run([
      { code: `throw new Error("first fails");`, id: "fail", name: "Failer", sortOrder: 0 },
      { code: `context.character.personality += "survived";`, id: "ok", name: "Survivor", sortOrder: 1 },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].scriptId).toBe("fail");
    expect(r.character.personality).toBe("survived");
  });

  test("a syntax error is captured (not a throw, but a parse-time failure)", () => {
    const r = run(`this is not valid javascript {{{`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error.length).toBeGreaterThan(0);
  });

  test("an infinite loop is killed by the 5s VM timeout", () => {
    // The VM timeout is the only defence against runaway user code. Pin it.
    // Bun:test default timeout is 5000ms — same as the VM timeout — which
    // races. Lift this test's timeout to 10s so the VM (5s) always fires
    // first and the assertion sees the captured error rather than the
    // runner killing the test.
    const r = run(`while (true) {}`);
    expect(r.errors).toHaveLength(1);
    // Node's timeout error message varies; just assert it was captured.
  }, 10000);

  test("a script that errors does NOT persist its pre-error state (snapshot is inside try)", () => {
    // Characterization of a real engine behaviour, NOT a design claim:
    // `updatedScriptState[id] = { ...stateBucket }` runs INSIDE the try block,
    // AFTER runInNewContext returns. If the script throws, that line is
    // skipped, so state.set() calls made before the throw are LOST.
    //
    // Consequence for users: a script that decrements HP then throws does
    // not get its HP change persisted. Pinned here so any future change to
    // move the snapshot outside the try (making state resilient to errors)
    // is intentional and updates this test.
    const r = run(`
      context.state.set('before', 'yes');
      throw new Error("mid");
    `);
    expect(r.updatedScriptState.s0).toBeUndefined();
    expect(r.errors).toHaveLength(1);
  });
});

describe("executeScripts — execution order", () => {
  test("scripts run in the order provided — executeScripts does NOT sort by sortOrder", () => {
    // Contract split: the engine iterates `input.scripts` verbatim. Sorting
    // by sortOrder is the CALLER's responsibility. prompt-resolver.ts does
    // `.sort((a, b) => a.sortOrder - b.sortOrder)` before calling; the test
    // service (single script) does not. Pinned so the split is not silently
    // moved into the engine.
    const r = run([
      { code: `context.character.personality += "A";`, sortOrder: 2 },
      { code: `context.character.personality += "B";`, sortOrder: 1 },
      { code: `context.character.personality += "C";`, sortOrder: 3 },
    ]);
    // Input order preserved verbatim; sortOrder ignored by the engine.
    expect(r.character.personality).toBe("ABC");
  });

  test("equal sortOrder preserves the input array order (stable)", () => {
    const r = run([
      { code: `context.character.personality += "X";`, sortOrder: 0, id: "x" },
      { code: `context.character.personality += "Y";`, sortOrder: 0, id: "y" },
      { code: `context.character.personality += "Z";`, sortOrder: 0, id: "z" },
    ]);
    expect(r.character.personality).toBe("XYZ");
  });

  test("state written by an earlier script is NOT visible to a later script", () => {
    // Critical invariant: each script gets its OWN state bucket. Script #2
    // cannot read script #1's writes via context.state — they are isolated by
    // script id. Cross-script communication happens only via character fields
    // and injectedMessages (shared mutable channels).
    const r = run([
      { code: `context.state.set('secret', 1);`, sortOrder: 0, id: "first" },
      { code: `context.character.personality += String(context.state.get('secret', 'none'));`, sortOrder: 1, id: "second" },
    ]);
    expect(r.character.personality).toBe("none");
    // Both buckets are persisted independently.
    expect(r.updatedScriptState.first.secret).toBe(1);
    expect(r.updatedScriptState.second).toEqual({});
  });
});

describe("executeScripts — context.persona", () => {
  test("persona exposes name and description (read-only)", () => {
    const r = run(
      `context.character.personality += context.persona.name + ":" + context.persona.description;`,
      { persona: { name: "Alice", description: "A knight." } },
    );
    expect(r.character.personality).toBe("Alice:A knight.");
  });

  test("persona is absent from context when not provided", () => {
    // No persona passed → `context.persona` is undefined. Pin so a future
    // change that always defines it (e.g. an empty default) is intentional.
    const r = run(`context.character.personality += typeof context.persona;`);
    expect(r.character.personality).toBe("undefined");
  });

  test("persona is frozen — mutation is a no-op (silent fail in sloppy mode)", () => {
    const r = run(
      `context.persona.name = "hacked"; context.character.personality += context.persona.name;`,
      { persona: { name: "Alice", description: "" } },
    );
    expect(r.character.personality).toBe("Alice");
  });
});

describe("executeScripts — context.shared", () => {
  test("a script writes, a later script reads (cross-script, same turn)", () => {
    // P5: the turn-scoped shared bucket lets script #1 hand data to script #2
    // in the same turn — something context.state cannot do (isolated by id).
    const r = run([
      { code: `context.shared.set("mood", "angry");`, id: "writer", sortOrder: 0 },
      { code: `context.character.personality += context.shared.get("mood", "calm");`, id: "reader", sortOrder: 1 },
    ]);
    expect(r.character.personality).toBe("angry");
  });

  test("shared.get(key, default) returns the default when key is absent", () => {
    const r = run(`context.character.personality += context.shared.get("missing", "fallback");`);
    expect(r.character.personality).toBe("fallback");
  });

  test("shared.increment accumulates across scripts in the same turn", () => {
    const r = run([
      { code: `context.shared.increment("ticks");`, id: "a", sortOrder: 0 },
      { code: `context.shared.increment("ticks");`, id: "b", sortOrder: 1 },
      { code: `context.character.personality += context.shared.get("ticks");`, id: "c", sortOrder: 2 },
    ]);
    expect(r.character.personality).toBe("2");
  });

  test("shared is exposed in the result (final state of the bucket)", () => {
    const r = run(`context.shared.set("k", "v");`);
    expect(r.shared).toEqual({ k: "v" });
  });

  test("shared does NOT leak into per-script state buckets", () => {
    // Critical invariant: shared and state are separate channels. A write to
    // shared must not appear in updatedScriptState, and a per-script state
    // write must not appear in shared.
    const r = run([
      { code: `context.shared.set("s", 1); context.state.set("p", 2);`, id: "x", sortOrder: 0 },
    ]);
    expect(r.shared).toEqual({ s: 1 });
    expect(r.updatedScriptState.x).toEqual({ p: 2 });
  });
});

describe("executeScripts — scriptRuns per-script breakdown (P4)", () => {
  test("one run entry per executed script, in execution order", () => {
    const r = run([
      { code: `context.character.personality += "A";`, id: "s1", sortOrder: 0 },
      { code: `context.character.personality += "B";`, id: "s2", sortOrder: 1 },
    ]);
    expect(r.scriptRuns.map((s) => s.scriptId)).toEqual(["s1", "s2"]);
  });

  test("a successful run records status 'ran' and its personality mutation", () => {
    const r = run(`context.character.personality += " appended";`, { personality: "base" });
    expect(r.scriptRuns[0].status).toBe("ran");
    expect(r.scriptRuns[0].personalityMutation).toBe("base appended");
    expect(r.scriptRuns[0].error).toBeUndefined();
  });

  test("a run that did not mutate personality records an empty mutation", () => {
    const r = run(`context.state.set("x", 1);`, { personality: "base" });
    expect(r.scriptRuns[0].personalityMutation).toBe("");
    expect(r.scriptRuns[0].scenarioMutation).toBe("");
  });

  test("an errored run records status 'errored' with the message", () => {
    const r = run(`throw new Error("boom");`);
    expect(r.scriptRuns[0].status).toBe("errored");
    expect(r.scriptRuns[0].error).toBe("boom");
  });

  test("per-run injectedMessages are scoped to the script that produced them", () => {
    const r = run([
      { code: `context.chat.injectMessage("from-a");`, id: "a", sortOrder: 0 },
      { code: `context.chat.injectMessage("from-b");`, id: "b", sortOrder: 1 },
    ]);
    expect(r.scriptRuns[0].injectedMessages).toEqual([{ content: "from-a", role: "system" }]);
    expect(r.scriptRuns[1].injectedMessages).toEqual([{ content: "from-b", role: "system" }]);
    // Aggregate is still the union (back-comat).
    expect(r.injectedMessages).toEqual([
      { content: "from-a", role: "system" },
      { content: "from-b", role: "system" },
    ]);
  });

  test("per-run console is scoped to the script that produced it", () => {
    const r = run([
      { code: `console.log("first");`, id: "a", sortOrder: 0 },
      { code: `console.log("second");`, id: "b", sortOrder: 1 },
    ]);
    expect(r.scriptRuns[0].console).toEqual([{ level: "log", args: "first" }]);
    expect(r.scriptRuns[1].console).toEqual([{ level: "log", args: "second" }]);
  });
});

describe("executeScripts — sandbox isolation", () => {
  test("globals are limited to an allowlist (no process, no require)", () => {
    // The sandbox must not leak Node primitives. `process` and `require` are
    // the obvious exfiltration vectors — pin their absence.
    const r = run(`context.character.personality += typeof process + "," + typeof require;`);
    expect(r.character.personality).toBe("undefined,undefined");
  });

  test("console methods are present and captured (not silenced)", () => {
    // P1: the sandbox captures console.log/warn/error into the per-script run
    // result so the test panel and trace can show intermediate values. They
    // still must not throw.
    const r = run(`console.log("a", 1); console.warn("b"); console.error("c"); context.character.personality += "ok";`);
    expect(r.errors).toHaveLength(0);
    expect(r.character.personality).toBe("ok");
    expect(r.scriptRuns[0].console).toEqual([
      { level: "log", args: "a 1" },
      { level: "warn", args: "b" },
      { level: "error", args: "c" },
    ]);
  });

  test("standard JS globals (Math, JSON, Date, Array, Object, RegExp) are available", () => {
    const r = run(`
      context.character.personality +=
        Math.floor(2.7) + JSON.stringify({x:1}) + Array.isArray([]) + (new RegExp("a").test("a"));
    `);
    expect(r.character.personality).toBe('2{"x":1}truetrue');
  });
});
