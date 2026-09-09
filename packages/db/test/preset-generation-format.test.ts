/**
 * The generation-format preset column (LOCAL_SUPPORT_PLAN LS-3a) — store-level
 * round-trip: create/update/clear through PresetStore, plus the malformed-
 * payload degrade (a broken `generation_format_json` never fails a preset
 * read — it degrades to absent = auto).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { PresetStore } from "../src/stores/preset-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import type { GenerationFormat } from "@vibe-tavern/domain";

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse("2025-05-04T12:00:00.000Z") + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

async function createStore() {
  const db = await createDb(":memory:");
  const store = new PresetStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
  return { db, store };
}

const CHATML: GenerationFormat = {
  mode: "manual",
  inputSequence: "<|im_start|>user",
  outputSequence: "<|im_start|>assistant",
  systemSequence: "<|im_start|>system",
  inputSuffix: "<|im_end|>\n",
  outputSuffix: "<|im_end|>\n",
  systemSuffix: "<|im_end|>\n",
  wrap: true,
  namesBehavior: "always",
};

describe("PresetStore — generationFormat column (LS-3a)", () => {
  beforeEach(() => {
    clockTick = 0;
    idCounters = new Map();
  });

  test("create without a format → absent (auto, pre-LS-3 back-compat)", async () => {
    const { store } = await createStore();
    const created = await store.create({ name: "Plain" });
    expect(created.generationFormat).toBeUndefined();
  });

  test("create with a manual format → round-trips verbatim", async () => {
    const { store } = await createStore();
    const created = await store.create({ name: "ChatML", generationFormat: CHATML });
    expect(created.generationFormat).toEqual(CHATML);
    const reread = (await store.listAll()).find((p) => p.name === "ChatML");
    expect(reread?.generationFormat).toEqual(CHATML);
  });

  test("update sets, replaces, and CLEARS the format (null clears back to auto)", async () => {
    const { store } = await createStore();
    const created = await store.create({ name: "Fmt" });
    expect(created.generationFormat).toBeUndefined();

    // Set
    const set = await store.update(created.id, { generationFormat: CHATML });
    expect(set?.generationFormat).toEqual(CHATML);

    // Replace with an explicit auto object (manual fields retained for switch-back)
    const auto = await store.update(created.id, { generationFormat: { mode: "auto", inputSequence: CHATML.inputSequence } });
    expect(auto?.generationFormat).toEqual({ mode: "auto", inputSequence: CHATML.inputSequence });

    // Clear (null → empty column → absent = auto)
    const cleared = await store.update(created.id, { generationFormat: null });
    expect(cleared?.generationFormat).toBeUndefined();
  });

  test("duplicate-preset duplicates the format", async () => {
    const { store } = await createStore();
    const created = await store.create({ name: "Source", generationFormat: CHATML });
    const copy = await store.duplicate(created.id);
    expect(copy.generationFormat).toEqual(CHATML);
  });

  test("a malformed generation_format_json degrades to absent (never fails the read)", async () => {
    const { db, store } = await createStore();
    const created = await store.create({ name: "Broken" });
    // Raw bun:sqlite handle via drizzle's $client (same seam as the other
    // db tests) — raw SQL is test-only; stores are the only production path.
    const raw = (db as unknown as { $client: import("bun:sqlite").Database }).$client;
    raw.prepare("UPDATE prompt_presets SET generation_format_json = '{not json' WHERE id = ?").run(created.id);
    const reread = await store.getById(created.id);
    expect(reread?.generationFormat).toBeUndefined();

    // A JSON payload with an unknown mode is equally rejected (absent = auto).
    raw.prepare("UPDATE prompt_presets SET generation_format_json = '{\"mode\":\"weird\"}' WHERE id = ?").run(created.id);
    const reread2 = await store.getById(created.id);
    expect(reread2?.generationFormat).toBeUndefined();
  });
});
