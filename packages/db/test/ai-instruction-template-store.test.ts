/**
 * The AI-editor instruction-template store
 * (AI_EDITOR_INSTRUCTION_TEMPLATES) — a file-by-file fork of the
 * format-template store test: dumb CRUD over ai_instruction_templates + name
 * lookups; collisions resolve ABOVE (the adapter 409s), so the store only
 * proves the projection + ordering. Named deviation from the twin: the
 * payload is plain text, so there is no JSON-parse half to pin.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { AiInstructionTemplateStore } from "../src/stores/ai-instruction-template-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import type { AppDb } from "../src/db-connection.js";

const FIXED_NOW = "2026-10-03T00:00:00.000Z";
const testClock: StoreClock = { now: () => FIXED_NOW };
let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let store: AiInstructionTemplateStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new AiInstructionTemplateStore(db, { clock: testClock, idGenerator: testIdGen });
});

describe("AiInstructionTemplateStore", () => {
  it("create → list → update text/name → delete (the small-resource round trip)", async () => {
    const created = await store.create({ name: "Сократить", text: "Сократи ответ до трёх абзацев." });
    expect(created.name).toBe("Сократить");
    expect(created.text).toBe("Сократи ответ до трёх абзацев.");

    expect((await store.list()).map((row) => row.name)).toEqual(["Сократить"]);

    const renamed = await store.update(created.id, { name: "Короче", text: "Сократи до двух абзацев." });
    expect(renamed.name).toBe("Короче");
    expect(renamed.text).toBe("Сократи до двух абзацев.");
    expect((await store.getById(created.id))?.text).toBe("Сократи до двух абзацев.");

    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("getByName matches exact names (the adapter's collision probe)", async () => {
    await store.create({ name: "Убрать пафос", text: "Убери пафос." });
    expect((await store.getByName("Убрать пафос"))?.name).toBe("Убрать пафос");
    expect(await store.getByName("убрать пафос")).toBeNull();
  });

  it("sortOrder defaults to append-last and update can override it", async () => {
    const first = await store.create({ name: "A", text: "a" });
    const second = await store.create({ name: "B", text: "b" });
    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);

    await store.update(first.id, { sortOrder: 5 });
    expect((await store.list()).map((row) => row.name)).toEqual(["B", "A"]);
  });
});
