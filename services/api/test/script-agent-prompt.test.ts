/**
 * Script-agent prompt assembly characterization (AGENT_SHELL_PLAN, Wave 3 /
 * AS-7).
 *
 * Pins what the model sees each turn for a PROMPT or DICE script thread:
 * - the API-knowledge section is the RESOLVED `script` / `dice_script`
 *   service prompt BY the thread's script kind — never both, never swapped
 *   (the plan's failure point #1) — with USER OVERRIDES honored through the
 *   active service-prompt profile (a real in-memory DB, the profile tier);
 * - the context package is rendered THROUGH the kind descriptor and carries
 *   the LIVE code buffer from the turn's input (failure point #3: the model
 *   must never be fed stale code), the trust honesty note, and the save state;
 * - the built-in `script` profile seed loads `agent-script/base.md` and
 *   honors the `script_agent_base` override on the builtin path (SP-5
 *   parity).
 *
 * Pure assembly — no agent stores; history and context arrive as function
 * input, exactly the shape the AS-8 stream caller will pass.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { assembleScriptAgentPrompt } from "../src/domain/agent/script-agent/script-agent-prompt.js";
import { SCRIPT_AGENT_RECENCY_ANCHOR_TEXT } from "../src/domain/agent/kinds/script-kind.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The default `script` service prompt's distinctive opener (asset-verified). */
const PROMPT_API_MARKER = "deterministic Script Engine";
/** The default `dice_script` service prompt's distinctive opener. */
const DICE_API_MARKER = "Dice Script Engine";

/** One tiny valid prompt script body (the live editor buffer in these tests). */
const LIVE_PROMPT_CODE = "context.character.personality += ', brave';";

/** The live request code deliberately DIFFERS from anything a store could
 *  return — the assembly has no store access, and the pin is that the INPUT
 *  code is what lands in the context package. */
const LIVE_DICE_CODE = `context.dice.register({
  id: 'attack', label: 'Attack Roll', notation: '1d20+5',
  actors: ['persona', 'character'], resolution: 'strict',
  resolve() {
    var r = context.dice.roll('1d20+5');
    return { faces: r.faces, modifier: r.modifier, subtotal: r.subtotal, total: r.total };
  }
});`;

const fixedClock: StoreClock = { now: () => "2026-10-16T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_${++counter}` };

/** Real in-memory DB with the Default service-prompt profile ensured — the
 *  same convention ai-assistant-dice-script.test.ts uses for override-tier
 *  pins. Override-free fields resolve through the default asset ladder. */
async function setupDb() {
  counter = 0;
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  await profileStore.ensureDefaultServicePromptProfile();
  return { db, profileStore, uiSettings };
}

async function overrideServicePrompt(
  profileStore: ServicePromptProfileStore,
  uiSettings: UiSettingsStore,
  field: "script" | "dice_script",
  text: string,
): Promise<void> {
  const profile = await profileStore.createServicePromptProfile({
    name: `${field} override`,
    overrides: { [field]: text },
  });
  await uiSettings.update({ activeServicePromptProfileId: profile.id });
}

// ─── API-knowledge section: resolved by script kind (failure point #1) ───────

describe("assembleScriptAgentPrompt — API section resolves by script kind", () => {
  test("a PROMPT script gets the `script` service prompt — never the dice one", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Greeting tweak",
      scriptKind: "prompt",
      scopeType: "entity",
      ownerNames: [],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
    });

    expect(result.systemMessage).toContain("# Prompt-script API reference");
    expect(result.systemMessage).toContain(PROMPT_API_MARKER);
    // Never swapped, never both (failure point #1). The base prompt's own
    // "# Kinds" section names both runtimes by design — the pin is that no
    // DICE api-reference text leaks in, hence the marker checks.
    expect(result.systemMessage).not.toContain("# Dice-script API reference");
    expect(result.systemMessage).not.toContain(DICE_API_MARKER);
  });

  test("a DICE script gets the `dice_script` service prompt — never the prompt one", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Attack check",
      scriptKind: "dice",
      scopeType: "global",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: true,
    });

    expect(result.systemMessage).toContain("# Dice-script API reference");
    expect(result.systemMessage).toContain(DICE_API_MARKER);
    expect(result.systemMessage).toContain("context.dice.register");
    expect(result.systemMessage).not.toContain("# Prompt-script API reference");
    expect(result.systemMessage).not.toContain(PROMPT_API_MARKER);
  });

  test("a user override of `dice_script` appears in the assembled context (user overrides honored)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    await overrideServicePrompt(profileStore, uiSettings, "dice_script", "CUSTOM DICE API REFERENCE");

    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Attack check",
      scriptKind: "dice",
      scopeType: "global",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: true,
      db,
    });

    expect(result.systemMessage).toContain("# Dice-script API reference");
    expect(result.systemMessage).toContain("CUSTOM DICE API REFERENCE");
    // The override REPLACES the default asset text for that section.
    expect(result.systemMessage).not.toContain(DICE_API_MARKER);
  });

  test("a user override of `script` appears for a prompt script and does not leak into dice threads", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    await overrideServicePrompt(profileStore, uiSettings, "script", "CUSTOM PROMPT API REFERENCE");

    const promptResult = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Greeting tweak",
      scriptKind: "prompt",
      scopeType: "entity",
      ownerNames: [],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
      db,
    });
    expect(promptResult.systemMessage).toContain("CUSTOM PROMPT API REFERENCE");
    expect(promptResult.systemMessage).not.toContain(PROMPT_API_MARKER);

    const diceResult = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Attack check",
      scriptKind: "dice",
      scopeType: "entity",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: true,
      db,
    });
    // Key isolation: the `script` override never reaches a dice thread.
    expect(diceResult.systemMessage).toContain(DICE_API_MARKER);
    expect(diceResult.systemMessage).not.toContain("CUSTOM PROMPT API REFERENCE");
  });
});

// ─── Context package: the LIVE code buffer (failure point #3) ────────────────

describe("assembleScriptAgentPrompt — context package carries the live buffer", () => {
  test("the LIVE request code appears verbatim — with identity, scope, and linked owners", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Greeting tweak",
      scriptKind: "prompt",
      scopeType: "entity",
      ownerNames: ["Aria", "Muse"],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
    });

    expect(result.systemMessage).toContain("# Current working context");
    expect(result.systemMessage).toContain("- Script: **Greeting tweak**");
    expect(result.systemMessage).toContain("- script_kind: **prompt**");
    expect(result.systemMessage).toContain("- Scope: entity");
    expect(result.systemMessage).toContain("- Linked owners: Aria, Muse");
    // Failure point #3: the LIVE buffer (function input), byte-for-byte.
    expect(result.systemMessage).toContain("## Current code buffer");
    expect(result.systemMessage).toContain(LIVE_PROMPT_CODE);
  });

  test("an unbound script names its ownerlessness; the trust note appears only while untrusted", async () => {
    const untrusted = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Imported thing",
      scriptKind: "dice",
      scopeType: "global",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: false,
    });
    expect(untrusted.systemMessage).toContain("- Linked owners: (none — the script is unbound)");
    // The honesty note names the refusal the tool will give.
    expect(untrusted.systemMessage).toContain("## Trust state");
    expect(untrusted.systemMessage).toContain("script_not_trusted");
    expect(untrusted.systemMessage).toContain("not yet enabled");

    const trusted = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Imported thing",
      scriptKind: "dice",
      scopeType: "global",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: true,
    });
    expect(trusted.systemMessage).not.toContain("## Trust state");
  });

  test("the buffer save state renders only when defined", async () => {
    const saved = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "S",
      scriptKind: "prompt",
      scopeType: "chat",
      ownerNames: [],
      code: "x",
      codeTrusted: true,
      codeSaved: false,
    });
    expect(saved.systemMessage).toContain("## Buffer save status");
    expect(saved.systemMessage).toContain("- code buffer: unsaved");

    const unset = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "S",
      scriptKind: "prompt",
      scopeType: "chat",
      ownerNames: [],
      code: "x",
      codeTrusted: true,
    });
    expect(unset.systemMessage).not.toContain("## Buffer save status");
  });

  test("the recency anchor rides after the pinned-context block (CX-3 through the descriptor)", async () => {
    const attached = "Some pinned reference material the user attached.";
    const result = await assembleScriptAgentPrompt({
      history: [{ role: "user", content: "fix the check" }],
      scriptName: "Attack check",
      scriptKind: "dice",
      scopeType: "entity",
      ownerNames: [],
      code: LIVE_DICE_CODE,
      codeTrusted: true,
      attachedContextBlock: attached,
    });

    const messages = result.messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    if (last.role !== "user") return;
    // Inserted BEFORE the final user turn, anchor immediately after the block.
    expect(messages[messages.length - 3]).toEqual({ role: "user", content: attached });
    expect(messages[messages.length - 2]).toEqual({
      role: "user",
      content: SCRIPT_AGENT_RECENCY_ANCHOR_TEXT,
    });
    expect(messages[messages.length - 2].content).toContain("script-authoring task");
  });
});

// ─── Context package: the full character/persona cards (AS-8e1) ─────────────

describe("assembleScriptAgentPrompt — character and persona cards (AS-8e1)", () => {
  test("a linked character's card text and a request persona's description both appear in full", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Greeting tweak",
      scriptKind: "prompt",
      scopeType: "entity",
      ownerNames: ["Aria"],
      cards: [
        { type: "character", id: "char_1", name: "Aria", content: "CARD-TEXT-ARIA-MARKER" },
        { type: "persona", id: "persona_1", name: "Muse", content: "PERSONA-DESC-MUSE-MARKER" },
      ],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
    });

    // The owners line stays (names only); the cards render in full below it.
    expect(result.systemMessage).toContain("- Linked owners: Aria");
    expect(result.systemMessage).toContain("## Character and persona cards");
    expect(result.systemMessage).toContain("### Character: Aria");
    expect(result.systemMessage).toContain("CARD-TEXT-ARIA-MARKER");
    expect(result.systemMessage).toContain("### Persona: Muse");
    expect(result.systemMessage).toContain("PERSONA-DESC-MUSE-MARKER");
  });

  test("a card shared by owner and request renders once (the caller dedupes by type+id)", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "Greeting tweak",
      scriptKind: "prompt",
      scopeType: "entity",
      ownerNames: ["Aria"],
      cards: [{ type: "character", id: "char_1", name: "Aria", content: "CARD-TEXT-ARIA-MARKER" }],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
    });

    expect(result.systemMessage.match(/### Character: Aria/g)).toHaveLength(1);
    expect(result.systemMessage.match(/CARD-TEXT-ARIA-MARKER/g)).toHaveLength(1);
  });

  test("no owners and no cards → no cards section", async () => {
    const result = await assembleScriptAgentPrompt({
      history: [],
      scriptName: "S",
      scriptKind: "prompt",
      scopeType: "global",
      ownerNames: [],
      code: LIVE_PROMPT_CODE,
      codeTrusted: true,
    });

    expect(result.systemMessage).toContain("- Linked owners: (none — the script is unbound)");
    expect(result.systemMessage).not.toContain("## Character and persona cards");
    expect(result.systemMessage).not.toContain("### Character:");
    expect(result.systemMessage).not.toContain("### Persona:");
  });
});

// ─── Built-in `script` profile seed (SP-5 parity) ────────────────────────────

describe("resolveBuiltinCopilotProfile('script') — the builtin seed", () => {
  test("loads agent-script/base.md with the module's tool set, projected through the wire keys", async () => {
    const seed = await resolveBuiltinCopilotProfile("script");
    expect(seed.id).toBe("builtin");
    expect(seed.isBuiltIn).toBe(true);
    expect(seed.agentKind).toBe("script");
    // The base prompt is the AS-7 asset (role framing verified by content).
    expect(seed.basePrompt).toContain("SCRIPT ASSISTANT");
    expect(seed.basePrompt).toContain("run_script_test");
    // Every toggleable tool the module enables is on; nothing else.
    for (const key of ["write_buffer", "edit_buffer", "run_script_test", "plan", "read_plan", "ask_user"]) {
      expect(seed.toolSet[key]).toBe(true);
    }
    expect(Object.keys(seed.toolSet)).toHaveLength(6);
  });

  test("a `script_agent_base` override replaces the seed base prompt on the builtin path (SP-5 parity)", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Script agent base override",
      overrides: { script_agent_base: "CUSTOM SCRIPT ASSISTANT BASE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const seed = await resolveBuiltinCopilotProfile("script", db);
    expect(seed.basePrompt).toBe("CUSTOM SCRIPT ASSISTANT BASE");
  });
});

// ─── Skill catalog: the AS-8d1 user-skill root ─────────────────────────────

describe("assembleScriptAgentPrompt — skillUserRoot (AS-8d1)", () => {
  test("a SKILL.md in the passed user root appears in the script assistant's catalog section", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "vt-script-agent-skills-"));
    try {
      await mkdir(join(skillRoot, "dice-recipes"), { recursive: true });
      await Bun.write(
        join(skillRoot, "dice-recipes", "SKILL.md"),
        "---\nname: dice-recipes\ndescription: Curated dice notations.\n---\n\n# dice-recipes\n",
      );

      const result = await assembleScriptAgentPrompt({
        history: [],
        scriptName: "Attack check",
        scriptKind: "dice",
        scopeType: "global",
        ownerNames: [],
        code: LIVE_DICE_CODE,
        codeTrusted: true,
        skillUserRoot: skillRoot,
      });

      // The progressive-disclosure section renders the user skill (id +
      // description + the read_skill_file manifest path).
      expect(result.systemMessage).toContain("# Available skills (read on demand)");
      expect(result.systemMessage).toContain("**dice-recipes** — Curated dice notations.");
      expect(result.systemMessage).toContain("dice-recipes/SKILL.md");
      // The derived skill roots feed read_skill_file the same root the
      // catalog was scanned from (the built-in script catalog is empty).
      expect(result.skillRoots).toContain(skillRoot);
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
    }
  });
});
