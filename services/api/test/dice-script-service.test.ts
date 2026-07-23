/**
 * Dice-script service tests (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B4).
 *
 * Tests the service layer that wraps the Dice VM: home/link eligibility,
 * descriptor actor restrictions, actor-label resolution, resolve-output
 * validation (arithmetic + strict/narrative rules), structured errors, and the
 * "no provider / no prompt assembly" boundary. The store is mocked so these are
 * pure unit tests against the service's orchestration logic.
 */
import { describe, expect, test } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { Script, Persona, Character } from "@vibe-tavern/domain";
import {
  discoverDiceScripts,
  resolveDiceRoll,
  resolveEffectiveActors,
  validateRegistration,
} from "../src/domain/scripts-engine/dice-script-service.js";

// ─── Deterministic RNG ───────────────────────────────────────────────────────

function fixedRng(value: number) {
  return { intBelow: (_max: number) => value };
}

// ─── Mock store factory ──────────────────────────────────────────────────────

function makeScript(overrides: Partial<Script> & { id: string; code: string }): Script {
  return {
    id: overrides.id,
    name: overrides.name ?? "Dice Script",
    description: "",
    code: overrides.code,
    scriptKind: overrides.scriptKind ?? "dice",
    enabled: overrides.enabled ?? true,
    scopeType: overrides.scopeType ?? "chat",
    sortOrder: overrides.sortOrder ?? 0,
    characterId: overrides.characterId ?? null,
    personaId: overrides.personaId ?? null,
    chatId: overrides.chatId ?? "chat_1",
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    slug: "c1",
    name: "NPC",
    description: "",
    personalitySummary: null,
    defaultScenario: null,
    firstMessage: null,
    mesExample: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    characterBook: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    extensions: {},
    systemPrompt: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    avatarSourceAssetId: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

interface MockStoreOptions {
  diceScripts?: Script[];
  scriptById?: Record<string, Script>;
  persona?: Persona | null;
  character?: Character | null;
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona_1",
    name: "Hero",
    description: "",
    pronouns: null,
    pronounForms: null,
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    defaultForNewChats: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStores(opts: MockStoreOptions = {}): StoreContainer {
  const diceScripts = opts.diceScripts ?? [];
  const scriptById = opts.scriptById ?? {};
  return {
    scripts: {
      listAllEnabledDiceScriptsForChat: async () => [...diceScripts],
      // Override path (fix 1): filter the mock's dice set by id membership,
      // mirroring the real store's enabled+dice filter (the mock set is already
      // dice+enabled by construction, so only id selection matters here).
      listDiceScriptsByIds: async (ids: string[]) =>
        diceScripts.filter((s) => ids.includes(s.id)),
      getById: async (id: string) => scriptById[id] ?? null,
    },
    personas: {
      getById: async () => opts.persona ?? null,
    },
    characters: {
      getById: async () => opts.character ?? null,
    },
  } as unknown as StoreContainer;
}

// ─── Test script bodies ──────────────────────────────────────────────────────

const STRICT_ATTACK_CODE = `
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
`;

const PERSONA_ONLY_CODE = `
context.dice.register({
  id: 'stealth',
  label: 'Stealth',
  notation: '1d20',
  actors: ['persona'],
  resolution: 'narrative',
  resolve() {
    var r = context.dice.roll('1d20');
    return { faces: r.faces, modifier: 0, subtotal: r.subtotal, total: r.total };
  }
});
`;

// ─── Discovery ───────────────────────────────────────────────────────────────

describe("discoverDiceScripts", () => {
  test("returns validated check descriptors grouped by script", async () => {
    const stores = makeStores({
      diceScripts: [makeScript({ id: "s1", code: STRICT_ATTACK_CODE })],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1",
      personaId: "persona_1",
      chatId: "chat_1",
    });
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0].scriptId).toBe("s1");
    expect(result.scripts[0].checks).toEqual([
      {
        id: "attack",
        label: "Attack Roll",
        notation: "d20+5",
        actors: ["persona", "character"],
        resolution: "strict",
        faceShape: "d20",
      },
    ]);
    expect(typeof result.scripts[0].scriptRevision).toBe("number");
  });

  test("drops malformed registrations but keeps valid ones", async () => {
    const code = `
// valid
context.dice.register({ id: 'good', label: 'Good', notation: '1d6', actors: ['persona'], resolution: 'narrative', resolve() { return { faces:[1],modifier:0,subtotal:1,total:1 }; } });
// bad notation
context.dice.register({ id: 'bad', label: 'Bad', notation: '1d99', actors: ['persona'], resolution: 'narrative', resolve() {} });
// missing resolve
context.dice.register({ id: 'nores', label: 'NoRes', notation: '1d6', actors: ['persona'], resolution: 'narrative' });
// bad actor
context.dice.register({ id: 'badactor', label: 'BA', notation: '1d6', actors: ['monster'], resolution: 'narrative', resolve() {} });
`;
    const stores = makeStores({
      diceScripts: [makeScript({ id: "s1", code })],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
    });
    expect(result.scripts[0].checks.map((c) => c.id)).toEqual(["good"]);
  });

  test("skips scripts whose body throws during discovery", async () => {
    const stores = makeStores({
      diceScripts: [
        makeScript({ id: "broken", code: "throw new Error('discovery boom');" }),
        makeScript({ id: "good", code: STRICT_ATTACK_CODE }),
      ],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
    });
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0].scriptId).toBe("good");
  });
});

// ─── Discovery: chat-local override (fix 1) ───────────────────────────────

describe("discoverDiceScripts — chat-local override", () => {
  test("an explicit diceScriptIds array selects exactly those scripts (override)", async () => {
    const stores = makeStores({
      diceScripts: [
        makeScript({ id: "s1", code: STRICT_ATTACK_CODE }),
        makeScript({ id: "s2", code: PERSONA_ONLY_CODE }),
        makeScript({ id: "s3", code: STRICT_ATTACK_CODE }),
      ],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1",
      personaId: "persona_1",
      chatId: "chat_1",
      diceScriptIds: ["s2", "s3"],
    });
    expect(result.scripts.map((s) => s.scriptId)).toEqual(["s2", "s3"]);
  });

  test("an empty diceScriptIds array yields zero scripts (explicit empty override)", async () => {
    const stores = makeStores({
      diceScripts: [makeScript({ id: "s1", code: STRICT_ATTACK_CODE })],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      diceScriptIds: [],
    });
    expect(result.scripts).toHaveLength(0);
  });

  test("null/absent diceScriptIds inherits the resolver union", async () => {
    const stores = makeStores({
      diceScripts: [
        makeScript({ id: "s1", code: STRICT_ATTACK_CODE }),
        makeScript({ id: "s2", code: PERSONA_ONLY_CODE }),
      ],
    });
    const inherited = await discoverDiceScripts(stores, {
      characterId: "char_1", personaId: null, chatId: "chat_1",
    });
    const nulled = await discoverDiceScripts(stores, {
      characterId: "char_1", personaId: null, chatId: "chat_1", diceScriptIds: null,
    });
    expect(inherited.scripts.map((s) => s.scriptId)).toEqual(["s1", "s2"]);
    expect(nulled.scripts.map((s) => s.scriptId)).toEqual(["s1", "s2"]);
  });

  test("override drops ids absent from the effective set (deleted/disabled/non-dice)", async () => {
    const stores = makeStores({
      diceScripts: [makeScript({ id: "s1", code: STRICT_ATTACK_CODE })],
    });
    const result = await discoverDiceScripts(stores, {
      characterId: "char_1", personaId: null, chatId: "chat_1",
      diceScriptIds: ["s1", "ghost", "disabled"],
    });
    expect(result.scripts.map((s) => s.scriptId)).toEqual(["s1"]);
  });
});

// ─── Roll: happy path ────────────────────────────────────────────────────────

describe("resolveDiceRoll — happy path", () => {
  test("resolves a strict check for the persona actor", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: {
        id: "persona_1",
        name: "Hero",
        description: "",
        pronouns: null,
        pronounForms: null,
        avatarAssetId: null,
        avatarFullAssetId: null,
        avatarCropJson: null,
        avatarExt: null,
        avatarFullExt: null,
        includeAvatarInPrompt: false,
        avatarDescription: null,
        defaultForNewChats: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    // intBelow(20) = 13 → face 14 → total 19 → hit
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: "persona_1",
      chatId: "chat_1",
      rng: fixedRng(13),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll.actor.actorLabel).toBe("Hero");
    expect(result.roll.attempt.faces).toEqual([14]);
    expect(result.roll.attempt.total).toBe(19);
    expect(result.roll.attempt.attemptId).toBe("attempt_1");
    expect(result.roll.final?.outcome).toBe("hit");
    expect(result.roll.resolution).toBe("strict");
    expect(result.roll.faceShape).toBe("d20");
  });

  test("resolves a narrative check with no final", async () => {
    const script = makeScript({ id: "s1", code: PERSONA_ONLY_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: {
        id: "persona_1", name: "Hero", description: "", pronouns: null,
        pronounForms: null, avatarAssetId: null, avatarFullAssetId: null,
        avatarCropJson: null, avatarExt: null, avatarFullExt: null,
        includeAvatarInPrompt: false, avatarDescription: null,
        defaultForNewChats: false,
        createdAt: "", updatedAt: "",
      },
    });

    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "stealth",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: "persona_1",
      chatId: "chat_1",
      rng: fixedRng(10),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll.final).toBeUndefined();
    expect(result.roll.attempt.faces).toEqual([11]);
  });
});

// ─── Roll: eligibility errors ────────────────────────────────────────────────

describe("resolveDiceRoll — eligibility errors", () => {
  test("rejects when the script does not exist", async () => {
    const stores = makeStores({});
    const result = await resolveDiceRoll(stores, {
      scriptId: "ghost",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result).toEqual({ ok: false, error: { code: "script_not_found" } });
  });

  test("rejects when the script is prompt-kind (not dice)", async () => {
    const script = makeScript({ id: "s1", code: "", scriptKind: "prompt" });
    const stores = makeStores({ scriptById: { s1: script } });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result).toEqual({ ok: false, error: { code: "script_not_dice" } });
  });

  test("rejects when the script is not enabled for this chat", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    // listAllEnabledDiceScriptsForChat returns empty (script not linked/enabled)
    const stores = makeStores({ scriptById: { s1: script } });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result).toEqual({ ok: false, error: { code: "script_not_enabled_for_chat" } });
  });

  test("override EXCLUDING the rolled script rejects as not-enabled-for-chat", async () => {
    // The script IS inherited (union would include it), but the chat-local
    // override drops it — so the roll must be rejected. This is the core fix-1
    // invariant: override replaces the inherited union for THIS chat.
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: makePersona(),
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      diceScriptIds: [],
      rng: fixedRng(0),
    });
    expect(result).toEqual({ ok: false, error: { code: "script_not_enabled_for_chat" } });
  });

  test("override INCLUDING the rolled script rolls successfully", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [makeScript({ id: "other", code: STRICT_ATTACK_CODE }), script],
      scriptById: { s1: script },
      persona: makePersona(),
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      diceScriptIds: ["s1"],
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects when the actor type is not allowed by the check", async () => {
    // PERSONA_ONLY_CODE allows only persona; roll as character.
    const script = makeScript({ id: "s1", code: PERSONA_ONLY_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      character: {
        id: "char_1", slug: "c1", name: "NPC", description: "",
        personalitySummary: null, defaultScenario: null, firstMessage: null,
        mesExample: null, mesExampleMode: "always", mesExampleDepth: 4,
        alternateGreetings: [], postHistoryInstructions: null, creatorNotes: null,
        characterBook: null, depthPrompt: null, depthPromptDepth: null,
        depthPromptRole: null, extensions: {}, systemPrompt: null, tags: [],
        avatarAssetId: null, avatarFullAssetId: null, avatarCropJson: null,
        avatarExt: null, avatarFullExt: null, avatarSourceAssetId: null,
        includeGalleryInPrompt: false, includeAvatarInPrompt: false,
        avatarDescription: null, status: "active",
        createdAt: "", updatedAt: "",
      },
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "stealth",
      actorType: "character",
      actorId: "char_1",
      characterId: "char_1",
      personaId: null,
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("actor_ineligible");
  });

  test("rejects when the check id is not registered", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: {
        id: "persona_1", name: "Hero", description: "", pronouns: null,
        pronounForms: null, avatarAssetId: null, avatarFullAssetId: null,
        avatarCropJson: null, avatarExt: null, avatarFullExt: null,
        includeAvatarInPrompt: false, avatarDescription: null,
        defaultForNewChats: false, createdAt: "", updatedAt: "",
      },
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "nonexistent",
      actorType: "persona",
      actorId: "persona_1",
      characterId: "char_1",
      personaId: "persona_1",
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "check_not_found", checkId: "nonexistent" },
    });
  });

  test("rejects when the actor entity is not found", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: null,
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1",
      checkId: "attack",
      actorType: "persona",
      actorId: "ghost_persona",
      characterId: "char_1",
      personaId: "ghost_persona",
      chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("actor_not_found");
  });
});

// ─── Roll: validation errors ─────────────────────────────────────────────────

// ─── Chat-local actor binding (Rework R1) ────────────────────────────────

describe("resolveEffectiveActors — pure helper", () => {
  test("an explicit binding replaces the declared actors", () => {
    expect(resolveEffectiveActors(["persona"], ["persona", "character"])).toEqual(["persona", "character"]);
    expect(resolveEffectiveActors(["persona", "character"], ["persona"])).toEqual(["persona"]);
  });
  test("undefined binding falls back to the declared actors", () => {
    expect(resolveEffectiveActors(["persona", "character"], undefined)).toEqual(["persona", "character"]);
  });
});

describe("resolveDiceRoll — chat-local actor binding (Rework R1)", () => {
  test("default (no binding): a persona-only check rejects character", async () => {
    const script = makeScript({ id: "s1", code: PERSONA_ONLY_CODE });
    const stores = makeStores({ diceScripts: [script], scriptById: { s1: script }, character: makeCharacter() });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "stealth", actorType: "character", actorId: "char_1",
      characterId: "char_1", personaId: null, chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("actor_ineligible");
  });

  test("EXPAND: a persona-only check ALLOWS character when the binding adds it", async () => {
    const script = makeScript({ id: "s1", code: PERSONA_ONLY_CODE });
    const stores = makeStores({ diceScripts: [script], scriptById: { s1: script }, character: makeCharacter() });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "stealth", actorType: "character", actorId: "char_1",
      characterId: "char_1", personaId: null, chatId: "chat_1",
      diceActorBindings: { s1: ["persona", "character"] },
      rng: fixedRng(10),
    });
    expect(result.ok).toBe(true);
  });

  test("NARROW: a both-declared check rejects character when the binding removes it", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({ diceScripts: [script], scriptById: { s1: script }, character: makeCharacter() });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "attack", actorType: "character", actorId: "char_1",
      characterId: "char_1", personaId: null, chatId: "chat_1",
      diceActorBindings: { s1: ["persona"] },
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("actor_ineligible");
    expect((result.error as { allowed: string[] }).allowed).toEqual(["persona"]);
  });

  test("NARROW: the same binding still allows persona", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [script], scriptById: { s1: script },
      persona: makePersona(),
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "attack", actorType: "persona", actorId: "persona_1",
      characterId: "char_1", personaId: "persona_1", chatId: "chat_1",
      diceActorBindings: { s1: ["persona"] },
      rng: fixedRng(13),
    });
    expect(result.ok).toBe(true);
  });

  test("MISSING entry falls back to declared actors (binding only lists another script)", async () => {
    const script = makeScript({ id: "s1", code: STRICT_ATTACK_CODE });
    const stores = makeStores({ diceScripts: [script], scriptById: { s1: script }, character: makeCharacter() });
    // Binding lists a different script; s1 is absent → its declared both-actors apply.
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "attack", actorType: "character", actorId: "char_1",
      characterId: "char_1", personaId: null, chatId: "chat_1",
      diceActorBindings: { otherScript: ["persona"] },
      rng: fixedRng(13),
    });
    expect(result.ok).toBe(true);
  });

  test("isolation: a binding for s1 does not change s2's declared actors", async () => {
    const s1 = makeScript({ id: "s1", code: PERSONA_ONLY_CODE });
    const s2 = makeScript({ id: "s2", code: STRICT_ATTACK_CODE });
    const stores = makeStores({
      diceScripts: [s1, s2], scriptById: { s1, s2 }, character: makeCharacter(),
    });
    // s1 is persona-only; binding expands ONLY s1. Rolling s2 as character
    // must still succeed on s2's own declared both-actors.
    const r2 = await resolveDiceRoll(stores, {
      scriptId: "s2", checkId: "attack", actorType: "character", actorId: "char_1",
      characterId: "char_1", personaId: null, chatId: "chat_1",
      diceActorBindings: { s1: ["persona", "character"] },
      rng: fixedRng(13),
    });
    expect(r2.ok).toBe(true);
  });
});

describe("resolveDiceRoll — resolve-output validation", () => {
  test("rejects fabricated arithmetic (subtotal ≠ sum(faces))", async () => {
    const code = `
context.dice.register({
  id: 'bad', label: 'Bad', notation: '1d6', actors: ['persona'], resolution: 'narrative',
  resolve() { return { faces: [3], modifier: 0, subtotal: 99, total: 99 }; }
});
`;
    const script = makeScript({ id: "s1", code });
    const stores = makeStores({
      diceScripts: [script],
      scriptById: { s1: script },
      persona: {
        id: "persona_1", name: "H", description: "", pronouns: null,
        pronounForms: null, avatarAssetId: null, avatarFullAssetId: null,
        avatarCropJson: null, avatarExt: null, avatarFullExt: null,
        includeAvatarInPrompt: false, avatarDescription: null,
        defaultForNewChats: false, createdAt: "", updatedAt: "",
      },
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "bad", actorType: "persona", actorId: "persona_1",
      characterId: "char_1", personaId: "persona_1", chatId: "chat_1",
      rng: fixedRng(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_error");
  });

  test("rejects strict check without final.outcome", async () => {
    const code = `
context.dice.register({
  id: 'nofinal', label: 'NF', notation: '1d20', actors: ['persona'], resolution: 'strict',
  resolve() { var r = context.dice.roll('1d20'); return { faces: r.faces, modifier: 0, subtotal: r.subtotal, total: r.total }; }
});
`;
    const script = makeScript({ id: "s1", code });
    const stores = makeStores({
      diceScripts: [script], scriptById: { s1: script },
      persona: {
        id: "persona_1", name: "H", description: "", pronouns: null,
        pronounForms: null, avatarAssetId: null, avatarFullAssetId: null,
        avatarCropJson: null, avatarExt: null, avatarFullExt: null,
        includeAvatarInPrompt: false, avatarDescription: null,
        defaultForNewChats: false, createdAt: "", updatedAt: "",
      },
    });
    const result = await resolveDiceRoll(stores, {
      scriptId: "s1", checkId: "nofinal", actorType: "persona", actorId: "persona_1",
      characterId: "char_1", personaId: "persona_1", chatId: "chat_1",
      rng: fixedRng(10),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation_error");
    expect((result.error as { message: string }).message).toContain("strict");
  });
});

// ─── validateRegistration: help field (DICE Contract stack-audit GAP-2) ──

describe("validateRegistration — help field", () => {
  const base = {
    id: "check_1",
    label: "Check",
    notation: "1d20",
    actors: ["persona"],
    resolution: "strict",
    resolve() { return {}; },
  };

  test("extracts a non-empty help string onto the descriptor", () => {
    const def = validateRegistration({ ...base, help: "Roll above 10 to succeed" });
    expect(def).not.toBeNull();
    expect(def!.help).toBe("Roll above 10 to succeed");
  });

  test("trims help; empty/whitespace-only help is dropped (absent, not null)", () => {
    expect(validateRegistration({ ...base, help: "  trimmed help  " })!.help).toBe("trimmed help");
    expect(validateRegistration({ ...base, help: "" })!.help).toBeUndefined();
    expect(validateRegistration({ ...base, help: "   " })!.help).toBeUndefined();
  });

  test("help is optional — absent when the script did not register it", () => {
    expect(validateRegistration(base)!.help).toBeUndefined();
  });

  test("non-string help is ignored (absent), not a registration failure", () => {
    expect(validateRegistration({ ...base, help: 42 })!.help).toBeUndefined();
    expect(validateRegistration({ ...base, help: null })!.help).toBeUndefined();
  });
});
