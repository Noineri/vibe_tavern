import { describe, expect, test } from "bun:test";
import type { PersonaRecord } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import { serializePersona } from "../src/domain/persona/persona-export.js";

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
