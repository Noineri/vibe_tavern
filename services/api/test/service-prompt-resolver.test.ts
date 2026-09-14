import { describe, expect, test } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore } from "@vibe-tavern/db";
import { UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import {
  SERVICE_PROMPT_ASSET_FILES,
  getServicePromptAssetFile,
} from "../src/domain/service-prompts/service-prompt-registry.js";
import {
  getActiveServicePromptProfile,
  resolveServicePrompt,
  resolveServicePromptDefaultPreview,
} from "../src/domain/service-prompts/service-prompt-resolver.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

const fixedClock: StoreClock = { now: () => "2026-08-26T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
  counter = 0;
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  return { db, profileStore, uiSettings };
}

describe("service-prompt resolver", () => {
  test("no profile -> default asset text + source default for script", async () => {
    const { db } = await setup();
    const result = await resolveServicePrompt(db, "script");
    const expected = await loadPromptAsset(getServicePromptAssetFile("script"));
    expect(result.source).toBe("default");
    expect(result.text).toBe(expected);
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("active profile with override for script -> override text + source override", async () => {
    const { db, profileStore, uiSettings } = await setup();
    const profile = await profileStore.createServicePromptProfile({
      name: "Custom",
      overrides: { script: "OVERRIDE SCRIPT TEXT" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const active = await getActiveServicePromptProfile(db);
    expect(active.profile.id).toBe(profile.id);

    const result = await resolveServicePrompt(db, "script");
    expect(result.source).toBe("override");
    expect(result.text).toBe("OVERRIDE SCRIPT TEXT");

    // Other field still resolves to default asset.
    const other = await resolveServicePrompt(db, "summary");
    expect(other.source).toBe("default");
    expect(other.text).toBe(await loadPromptAsset(getServicePromptAssetFile("summary")));
  });

  test("override of empty string / whitespace falls back to default", async () => {
    const { db, profileStore, uiSettings } = await setup();
    const emptyProfile = await profileStore.createServicePromptProfile({
      name: "EmptyOverride",
      overrides: { script: "   " },
    });
    await uiSettings.update({ activeServicePromptProfileId: emptyProfile.id });

    const emptyResult = await resolveServicePrompt(db, "script");
    expect(emptyResult.source).toBe("default");
    expect(emptyResult.text).toBe(await loadPromptAsset(getServicePromptAssetFile("script")));

    // Also empty string
    const emptyProfile2 = await profileStore.createServicePromptProfile({
      name: "EmptyString",
      overrides: { script: "" },
    });
    await uiSettings.update({ activeServicePromptProfileId: emptyProfile2.id });
    const emptyResult2 = await resolveServicePrompt(db, "script");
    expect(emptyResult2.source).toBe("default");
  });

  test("dangling activeServicePromptProfileId resolves via Default (no throw)", async () => {
    const { db, uiSettings } = await setup();
    await uiSettings.update({ activeServicePromptProfileId: "nonexistent_id_123" });

    const active = await getActiveServicePromptProfile(db);
    expect(active.profile.id).toBe("default");
    expect(active.profile.isDefault).toBe(true);

    const result = await resolveServicePrompt(db, "script");
    expect(result.source).toBe("default");
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("resolveServicePromptDefaultPreview always returns asset text regardless of active override", async () => {
    const { db, profileStore, uiSettings } = await setup();
    const profile = await profileStore.createServicePromptProfile({
      name: "WithOverride",
      overrides: { summary: "OVERRIDE SUMMARY" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const preview = await resolveServicePromptDefaultPreview("summary");
    const asset = await loadPromptAsset(getServicePromptAssetFile("summary"));
    expect(preview).toBe(asset);
    expect(preview).not.toBe("OVERRIDE SUMMARY");
  });

  test("images family: no profile -> default asset text for image_portrait", async () => {
    const { db } = await setup();
    const result = await resolveServicePrompt(db, "image_portrait");
    const expected = await loadPromptAsset(getServicePromptAssetFile("image_portrait"));
    expect(result.source).toBe("default");
    expect(result.text).toBe(expected);
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("images family: active profile override wins only for the overridden mode", async () => {
    const { db, profileStore, uiSettings } = await setup();
    const profile = await profileStore.createServicePromptProfile({
      name: "ImageCustom",
      overrides: { image_portrait: "OVERRIDE PORTRAIT TEMPLATE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const overridden = await resolveServicePrompt(db, "image_portrait");
    expect(overridden.source).toBe("override");
    expect(overridden.text).toBe("OVERRIDE PORTRAIT TEMPLATE");

    // Other image modes still fall back to their built-in assets.
    const fallback = await resolveServicePrompt(db, "image_scene_background");
    expect(fallback.source).toBe("default");
    expect(fallback.text).toBe(await loadPromptAsset(getServicePromptAssetFile("image_scene_background")));

    // Non-image families are untouched by the image override.
    const text = await resolveServicePrompt(db, "script");
    expect(text.source).toBe("default");
  });

  test("images family: whitespace-only override falls back to the default template", async () => {
    const { db, profileStore, uiSettings } = await setup();
    const profile = await profileStore.createServicePromptProfile({
      name: "EmptyImageOverride",
      overrides: { image_negative: "   " },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const result = await resolveServicePrompt(db, "image_negative");
    expect(result.source).toBe("default");
    expect(result.text).toBe(await loadPromptAsset(getServicePromptAssetFile("image_negative")));
  });

  test("registry: keys === SERVICE_PROMPT_FIELD_KEYS and every mapped file exists on disk", async () => {
    const registryKeys = Object.keys(SERVICE_PROMPT_ASSET_FILES).sort();
    const domainKeys = [...SERVICE_PROMPT_FIELD_KEYS].sort();
    expect(registryKeys).toEqual(domainKeys);

    // Every mapped file must exist under services/api/assets/
    for (const key of SERVICE_PROMPT_FIELD_KEYS as readonly ServicePromptFieldKey[]) {
      const file = getServicePromptAssetFile(key);
      expect(file, `missing mapping for ${key}`).toBeTruthy();
      const assetFile = SERVICE_PROMPT_ASSET_FILES[key];
      expect(assetFile).toBe(file);
      // Resolve assets relative to THIS file so the pin works on any checkout
      // path/platform (the old check hardcoded an N:/ absolute path and failed on CI).
      const assetPath = `${import.meta.dir}/../assets/${file}`;
      const absExists = await Bun.file(assetPath).exists();
      expect(absExists, `asset file missing on disk: ${assetPath} (key ${key})`).toBe(true);
      const text = await loadPromptAsset(file);
      expect(text.length, `asset file empty: ${file}`).toBeGreaterThan(0);
    }
  });
});
