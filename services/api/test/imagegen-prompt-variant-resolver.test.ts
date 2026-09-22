import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import { ImagePromptVariantStore } from "@vibe-tavern/db";
import { resolveImagePromptVariant } from "../src/domain/imagegen/prompt-variant-resolver.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

// IPT-1_resolver — the variant chain that replaced the interim service-prompt
// bridge for image template/negative rows. Pins:
// (1) BYTE-PARITY: prose family, no custom row → the resolver's text is
//     byte-identical to the authored asset file (same loader the retired
//     interim resolution used; the service-prompt seam itself is gone since
//     IPT-6) for a mode row AND the negative;
// (2) custom row wins (the overrides-only tier the Wave 3 API edits);
// (3) family canon serves the authored family variant (differs from prose —
//     no content coupling beyond that: the canon text itself is under owner
//     review);
// (4) non-authoring families fall back to prose canon (krea2 templates,
//     krea2 negative) with the honest prose-canon source label;
// (5) the negative row keys beside mode slugs with its own family chain;
// (6) free mode is family-NEUTRAL end to end: under pony it serves the prose
//     wrapper with the prose-canon label, and a (free, pony) custom row is
//     unreachable by design (both tiers see prose for free).

let db: Awaited<ReturnType<typeof createDb>>;
let variants: ImagePromptVariantStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  variants = new ImagePromptVariantStore(db);
});

describe("resolveImagePromptVariant (IPT-1)", () => {
  test("prose no-custom is byte-identical to the authored asset file", async () => {
    const modeRow = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "prose" });
    const asset = await loadPromptAsset("image-portrait.md");
    expect(modeRow.text).toBe(asset);
    expect(modeRow.source).toBe("family-canon");

    const negativeRow = await resolveImagePromptVariant(db, { rowKey: "negative", family: "prose" });
    const negativeAsset = await loadPromptAsset("image-negative.md");
    expect(negativeRow.text).toBe(negativeAsset);
  });

  test("a custom variant row wins over canon", async () => {
    await variants.upsert({ rowKey: "portrait", family: "pony", body: "my own pony template" });
    const row = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "pony" });
    expect(row.text).toBe("my own pony template");
    expect(row.source).toBe("custom");

    // prose custom also wins on the prose lookup
    await variants.upsert({ rowKey: "portrait", family: "prose", body: "my own prose template" });
    const proseRow = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "prose" });
    expect(proseRow.text).toBe("my own prose template");
    expect(proseRow.source).toBe("custom");
  });

  test("authoring family serves its own canon variant (differs from prose)", async () => {
    const pony = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "pony" });
    const prose = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "prose" });
    expect(pony.source).toBe("family-canon");
    expect(pony.text).not.toBe(prose.text);
    expect(pony.text.length).toBeGreaterThan(0);
  });

  test("non-authoring template families fall back to prose canon", async () => {
    const krea2 = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "krea2" });
    const prose = await resolveImagePromptVariant(db, { rowKey: "portrait", family: "prose" });
    expect(krea2.source).toBe("prose-canon");
    expect(krea2.text).toBe(prose.text);
  });

  test("negative rows key beside mode slugs with their own family chain", async () => {
    const qwen = await resolveImagePromptVariant(db, { rowKey: "negative", family: "qwen" });
    const prose = await resolveImagePromptVariant(db, { rowKey: "negative", family: "prose" });
    expect(qwen.source).toBe("family-canon");
    expect(qwen.text).not.toBe(prose.text);

    const krea2 = await resolveImagePromptVariant(db, { rowKey: "negative", family: "krea2" });
    expect(krea2.source).toBe("prose-canon");
    expect(krea2.text).toBe(prose.text);
  });

  test("free mode is family-neutral: prose wrapper under any family, custom rows unreachable", async () => {
    await variants.upsert({ rowKey: "free", family: "pony", body: "unreachable custom" });

    const row = await resolveImagePromptVariant(db, { rowKey: "free", family: "pony" });
    const proseFree = await resolveImagePromptVariant(db, { rowKey: "free", family: "prose" });
    expect(row.source).toBe("prose-canon");
    expect(row.text).toBe(proseFree.text);

    // the prose lookup CAN be customized (the wrapper belongs to prose)
    await variants.upsert({ rowKey: "free", family: "prose", body: "my wrapper" });
    const customized = await resolveImagePromptVariant(db, { rowKey: "free", family: "prose" });
    expect(customized.source).toBe("custom");
    expect(customized.text).toBe("my wrapper");
  });
});
