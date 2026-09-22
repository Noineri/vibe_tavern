import { describe, test, expect, beforeEach } from "bun:test";
import { createDb, ImagePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { resolveActiveImagePromptOverrides, resolveImagePromptVariant } from "../src/domain/imagegen/prompt-variant-resolver.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

// IF-1c — the variant chain reworked onto the ACTIVE image prompt profile.
// The custom tier's source moved from the global image_prompt_variants table
// to a profile's overrides map (the resolver takes the map as a parameter;
// resolveActiveImagePromptOverrides reads the pointer). Pins — SAME boundary
// as the IPT-1 suite, new seam:
// (1) BYTE-PARITY: an empty overrides map (no active profile) → the
//     resolver's text is byte-identical to the authored asset file for a
//     mode row AND the negative;
// (2) a profile override cell wins (the tier the profile API edits);
// (3) family canon serves the authored family variant (differs from prose);
// (4) non-authoring families fall back to prose canon (krea2 templates,
//     krea2 negative) with the honest prose-canon source label;
// (5) the negative row keys beside mode slugs with its own family chain;
// (6) free mode is family-NEUTRAL end to end: under pony it serves the prose
//     wrapper with the prose-canon label, and a (free, pony) override cell is
//     unreachable by design (both tiers see prose for free);
// (7) the pointer seam: no pointer / dangling pointer / the read-only
//     Default profile all resolve the empty map (pure canon).

const fixedClock: StoreClock = { now: () => "2026-09-22T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

let db: Awaited<ReturnType<typeof createDb>>;
let profiles: ImagePromptProfileStore;
let uiSettings: UiSettingsStore;

beforeEach(async () => {
  counter = 0;
  db = await createDb(":memory:");
  profiles = new ImagePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
});

describe("resolveImagePromptVariant (IF-1c profile chain)", () => {
  test("empty overrides (no active profile) is byte-identical to the authored asset file", async () => {
    const modeRow = await resolveImagePromptVariant({ rowKey: "portrait", family: "prose" }, {});
    const asset = await loadPromptAsset("image-portrait.md");
    expect(modeRow.text).toBe(asset);
    expect(modeRow.source).toBe("family-canon");

    const negativeRow = await resolveImagePromptVariant({ rowKey: "negative", family: "prose" }, {});
    const negativeAsset = await loadPromptAsset("image-negative.md");
    expect(negativeRow.text).toBe(negativeAsset);
  });

  test("a profile override cell wins over canon", async () => {
    const row = await resolveImagePromptVariant(
      { rowKey: "portrait", family: "pony" },
      { "portrait|pony": { body: "my own pony template" } },
    );
    expect(row.text).toBe("my own pony template");
    expect(row.source).toBe("custom");

    // prose override also wins on the prose lookup
    const proseRow = await resolveImagePromptVariant(
      { rowKey: "portrait", family: "prose" },
      { "portrait|prose": { body: "my own prose template" } },
    );
    expect(proseRow.text).toBe("my own prose template");
    expect(proseRow.source).toBe("custom");
  });

  test("authoring family serves its own canon variant (differs from prose)", async () => {
    const pony = await resolveImagePromptVariant({ rowKey: "portrait", family: "pony" }, {});
    const prose = await resolveImagePromptVariant({ rowKey: "portrait", family: "prose" }, {});
    expect(pony.source).toBe("family-canon");
    expect(pony.text).not.toBe(prose.text);
    expect(pony.text.length).toBeGreaterThan(0);
  });

  test("non-authoring template families fall back to prose canon", async () => {
    const krea2 = await resolveImagePromptVariant({ rowKey: "portrait", family: "krea2" }, {});
    const prose = await resolveImagePromptVariant({ rowKey: "portrait", family: "prose" }, {});
    expect(krea2.source).toBe("prose-canon");
    expect(krea2.text).toBe(prose.text);
  });

  test("negative rows key beside mode slugs with their own family chain", async () => {
    const qwen = await resolveImagePromptVariant({ rowKey: "negative", family: "qwen" }, {});
    const prose = await resolveImagePromptVariant({ rowKey: "negative", family: "prose" }, {});
    expect(qwen.source).toBe("family-canon");
    expect(qwen.text).not.toBe(prose.text);

    const krea2 = await resolveImagePromptVariant({ rowKey: "negative", family: "krea2" }, {});
    expect(krea2.source).toBe("prose-canon");
    expect(krea2.text).toBe(prose.text);
  });

  test("free mode is family-neutral: prose wrapper under any family, pony cells unreachable", async () => {
    const row = await resolveImagePromptVariant(
      { rowKey: "free", family: "pony" },
      // The profile API refuses (free, non-prose) cells; even a smuggled one
      // (direct store write) stays unreachable — both tiers see prose.
      { "free|pony": { body: "unreachable custom" } },
    );
    const proseFree = await resolveImagePromptVariant({ rowKey: "free", family: "prose" }, {});
    expect(row.source).toBe("prose-canon");
    expect(row.text).toBe(proseFree.text);

    // the prose lookup CAN be customized (the wrapper belongs to prose)
    const customized = await resolveImagePromptVariant(
      { rowKey: "free", family: "prose" },
      { "free|prose": { body: "my wrapper" } },
    );
    expect(customized.source).toBe("custom");
    expect(customized.text).toBe("my wrapper");
  });
});

describe("resolveActiveImagePromptOverrides (the pointer seam)", () => {
  test("no pointer → the empty map (pure canon)", async () => {
    await uiSettings.ensureDefaults();
    expect(await resolveActiveImagePromptOverrides(db)).toEqual({});
  });

  test("active profile's overrides resolve through the chain", async () => {
    await uiSettings.ensureDefaults();
    const profile = await profiles.createImagePromptProfile({
      name: "Tuned",
      overrides: { "portrait|prose": { body: "P" } },
    });
    await uiSettings.update({ activeImagePromptProfileId: profile.id });

    const overrides = await resolveActiveImagePromptOverrides(db);
    expect(overrides).toEqual({ "portrait|prose": { body: "P", qualityText: null } });

    const row = await resolveImagePromptVariant({ rowKey: "portrait", family: "prose" }, overrides);
    expect(row.source).toBe("custom");
    expect(row.text).toBe("P");
  });

  test("dangling pointer and the Default profile both resolve the empty map", async () => {
    await uiSettings.ensureDefaults();
    await uiSettings.update({ activeImagePromptProfileId: "ipp_gone" });
    expect(await resolveActiveImagePromptOverrides(db)).toEqual({});

    await profiles.ensureDefaultImagePromptProfile();
    await uiSettings.update({ activeImagePromptProfileId: "default" });
    expect(await resolveActiveImagePromptOverrides(db)).toEqual({});
  });
});
