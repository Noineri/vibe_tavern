import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { TokenCountStore, tokenCountKey } from "../src/stores/token-count-store.js";
import type { StoreClock } from "../src/persistence.js";

// TC-1 (TOKEN_COUNT_ONCE_PLAN) — token_counts persistence: ONE cached count
// per (exact-text hash, tokenizer id). Writes are insert-or-ignore by design
// (a count is deterministic per tokenizer, so a repeated put can never be a
// correction — first writer wins). Pins cover the putMany→get round trip,
// the duplicate-put no-op, getMany on mixed hits/misses, and getSync (the
// TC-8 synchronous hot-path seam). The hash is an OPAQUE value here — its
// single derivation lives in TC-2's tokenizer service, so fixtures are
// arbitrary 64-char strings.

const FIXED_NOW = "2026-10-30T00:00:00.000Z";
const testClock: StoreClock = { now: () => FIXED_NOW };

// Distinct sha256-hex-shaped fixture values (the store never inspects them).
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

let db: Awaited<ReturnType<typeof createDb>>;
let store: TokenCountStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  store = new TokenCountStore(db, { clock: testClock });
});

describe("token_counts store (TC-1)", () => {
  test("putMany round-trips; get is exact on the composite key", async () => {
    await store.putMany([
      { textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 42 },
      { textHash: H2, tokenizer: "web:llama3.json", tokenCount: 7 },
    ]);

    const row = await store.get(H1, "tiktoken:cl100k_base");
    expect(row).not.toBeNull();
    expect(row!.tokenCount).toBe(42);
    expect(row!.createdAt).toBe(FIXED_NOW);

    // Miss on either half of the key.
    expect(await store.get(H3, "tiktoken:cl100k_base")).toBeNull();
    expect(await store.get(H1, "web:claude.json")).toBeNull();

    // Empty put is a no-op, never a throw.
    await store.putMany([]);
  });

  test("getSync round-trips the composite key and misses on either half", async () => {
    await store.putMany([{ textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 42 }]);
    const row = store.getSync(H1, "tiktoken:cl100k_base");
    expect(row).not.toBeNull();
    expect(row!.tokenCount).toBe(42);
    expect(row!.createdAt).toBe(FIXED_NOW);
    // Miss on either half of the key — the same composite-key exactness as
    // the async get.
    expect(store.getSync(H3, "tiktoken:cl100k_base")).toBeNull();
    expect(store.getSync(H1, "web:claude.json")).toBeNull();
    // Agrees with the async read of the same row.
    expect((await store.get(H1, "tiktoken:cl100k_base"))!.tokenCount).toBe(42);
  });

  test("duplicate put is a no-op: first write survives, no error", async () => {
    await store.putMany([{ textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 100 }]);
    // Same (hash, tokenizer) with a DIFFERENT count: insert-or-ignore keeps
    // the first value — a second write is never a correction — and must not
    // throw.
    await store.putMany([{ textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 999 }]);
    expect((await store.get(H1, "tiktoken:cl100k_base"))!.tokenCount).toBe(100);

    // Mixed batch: a duplicate and a fresh row in one putMany.
    await store.putMany([
      { textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 555 }, // ignored
      { textHash: H2, tokenizer: "tiktoken:cl100k_base", tokenCount: 5 }, // inserted
    ]);
    expect((await store.get(H1, "tiktoken:cl100k_base"))!.tokenCount).toBe(100);
    expect((await store.get(H2, "tiktoken:cl100k_base"))!.tokenCount).toBe(5);
  });

  test("getMany returns exactly the hits on a mixed batch", async () => {
    await store.putMany([
      { textHash: H1, tokenizer: "tiktoken:cl100k_base", tokenCount: 10 },
      { textHash: H2, tokenizer: "web:llama3.json", tokenCount: 20 },
    ]);

    const hits = await store.getMany([
      { textHash: H1, tokenizer: "tiktoken:cl100k_base" }, // hit
      { textHash: H2, tokenizer: "tiktoken:cl100k_base" }, // miss — wrong tokenizer
      { textHash: H3, tokenizer: "web:llama3.json" }, // miss — unknown hash
      { textHash: H2, tokenizer: "web:llama3.json" }, // hit
    ]);
    expect(hits.size).toBe(2);
    expect(hits.get(tokenCountKey(H1, "tiktoken:cl100k_base"))!.tokenCount).toBe(10);
    expect(hits.get(tokenCountKey(H2, "web:llama3.json"))!.tokenCount).toBe(20);

    // Empty lookup — no query, empty map.
    expect((await store.getMany([])).size).toBe(0);
  });
});
