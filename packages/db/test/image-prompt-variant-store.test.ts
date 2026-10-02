import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { ImagePromptVariantStore } from "../src/stores/image-prompt-variant-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// IPT-1_store — image_prompt_variants persistence (overrides-only storage).
// Pins the contract the resolver (IPT-1_resolver) and the templates API
// (IPT-3) build on:
// (1) upsert inserts a new (rowKey, family) row; get round-trips body and
//     the nullable quality_text column (absent = null, never undefined);
// (2) upsert on an existing key REPLACES the row in full — body and
//     qualityText as given (undefined qualityText clears back to canon),
//     no second row ever appears (unique row_key+family);
// (3) reset DELETES the row (back to canon — no tombstone) and is
//     idempotent;
// (4) listAll orders by (rowKey, family) and covers every stored family;
// (5) updatedAt is stamped by the store clock on every write, including
//     the conflict-update path.

let nowValue = "2026-09-21T00:00:00.000Z";
const testClock: StoreClock = { now: () => nowValue };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let variants: ImagePromptVariantStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  nowValue = "2026-09-21T00:00:00.000Z";
  variants = new ImagePromptVariantStore(db, { clock: testClock, idGenerator: testIdGen });
});

describe("image_prompt_variants store (IPT-1)", () => {
  test("upsert inserts; get round-trips body with qualityText null by default", async () => {
    expect(await variants.get("portrait", "pony")).toBeNull();

    const row = await variants.upsert({ rowKey: "portrait", family: "pony", body: "score_9, {{description}}" });
    expect(row.body).toBe("score_9, {{description}}");
    expect(row.qualityText).toBeNull();
    expect(row.updatedAt).toBe("2026-09-21T00:00:00.000Z");

    const got = await variants.get("portrait", "pony");
    expect(got).not.toBeNull();
    expect(got!.rowKey).toBe("portrait");
    expect(got!.family).toBe("pony");
    expect(got!.body).toBe("score_9, {{description}}");
    expect(got!.qualityText).toBeNull();
  });

  test("upsert on an existing key replaces the row in full — no duplicate rows", async () => {
    await variants.upsert({ rowKey: "portrait", family: "pony", body: "first", qualityText: "score_8_up" });
    nowValue = "2026-09-21T01:00:00.000Z";
    const second = await variants.upsert({ rowKey: "portrait", family: "pony", body: "second" });

    expect(second.body).toBe("second");
    // full-row semantics: the absent qualityText reverts to null (canon)
    expect(second.qualityText).toBeNull();
    expect(second.updatedAt).toBe("2026-09-21T01:00:00.000Z");

    const all = await variants.listAll();
    expect(all).toHaveLength(1);
  });

  test("upsert keeps qualityText when provided on both writes", async () => {
    await variants.upsert({ rowKey: "portrait", family: "illustrious", body: "a", qualityText: "masterpiece, newest" });
    const row = await variants.upsert({ rowKey: "portrait", family: "illustrious", body: "b", qualityText: "custom q" });
    expect(row.qualityText).toBe("custom q");
  });

  test("the shared negative row keys on the literal 'negative' beside mode slugs", async () => {
    await variants.upsert({ rowKey: "negative", family: "qwen", body: "long negative canon" });
    expect((await variants.get("negative", "qwen"))!.body).toBe("long negative canon");
    // a mode slug and 'negative' never collide
    expect(await variants.get("portrait", "qwen")).toBeNull();
  });

  test("same rowKey across families coexist (unique is the pair)", async () => {
    await variants.upsert({ rowKey: "portrait", family: "pony", body: "p" });
    await variants.upsert({ rowKey: "portrait", family: "prose", body: "pr" });
    const all = await variants.listAll();
    expect(all).toHaveLength(2);
  });

  test("reset deletes back to canon and is idempotent", async () => {
    await variants.upsert({ rowKey: "avatar", family: "prose", body: "custom avatar" });
    await variants.reset("avatar", "prose");
    expect(await variants.get("avatar", "prose")).toBeNull();

    // deleting an absent row is a no-op, not an error
    await variants.reset("avatar", "prose");
    expect(await variants.listAll()).toHaveLength(0);
  });

  test("listAll orders by rowKey then family", async () => {
    await variants.upsert({ rowKey: "portrait", family: "prose", body: "1" });
    await variants.upsert({ rowKey: "negative", family: "qwen", body: "2" });
    await variants.upsert({ rowKey: "portrait", family: "pony", body: "3" });
    await variants.upsert({ rowKey: "avatar", family: "prose", body: "4" });

    const keys = (await variants.listAll()).map((r) => `${r.rowKey}:${r.family}`);
    expect(keys).toEqual(["avatar:prose", "negative:qwen", "portrait:pony", "portrait:prose"]);
  });
});
