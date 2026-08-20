/**
 * Script-test service kind-dispatch tests (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B5).
 *
 * Verifies that `testScript` dispatches by `scriptKind`:
 *  - Prompt scripts keep the seven-channel tester (personality/scenario/state/
 *    inject/console/shared/errors) — their existing coverage is unchanged.
 *  - Dice scripts get discovery (check descriptors) + deterministic sample rolls
 *    against simulated persona/character inputs.
 */
import { describe, expect, test } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { Script } from "@vibe-tavern/domain";
import { testScript } from "../src/domain/scripts-engine/script-test-service.js";

function makeScript(overrides: Partial<Script> & { id: string; code: string }): Script {
  return {
    id: overrides.id,
    name: overrides.name ?? "Script",
    description: "",
    code: overrides.code,
    scriptKind: overrides.scriptKind ?? "prompt",
    enabled: overrides.enabled ?? true,
    scopeType: overrides.scopeType ?? "character",
    sortOrder: overrides.sortOrder ?? 0,
    characterId: overrides.characterId ?? "character_1",
    personaId: overrides.personaId ?? null,
    chatId: overrides.chatId ?? null,
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function storesWith(script: Script): StoreContainer {
  return {
    scripts: {
      getById: async () => ({ ...script }),
    },
  } as unknown as StoreContainer;
}

// ─── Prompt dispatch (unchanged seven-channel tester) ────────────────────────

describe("testScript — prompt dispatch", () => {
  test("returns kind:'prompt' with the seven-channel tester output", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "prompt",
      code: `context.character.personality += ", brave"; context.chat.injectMessage("note");`,
    });
    const result = await testScript(storesWith(script), {
      scriptId: "s1",
      characterName: "Aria",
      characterPersonality: "stoic",
    });

    expect(result.kind).toBe("prompt");
    if (result.kind !== "prompt") return;
    expect(result.personality).toBe("stoic, brave");
    expect(result.injectedMessages).toEqual([{ content: "note", role: "system" }]);
    expect(result.errors).toHaveLength(0);
  });

  test("a legacy script with no scriptKind defaults to prompt dispatch", async () => {
    // Simulate a mock that omits scriptKind (undefined) — must be treated as prompt.
    const script = makeScript({
      id: "s1",
      code: `context.character.scenario += " rain";`,
    });
    // @ts-expect-error — deliberately omit scriptKind to simulate legacy/mock
    delete script.scriptKind;
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    expect(result.kind).toBe("prompt");
    if (result.kind !== "prompt") return;
    expect(result.scenario).toBe(" rain");
  });
});

// ─── Dice dispatch (discovery + deterministic sample rolls) ──────────────────

const DICE_STRICT_CODE = `
context.dice.register({
  id: 'attack',
  label: 'Attack Roll',
  notation: '1d20+5',
  actors: ['persona', 'character'],
  resolution: 'strict',
  resolve() {
    var r = context.dice.roll('1d20+5');
    return {
      faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total,
      final: { total: r.total, outcome: r.total >= 15 ? 'hit' : 'miss' },
    };
  }
});
context.dice.register({
  id: 'damage',
  label: 'Damage',
  notation: '2d6',
  actors: ['character'],
  resolution: 'narrative',
  resolve() {
    var r = context.dice.roll('2d6');
    return { faces: r.faces, modifier: 0, subtotal: r.subtotal, total: r.total };
  }
});
`;

describe("testScript — dice dispatch", () => {
  test("returns kind:'dice' with check descriptors from discovery", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "dice",
      code: DICE_STRICT_CODE,
    });
    const result = await testScript(storesWith(script), {
      scriptId: "s1",
      characterName: "Dragon",
      persona: { name: "Hero", description: "" },
    });

    expect(result.kind).toBe("dice");
    if (result.kind !== "dice") return;
    expect(result.discoveryError).toBeNull();
    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((c) => c.id)).toEqual(["attack", "damage"]);
    expect(result.checks[0].faceShape).toBe("d20");
  });

  test("produces one deterministic sample roll per check", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "dice",
      code: DICE_STRICT_CODE,
    });
    const result = await testScript(storesWith(script), {
      scriptId: "s1",
      characterName: "Dragon",
    });

    if (result.kind !== "dice") return;
    expect(result.sampleRolls).toHaveLength(2);

    // attack: first allowed actor is persona, but no persona name → "Persona".
    const attackRoll = result.sampleRolls[0];
    expect(attackRoll.checkId).toBe("attack");
    expect(attackRoll.result.ok).toBe(true);

    // damage: first allowed actor is character → "Dragon".
    const damageRoll = result.sampleRolls[1];
    expect(damageRoll.checkId).toBe("damage");
    expect(damageRoll.result.ok).toBe(true);
    if (!damageRoll.result.ok) return;
    expect(damageRoll.result.faces).toHaveLength(2); // 2d6
  });

  test("sample rolls are deterministic (same result on re-run)", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "dice",
      code: DICE_STRICT_CODE,
    });
    const r1 = await testScript(storesWith(script), { scriptId: "s1", characterName: "C" });
    const r2 = await testScript(storesWith(script), { scriptId: "s1", characterName: "C" });

    if (r1.kind !== "dice" || r2.kind !== "dice") return;
    expect(r1.sampleRolls).toEqual(r2.sampleRolls);
  });

  test("reports discoveryError when the script body throws", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "dice",
      code: `throw new Error('discovery boom');`,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "dice") return;
    expect(result.discoveryError).toBe("discovery boom");
    expect(result.checks).toHaveLength(0);
    expect(result.sampleRolls).toHaveLength(0);
  });

  test("reports a sample-roll error when resolve() output fails validation", async () => {
    const code = `
context.dice.register({
  id: 'bad', label: 'Bad', notation: '1d6', actors: ['persona'], resolution: 'narrative',
  resolve() { return { faces: [3], modifier: 0, subtotal: 99, total: 99 }; }
});
`;
    const script = makeScript({ id: "s1", scriptKind: "dice", code });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "dice") return;
    expect(result.sampleRolls).toHaveLength(1);
    expect(result.sampleRolls[0].result.ok).toBe(false);
    if (result.sampleRolls[0].result.ok) return;
    expect(result.sampleRolls[0].result.error).toContain("subtotal");
  });
});

// ─── Interactive dispatch (definition discovery; Wave 1 IR-13) ───────────────

const INTERACTIVE_VALID_CODE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "tictactoe", name: "Tic-Tac-Toe" },
  capabilities: [],
  create() { return { board: ["","","","","","","","",""], turn: "X" }; },
  project(c) { return c.state; },
  actions() { return []; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

// IR-70F: an interactive script declaring a package-authored setup descriptor.
// The validated setup must reach the script-test boundary automatically through
// the existing ExperienceDefinition path (no hand-written duplicate DTO).
const INTERACTIVE_WITH_SETUP_CODE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "tictactoe", name: "Tic-Tac-Toe" },
  capabilities: [],
  setup: {
    fields: [
      { kind: "select", id: "strength", label: "Strength", default: "normal",
        options: [{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }] },
      { kind: "text", id: "style", label: "Style", placeholder: "aggressive" },
    ],
  },
  create() { return {}; },
  project(c) { return c.state; },
  actions() { return []; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

// IR-70F: a malformed setup (duplicate field ids). Discovery surfaces a
// discoveryError instead of a definition.
const INTERACTIVE_BAD_SETUP_CODE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "tictactoe", name: "Tic-Tac-Toe" },
  capabilities: [],
  setup: { fields: [
    { kind: "text", id: "dup", label: "A" },
    { kind: "boolean", id: "dup", label: "B" },
  ] },
  create() { return {}; },
  project(c) { return c.state; },
  actions() { return []; },
  reduce(c) { return { state: c.state, status: "active", events: [] }; },
});
`;

describe("testScript — interactive dispatch", () => {
  test("returns kind:'interactive' with the discovered definition", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: INTERACTIVE_VALID_CODE,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    expect(result.kind).toBe("interactive");
    if (result.kind !== "interactive") return;
    expect(result.discoveryError).toBeNull();
    expect(result.definition).not.toBeNull();
    if (!result.definition) return;
    expect(result.definition.apiVersion).toBe(1);
    expect(result.definition.manifest).toEqual({ id: "tictactoe", name: "Tic-Tac-Toe", mode: "turn" });
    expect(result.definition.declaredCapabilities).toEqual([]);
  });

  test("reports discoveryError when register() is never called", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: `// no registration`,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "interactive") return;
    expect(result.definition).toBeNull();
    expect(result.discoveryError).toBeTruthy();
  });

  test("reports discoveryError on a syntax error", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: `context.experience.register({ this is broken {{{`,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "interactive") return;
    expect(result.definition).toBeNull();
    expect(result.discoveryError).toBeTruthy();
  });

  test("does not run the prompt tester — ignores character/persona inputs", async () => {
    // Interactive scripts have their own runtime; passing prompt-tester inputs
    // must NOT turn this into a prompt run or leak prompt-tester fields.
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: INTERACTIVE_VALID_CODE,
    });
    const result = await testScript(storesWith(script), {
      scriptId: "s1",
      characterName: "Aria",
      characterPersonality: "stoic",
      persona: { name: "Hero", description: "" },
    });

    expect(result.kind).toBe("interactive");
    expect(result).not.toHaveProperty("personality");
    expect(result).not.toHaveProperty("scenario");
    expect(result).not.toHaveProperty("injectedMessages");
  });

  // IR-70F: validated setup metadata flows through the real script-test
  // boundary automatically via the existing ExperienceDefinition path.
  test("exposes a validated setup descriptor through the script-test boundary", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: INTERACTIVE_WITH_SETUP_CODE,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    expect(result.kind).toBe("interactive");
    if (result.kind !== "interactive") return;
    expect(result.discoveryError).toBeNull();
    expect(result.definition).not.toBeNull();
    if (!result.definition) return;
    expect(result.definition.setup).toEqual({
      fields: [
        { kind: "select", id: "strength", label: "Strength", default: "normal",
          options: [{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }] },
        { kind: "text", id: "style", label: "Style", placeholder: "aggressive" },
      ],
    });
  });

  test("omits setup from the script-test response when the package declares none", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: INTERACTIVE_VALID_CODE,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "interactive") return;
    if (!result.definition) return;
    expect(result.definition.setup).toBeUndefined();
  });

  test("reports discoveryError for a malformed setup (invalid_definition) without affecting prompt/dice dispatch", async () => {
    const script = makeScript({
      id: "s1",
      scriptKind: "interactive",
      code: INTERACTIVE_BAD_SETUP_CODE,
    });
    const result = await testScript(storesWith(script), { scriptId: "s1" });

    if (result.kind !== "interactive") return;
    expect(result.definition).toBeNull();
    expect(result.discoveryError).toBeTruthy();
  });
});
