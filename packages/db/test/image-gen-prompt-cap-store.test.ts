import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { ImageGenPromptCapStore } from "../src/stores/image-gen-prompt-cap-store.js";
import type { StoreClock } from "../src/persistence.js";

// IF-10 — image_gen_prompt_caps persistence. The row is ADVISORY and
// self-healing by contract: pins cover the upsert round-trip, the
// composite-key overwrite (re-learn replaces, never duplicates), and the
// invalidateIfExceeded semantics (only an OVER-cap success deletes).

const FIXED_NOW = "2026-09-25T00:00:00.000Z";
const testClock: StoreClock = { now: () => FIXED_NOW };

let db: Awaited<ReturnType<typeof createDb>>;
let caps: ImageGenPromptCapStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  caps = new ImageGenPromptCapStore(db, { clock: testClock });
});

describe("image_gen_prompt_caps store (IF-10)", () => {
  test("upsert round-trips; get is exact on the composite key", async () => {
    await caps.upsert("nanogpt", "z-image-turbo", 1200);
    const row = await caps.get("nanogpt", "z-image-turbo");
    expect(row).not.toBeNull();
    expect(row!.maxPromptChars).toBe(1200);
    expect(row!.learnedAt).toBe(FIXED_NOW);

    expect(await caps.get("nanogpt", "qwen-image")).toBeNull();
    expect(await caps.get("a1111", "z-image-turbo")).toBeNull();
  });

  test("re-learn overwrites the same row (never duplicates)", async () => {
    await caps.upsert("nanogpt", "qwen-image", 3000);
    await caps.upsert("nanogpt", "qwen-image", 2000);
    const list = await caps.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.maxPromptChars).toBe(2000);
  });

  test("invalidateIfExceeded deletes ONLY on an over-cap length, and only that row", async () => {
    await caps.upsert("nanogpt", "z-image-turbo", 1200);
    await caps.upsert("nanogpt", "qwen-image", 3000);

    // Under cap → keep.
    expect(await caps.invalidateIfExceeded("nanogpt", "z-image-turbo", 1200)).toBe(false);
    expect(await caps.get("nanogpt", "z-image-turbo")).not.toBeNull();

    // Over cap → delete, other rows untouched.
    expect(await caps.invalidateIfExceeded("nanogpt", "z-image-turbo", 1201)).toBe(true);
    expect(await caps.get("nanogpt", "z-image-turbo")).toBeNull();
    expect(await caps.get("nanogpt", "qwen-image")).not.toBeNull();

    // Unknown row → no-op false.
    expect(await caps.invalidateIfExceeded("nanogpt", "ghost-model", 10)).toBe(false);
  });
});
