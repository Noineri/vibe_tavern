import { describe, expect, test } from "bun:test";
import type { PersonaRecord } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import { serializePersona, buildStPersonaSlice, buildVtPersonaPayload, mergeStSlices } from "../src/domain/persona/persona-export.js";

/** Minimal persona builder for fixtures. */
function persona(over: Partial<PersonaRecord> & { id: string }): PersonaRecord {
  return {
    name: "N",
    description: "",
    pronouns: null,
    pronounForms: null,
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    avatarExt: null,
    avatarFullExt: null,
    defaultForNewChats: false,
    avatarDescription: null,
    includeAvatarInPrompt: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as PersonaRecord;
}

/** Build fakes capturing only the methods serializePersona touches. */
function fakes(personaById: Record<string, Persona>, assetExt: Record<string, string>) {
  const thumbBytes: Record<string, Buffer> = {};
  const fullBytes: Record<string, Buffer> = {};
  const legacyBytes: Record<string, Buffer> = {};

  const stores = {
    personas: {
      getById: async (id: string) => personaById[id] ?? null,
    },
    characterAssets: {
      getById: async (id: string) => (assetExt[id] ? { ext: assetExt[id] } : null),
    },
  } as unknown as StoreContainer;

  const assetService = {
    loadPersonaAvatarBuffer: async (id: string, _ext: string) => thumbBytes[id] ?? null,
    loadPersonaAvatarFullBuffer: async (id: string, _ext: string) => fullBytes[id] ?? null,
    loadBuffer: async (id: string) => legacyBytes[id] ?? null,
  } as unknown as AssetService;

  return { stores, assetService, thumbBytes, fullBytes, legacyBytes };
}

describe("serializePersona", () => {
  test("returns null when the persona does not exist", async () => {
    const { stores, assetService } = fakes({}, {});
    expect(await serializePersona(stores, assetService, "missing")).toBeNull();
  });

  test("resolves folder-resident thumbnail + full", async () => {
    const p = persona({ id: "p1", avatarExt: "webp", avatarFullExt: "png" });
    const { stores, assetService, thumbBytes, fullBytes } = fakes({ p1: p }, {});
    thumbBytes.p1 = Buffer.from("thumb-bytes");
    fullBytes.p1 = Buffer.from("full-bytes");

    const out = await serializePersona(stores, assetService, "p1");
    expect(out?.persona.id).toBe("p1");
    expect(out?.avatarThumb).toEqual({ ext: "webp", bytes: Buffer.from("thumb-bytes") });
    expect(out?.avatarFull).toEqual({ ext: "png", bytes: Buffer.from("full-bytes") });
  });

  test("full is null when no separate full (thumbnail is the original — lossless)", async () => {
    const p = persona({ id: "p1", avatarExt: "png", avatarFullExt: null });
    const { stores, assetService, thumbBytes } = fakes({ p1: p }, {});
    thumbBytes.p1 = Buffer.from("thumb");

    const out = await serializePersona(stores, assetService, "p1");
    expect(out?.avatarThumb?.bytes).toEqual(Buffer.from("thumb"));
    expect(out?.avatarFull).toBeNull();
  });

  test("falls back to legacy avatarAssetId (gallery asset) with ext from characterAssets", async () => {
    const p = persona({ id: "p2", avatarExt: null, avatarAssetId: "gal_1" });
    const { stores, assetService, legacyBytes } = fakes({ p2: p }, { gal_1: "jpg" });
    legacyBytes.gal_1 = Buffer.from("legacy-bytes");

    const out = await serializePersona(stores, assetService, "p2");
    expect(out?.avatarThumb).toEqual({ ext: "jpg", bytes: Buffer.from("legacy-bytes") });
    expect(out?.avatarFull).toBeNull();
  });

  test("legacy fallback defaults ext to 'png' when the asset row is missing", async () => {
    const p = persona({ id: "p3", avatarExt: null, avatarAssetId: "gal_orphan" });
    const { stores, assetService, legacyBytes } = fakes({ p3: p }, {}); // no assetExt entry
    legacyBytes.gal_orphan = Buffer.from("orphan");

    const out = await serializePersona(stores, assetService, "p3");
    expect(out?.avatarThumb).toEqual({ ext: "png", bytes: Buffer.from("orphan") });
  });

  test("no avatar at all → both null, persona still returned", async () => {
    const p = persona({ id: "p4" });
    const { stores, assetService } = fakes({ p4: p }, {});

    const out = await serializePersona(stores, assetService, "p4");
    expect(out?.persona.id).toBe("p4");
    expect(out?.avatarThumb).toBeNull();
    expect(out?.avatarFull).toBeNull();
  });

  test("carries pronounForms through (custom case, for VT lossless export)", async () => {
    const forms = { subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself" };
    const p = persona({ id: "p5", pronouns: "custom", pronounForms: forms });
    const { stores, assetService } = fakes({ p5: p }, {});

    const out = await serializePersona(stores, assetService, "p5");
    expect(out?.persona.pronounForms).toEqual(forms);
    expect(out?.persona.pronouns).toBe("custom");
  });
});

// ─── Format builders ───────────────────────────────────────────────────────────
// Build from a neutral payload without touching the store / asset service.
function payload(over: Partial<Parameters<typeof buildVtPersonaPayload>[0]["persona"]> = {}): Parameters<typeof buildVtPersonaPayload>[0] {
  const p = persona({ id: "p1", ...over });
  return { persona: p, avatarThumb: null, avatarFull: null };
}

describe("buildStPersonaSlice", () => {
  test("expands a preset to the full 5-form ST pronoun shape", () => {
    const slice = buildStPersonaSlice(payload({ name: "Alex", pronouns: "they/them", description: "hi" }), "key.png");
    expect(slice.personas).toEqual({ "key.png": "Alex" });
    expect(slice.persona_descriptions["key.png"]?.pronoun).toEqual({
      subjective: "they", objective: "them", posDet: "their", posPro: "theirs", reflexive: "themselves",
    });
    // Neutral ST injection knobs emitted with defaults.
    expect(slice.persona_descriptions["key.png"]).toMatchObject({ position: 0, depth: 2, role: 0, lorebook: "", title: "", description: "hi" });
  });

  test("custom pronounForms flow through with the posDet/posPro key remap", () => {
    const forms = { subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself" };
    const slice = buildStPersonaSlice(payload({ pronouns: "custom", pronounForms: forms }), "k.png");
    expect(slice.persona_descriptions["k.png"]?.pronoun).toEqual({
      subjective: "ze", objective: "zir", posDet: "zir", posPro: "zirs", reflexive: "zirself",
    });
  });

  test("omits the pronoun field entirely when no forms resolve (unset / unrecognized)", () => {
    const slice = buildStPersonaSlice(payload({ pronouns: null, pronounForms: null }), "k.png");
    expect(slice.persona_descriptions["k.png"]?.pronoun).toBeUndefined();
  });
});

describe("buildVtPersonaPayload", () => {
  test("base64-encodes avatars and carries pronounForms losslessly", () => {
    const forms = { subjective: "ze", objective: "zir", possessive: "zir", possessivePronoun: "zirs", reflexive: "zirself" };
    const p = payload({ pronouns: "custom", pronounForms: forms, avatarDescription: "desc", includeAvatarInPrompt: true });
    p.avatarThumb = { ext: "png", bytes: Buffer.from("thumb") };
    const out = buildVtPersonaPayload(p);
    expect(out.version).toBe(1);
    expect(out.pronounForms).toEqual(forms);
    expect(out.avatarDescription).toBe("desc");
    expect(out.avatarThumb).toEqual({ ext: "png", bytesBase64: Buffer.from("thumb").toString("base64") });
    expect(out.avatarFull).toBeNull();
  });
});

describe("mergeStSlices", () => {
  test("merges dict entries and records the default persona key", () => {
    const a = buildStPersonaSlice(payload({ name: "A", pronouns: "she/her" }), "a.png");
    const b = buildStPersonaSlice(payload({ name: "B", pronouns: "he/him", defaultForNewChats: true }), "b.png");
    const merged = mergeStSlices([
      { slice: a, isDefault: false },
      { slice: b, isDefault: true },
    ]);
    expect(Object.keys(merged.personas).sort()).toEqual(["a.png", "b.png"]);
    expect(merged.default_persona).toBe("b.png");
  });

  test("empty default_persona when none is flagged default", () => {
    const merged = mergeStSlices([{ slice: buildStPersonaSlice(payload({ name: "A" }), "a.png"), isDefault: false }]);
    expect(merged.default_persona).toBe("");
  });
});
