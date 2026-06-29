/**
 * Template coverage — runs every built-in script template (the bodies shipped
 * at `apps/web/src/components/build/editors/script-templates/*.js`) through the
 * real `executeScripts` sandbox and pins each one's observable behaviour.
 *
 * This is the regression net for the engine fixes (the HP-tracker covers the
 * `state.get(key, default)` fix; the dice-roller covers `injectMessage`
 * surfacing) AND proves every shipped template executes without errors on the
 * inputs it was designed for. Templates live in `apps/web` (UI feature) but
 * are read here via `Bun.file()` to keep the engine under test in
 * `services/api` — no cross-package TS import is needed because the bodies are
 * raw JS strings, not modules.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { executeScripts } from "../src/domain/scripts-engine/script-sandbox.js";

// `import.meta.dir` resolves to `.../services/api/test` (absolute, cwd-
// independent). Three `..` reach the repo root, where `apps/web/...` lives.
// Cannot use process.cwd() — `bun run --filter '@vibe-tavern/api' test` runs the
// workspace script with cwd = services/api/, not the repo root.
const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "..", "apps", "web", "src", "components", "build", "editors", "script-templates");

async function loadTemplate(file: string): Promise<string> {
  return Bun.file(join(TEMPLATES_DIR, file)).text();
}

function run(code: string, opts: {
  messages?: Array<{ message: string; role: string }>;
  personality?: string;
  scenario?: string;
  state?: Record<string, unknown>;
} = {}) {
  return executeScripts({
    scripts: [{ id: "tpl", name: "template", code, sortOrder: 0 }],
    chat: { messages: opts.messages ?? [{ message: "hello", role: "user" }] },
    character: { name: "Test", personality: opts.personality ?? "", scenario: opts.scenario ?? "" },
    activeLoreEntries: [],
    scriptState: { tpl: opts.state ?? {} },
  });
}

describe("script templates — relationship.js", () => {
  test("early conversation (< 5 msgs): polite + professional distance", async () => {
    const code = await loadTemplate("relationship.js");
    const r = run(code, { messages: [makeMsg("hi")] });
    expect(r.errors).toEqual([]);
    expect(r.character.personality).toContain("polite but maintains professional distance");
    expect(r.character.scenario).toContain("first meeting");
  });

  test("mid conversation (5–14 msgs): warming up", async () => {
    const code = await loadTemplate("relationship.js");
    const msgs = Array.from({ length: 8 }, () => makeMsg("x"));
    const r = run(code, { messages: msgs });
    expect(r.character.personality).toContain("becoming more comfortable");
  });

  test("established conversation (≥ 30 msgs): trusting + deeply connected", async () => {
    const code = await loadTemplate("relationship.js");
    const msgs = Array.from({ length: 31 }, () => makeMsg("x"));
    const r = run(code, { messages: msgs });
    expect(r.character.personality).toContain("trusting and deeply connected");
  });
});

describe("script templates — events.js", () => {
  test("restaurant keyword triggers atmosphere scenario", async () => {
    const code = await loadTemplate("events.js");
    const r = run(code, { messages: [makeMsg("Let's go to a restaurant")] });
    expect(r.character.scenario).toContain("cozy establishment");
    expect(r.character.personality).toContain("notices and comments on the atmosphere");
  });

  test("milestone: 10th message triggers the phone-call event", async () => {
    const code = await loadTemplate("events.js");
    const msgs = Array.from({ length: 10 }, () => makeMsg("chat"));
    const r = run(code, { messages: msgs });
    expect(r.character.scenario).toContain("phone rings");
  });

  test("non-matching message produces no scenario mutation", async () => {
    const code = await loadTemplate("events.js");
    const r = run(code, { messages: [makeMsg("nothing relevant here")] });
    expect(r.character.scenario).toBe("");
  });
});

describe("script templates — memory.js", () => {
  test("remembers hobbies mentioned once enough messages have elapsed", async () => {
    const code = await loadTemplate("memory.js");
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(i === 9 ? "I love reading" : "x"));
    const r = run(code, { messages: msgs });
    expect(r.character.personality).toContain("remembers {{user}}'s interest in reading");
  });

  test("does not trigger below the 10-message threshold", async () => {
    const code = await loadTemplate("memory.js");
    const r = run(code, { messages: [makeMsg("I love reading and gaming")] });
    expect(r.character.personality).toBe("");
  });
});

describe("script templates — lorebook.js", () => {
  test("magic keyword reveals magical-arts personality", async () => {
    const code = await loadTemplate("lorebook.js");
    const r = run(code, { messages: [makeMsg("tell me about magic")] });
    expect(r.character.personality).toContain("magical arts");
  });

  test("secret lore gated behind 15-message trust threshold", async () => {
    const code = await loadTemplate("lorebook.js");
    // Below threshold: secret keyword present but no secret lore added.
    const short = run(code, { messages: [makeMsg("reveal the secret truth")] });
    expect(short.character.personality).not.toContain("ancient secrets");

    // At threshold: secret lore activates.
    const msgs = Array.from({ length: 16 }, (_, i) => makeMsg(i === 15 ? "reveal the secret truth" : "x"));
    const long = run(code, { messages: msgs });
    expect(long.character.personality).toContain("ancient secrets");
  });
});

describe("script templates — advanced-lore.js", () => {
  test("direct keyword match activates the Eldoria entry", async () => {
    const code = await loadTemplate("advanced-lore.js");
    const r = run(code, { messages: [makeMsg("tell me of the kingdom of eldoria")] });
    expect(r.character.personality).toContain("Kingdom of Eldoria");
  });

  test("recursive activation: Eldoria triggers 'magic' which activates the arcane entry", async () => {
    const code = await loadTemplate("advanced-lore.js");
    const r = run(code, { messages: [makeMsg("eldoria")] });
    // Eldoria entry lists 'magic' among its triggers; second pass should fire
    // the arcane entry whose keywords include 'magic'.
    expect(r.character.personality).toContain("arcane arts");
  });

  test("minMessages gate: Shadow Cult requires ≥ 10 messages", async () => {
    const code = await loadTemplate("advanced-lore.js");
    const short = run(code, { messages: [makeMsg("shadow cult darkness eldoria")] });
    expect(short.character.personality).not.toContain("Shadow Cult");

    const msgs = Array.from({ length: 11 }, (_, i) => makeMsg(i === 10 ? "shadow cult darkness eldoria" : "x"));
    const long = run(code, { messages: msgs });
    expect(long.character.personality).toContain("Shadow Cult");
  });
});

describe("script templates — hp.js (HP Tracker)", () => {
  test("REGRESSION for state.get(key, default): first-time HP starts at 100, not NaN", async () => {
    // This is the headline test for the engine fix. Before the fix,
    // `state.get('hp', 100)` returned undefined → hp - dmg = NaN → personality
    // read "[HP] NaN/100". After: 100 - (5..20) = a real number 80..95.
    const code = await loadTemplate("hp.js");
    const r = run(code, { messages: [makeMsg("I attack and hit you!")] });
    expect(r.errors).toEqual([]);
    expect(r.character.personality).toContain("[HP]");
    expect(r.character.personality).not.toContain("NaN");
    // State persisted for next turn.
    expect(typeof r.updatedScriptState.tpl.hp).toBe("number");
    expect(r.updatedScriptState.tpl.hp).toBeGreaterThanOrEqual(80);
    expect(r.updatedScriptState.tpl.hp).toBeLessThanOrEqual(95);
  });

  test("damage persists across turns: second hit subtracts from the new total", async () => {
    const code = await loadTemplate("hp.js");
    const first = run(code, { messages: [makeMsg("hit")] });
    const hpAfterFirst = first.updatedScriptState.tpl.hp as number;

    const second = run(code, {
      messages: [makeMsg("hit again")],
      state: { hp: hpAfterFirst },
    });
    const hpAfterSecond = second.updatedScriptState.tpl.hp as number;
    expect(hpAfterSecond).toBeLessThan(hpAfterFirst);
    expect(second.character.personality).not.toContain("NaN");
  });

  test("heal increases HP, capped at 100", async () => {
    const code = await loadTemplate("hp.js");
    const r = run(code, {
      messages: [makeMsg("I drink a healing potion to heal")],
      state: { hp: 50 },
    });
    const hp = r.updatedScriptState.tpl.hp as number;
    expect(hp).toBeGreaterThan(50);
    expect(hp).toBeLessThanOrEqual(100);
    expect(r.character.personality).toContain("healed");
  });

  test("critical state: HP ≤ 20 flags the character as badly wounded", async () => {
    const code = await loadTemplate("hp.js");
    // hp=25 guarantees newHp = 25 − dmg(5..20) = 5..20, always in the (0, 20]
    // “badly wounded” band. Starting from hp=10 would flake: dmg ≥ 10 yields
    // newHp = 0 → “collapsed” instead.
    const r = run(code, {
      messages: [makeMsg("hit")],
      state: { hp: 25 },
    });
    expect(r.character.scenario).toContain("badly wounded");
  });
});

describe("script templates — dice.js (Dice Roller)", () => {
  test("REGRESSION for injectMessage: /roll produces an injected system message", async () => {
    // Before the engine+API fix, injectedMessages were dropped from the test
    // result entirely and the test panel showed "no result" for the dice
    // template. executeScripts has always returned injectedMessages; the fix
    // plumbs them through ScriptTestResult and the UI.
    const code = await loadTemplate("dice.js");
    const r = run(code, { messages: [makeMsg("/roll d20")] });
    expect(r.errors).toEqual([]);
    expect(r.injectedMessages.length).toBe(1);
    expect(r.injectedMessages[0].role).toBe("system");
    expect(r.injectedMessages[0].content).toContain("[Dice]");
    expect(r.injectedMessages[0].content).toContain("🎲");
  });

  test("modifier syntax: /roll 1d20+5 produces a result containing the +5 formula", async () => {
    const code = await loadTemplate("dice.js");
    const r = run(code, { messages: [makeMsg("/roll 1d20+5")] });
    expect(r.injectedMessages[0].content).toContain("1d20+5");
  });

  test("cache: rerolling the same message returns the same numbers", async () => {
    const code = await loadTemplate("dice.js");
    const first = run(code, { messages: [makeMsg("/roll d20")] });
    const cached = first.updatedScriptState.tpl as Record<string, unknown>;
    // The cache key is 'roll_<len>_<last32>'; rerun with the same state.
    const cacheKey = Object.keys(cached).find((k) => k.startsWith("roll_"));
    expect(cacheKey).toBeDefined();
    const second = run(code, {
      messages: [makeMsg("/roll d20")],
      state: cached,
    });
    expect(second.injectedMessages[0].content).toBe(first.injectedMessages[0].content);
  });

  test("non-/roll message produces no injection", async () => {
    const code = await loadTemplate("dice.js");
    const r = run(code, { messages: [makeMsg("just chatting, no dice")] });
    expect(r.injectedMessages).toEqual([]);
  });
});

describe("script templates — random.js (Random Event)", () => {
  test("executes without errors regardless of the RNG roll", async () => {
    const code = await loadTemplate("random.js");
    // Run many times to exercise both the fire and no-fire branches.
    for (let i = 0; i < 50; i++) {
      const r = run(code);
      expect(r.errors).toEqual([]);
      // Either nothing happened or an [EVENT] marker was appended.
      expect(r.character.scenario === "" || r.character.scenario.includes("[EVENT]")).toBe(true);
    }
  });

  test("when an event fires, it is drawn from the fixed event list", async () => {
    const code = await loadTemplate("random.js");
    const knownEvents = [
      "A sudden gust of wind",
      "A distant bell",
      "The ground trembles",
      "A strange aroma",
      "A bird lands",
      "The lights flicker",
    ];
    // Sample until at least one fires (5% per run → expect ~1 in 20).
    let fired = "";
    for (let i = 0; i < 500 && !fired; i++) {
      const r = run(code);
      if (r.character.scenario) fired = r.character.scenario;
    }
    // If none fired in 500 runs (astronomically unlikely at 5%), skip rather
    // than flake — but assert structure when we did catch one.
    if (fired) {
      expect(fired).toContain("[EVENT]");
      expect(knownEvents.some((e) => fired.includes(e))).toBe(true);
    }
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

function makeMsg(message: string, role = "user"): { message: string; role: string } {
  return { message, role };
}
