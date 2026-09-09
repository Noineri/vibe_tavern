/**
 * The LS-10 format-template library store (the sampler-set store pattern):
 * dumb CRUD over format_templates + name lookups; collisions resolve ABOVE
 * (the adapter 409s), so the store only proves the projection + ordering.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import { FormatTemplateStore } from "../src/stores/format-template-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import type { AppDb } from "../src/db-connection.js";

const FIXED_NOW = "2026-09-09T00:00:00.000Z";
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
let store: FormatTemplateStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new FormatTemplateStore(db, { clock: testClock, idGenerator: testIdGen });
});

const PAYLOAD = { mode: "manual", inputSequence: "<|u|>", outputSequence: "<|a|>" };

describe("FormatTemplateStore (LS-10)", () => {
  it("create → list → update payload → delete (the small-resource round trip)", async () => {
    const created = await store.create({ name: "My ChatML", payload: PAYLOAD });
    expect(created.name).toBe("My ChatML");
    expect(created.payload).toEqual(PAYLOAD);

    expect((await store.list()).map((row) => row.name)).toEqual(["My ChatML"]);

    const renamed = await store.update(created.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect((await store.getById(created.id))?.name).toBe("Renamed");

    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("getByName matches exact names (the adapter's collision probe)", async () => {
    await store.create({ name: "Divine ChatML", payload: PAYLOAD });
    expect((await store.getByName("Divine ChatML"))?.name).toBe("Divine ChatML");
    expect(await store.getByName("divine chatml")).toBeNull();
  });

  it("sortOrder defaults to append-last and update can override it", async () => {
    const first = await store.create({ name: "A", payload: PAYLOAD });
    const second = await store.create({ name: "B", payload: PAYLOAD });
    expect(first.sortOrder).toBeLessThan(second.sortOrder);
    await store.update(second.id, { sortOrder: -1 });
    const list = await store.list();
    expect(list[0]?.name).toBe("B");
  });

  it("a malformed payload row degrades to an empty record (never throws)", async () => {
    const created = await store.create({ name: "X", payload: PAYLOAD });
    db.run(sql`UPDATE format_templates SET payload_json = '{not json' WHERE id = ${created.id}`);
    const row = await store.getById(created.id);
    expect(row?.payload).toEqual({});
  });
});
