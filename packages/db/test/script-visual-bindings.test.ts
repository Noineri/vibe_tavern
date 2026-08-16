import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import { ExperienceResourceStore } from "../src/stores/experience-resource-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-scriptvis-test-"));
	const db = await createDb(":memory:");
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const scripts = new ScriptStore(db, { content, clock: fixedClock, idGenerator: idGen });
	const resources = new ExperienceResourceStore(db);
	return { db, scripts, resources };
}

async function mkVisual(resources: ExperienceResourceStore, name: string): Promise<string> {
	const v = await resources.createVisual({ name, source: name, apiVersion: 1, scopeType: "global" });
	return v.id;
}

/** The backfill statement from migration 0036 (must stay byte-identical to the
 *  `INSERT ... SELECT` in `packages/db/drizzle/0036_hard_sabretooth.sql`). */
const BACKFILL_SQL = sql`INSERT INTO "script_visuals" ("script_id", "visual_id")
SELECT s."id", s."default_visual_id"
FROM "scripts" s
WHERE s."default_visual_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "experience_visuals" v WHERE v."id" = s."default_visual_id")
ON CONFLICT("script_id", "visual_id") DO NOTHING`;

// BE-5: the script_visuals junction + the "primary ∈ bound set" invariant.
// The invariant is maintained on bind/unbind: the first bound visual becomes
// the primary; unbinding the primary reassigns it to a remaining visual (or
// null when the set empties). This is characterization of the store contract
// that the Wave 2 UI (Build binding + chat dropdown narrowing) depends on.
describe("ScriptStore visual bindings (script_visuals junction)", () => {
	test("bindVisual auto-sets the default when none exists (first visual becomes primary)", async () => {
		const { scripts, resources } = await setup();
		const s = await scripts.create({ name: "S", scopeType: "global" });
		expect(s.defaultVisualId).toBeNull();
		const v1 = await mkVisual(resources, "V1");

		await scripts.bindVisual(s.id, v1);

		expect((await scripts.getBoundVisualIds(s.id)).sort()).toEqual([v1]);
		const after = await scripts.getById(s.id);
		expect(after?.defaultVisualId).toBe(v1);
	});

	test("bindVisual is idempotent and does not change an existing default", async () => {
		const { scripts, resources } = await setup();
		const v1 = await mkVisual(resources, "V1");
		const v2 = await mkVisual(resources, "V2");
		const s = await scripts.create({ name: "S", scopeType: "global", defaultVisualId: v1 });

		await scripts.bindVisual(s.id, v1); // bind the already-default visual again
		await scripts.bindVisual(s.id, v2);

		expect((await scripts.getBoundVisualIds(s.id)).sort()).toEqual([v1, v2]);
		const after = await scripts.getById(s.id);
		expect(after?.defaultVisualId).toBe(v1); // unchanged — default was non-null
	});

	test("unbindVisual reassigns the default to a remaining bound visual (invariant holds)", async () => {
		const { scripts, resources } = await setup();
		const v1 = await mkVisual(resources, "V1");
		const v2 = await mkVisual(resources, "V2");
		const s = await scripts.create({ name: "S", scopeType: "global" });
		await scripts.bindVisual(s.id, v1); // v1 becomes default (first)
		await scripts.bindVisual(s.id, v2);

		// Unbind the PRIMARY (v1) → default must reassign to a remaining member.
		await scripts.unbindVisual(s.id, v1);

		const boundAfter = (await scripts.getBoundVisualIds(s.id)).sort();
		expect(boundAfter).toEqual([v2]);
		const after = await scripts.getById(s.id);
		expect(after?.defaultVisualId).toBe(v2); // ∈ bound set
	});

	test("unbindVisual clears the default when the bound set empties", async () => {
		const { scripts, resources } = await setup();
		const v1 = await mkVisual(resources, "V1");
		const s = await scripts.create({ name: "S", scopeType: "global" });
		await scripts.bindVisual(s.id, v1);

		await scripts.unbindVisual(s.id, v1);

		expect(await scripts.getBoundVisualIds(s.id)).toEqual([]);
		const after = await scripts.getById(s.id);
		expect(after?.defaultVisualId).toBeNull();
	});

	test("unbindVisual is idempotent and leaves the default untouched when unbinding a non-primary", async () => {
		const { scripts, resources } = await setup();
		const v1 = await mkVisual(resources, "V1");
		const v2 = await mkVisual(resources, "V2");
		const s = await scripts.create({ name: "S", scopeType: "global" });
		await scripts.bindVisual(s.id, v1); // default
		await scripts.bindVisual(s.id, v2);

		await scripts.unbindVisual(s.id, v2); // non-primary
		await scripts.unbindVisual(s.id, v2); // idempotent repeat

		expect((await scripts.getBoundVisualIds(s.id)).sort()).toEqual([v1]);
		const after = await scripts.getById(s.id);
		expect(after?.defaultVisualId).toBe(v1); // untouched
	});

	test("listScriptsBoundToVisual returns the scripts that bound a given visual", async () => {
		const { scripts, resources } = await setup();
		const v1 = await mkVisual(resources, "V1");
		const v2 = await mkVisual(resources, "V2");
		const s1 = await scripts.create({ name: "S1", scopeType: "global", sortOrder: 10 });
		const s2 = await scripts.create({ name: "S2", scopeType: "global", sortOrder: 20 });
		await scripts.bindVisual(s1.id, v1);
		await scripts.bindVisual(s2.id, v1);
		await scripts.bindVisual(s2.id, v2);

		expect((await scripts.listScriptsBoundToVisual(v1)).map((x) => x.id).sort()).toEqual([s1.id, s2.id]);
		expect((await scripts.listScriptsBoundToVisual(v2)).map((x) => x.id)).toEqual([s2.id]);
		expect(await scripts.listScriptsBoundToVisual("nope")).toEqual([]);
	});

	test("backfill populates the junction from default_visual_id (upgrade path); stale defaults skipped", async () => {
		const { db, scripts, resources } = await setup();
		const v = await mkVisual(resources, "V");
		// Created WITH a default but NO junction row — mirrors the Wave 1 seed
		// state before the script_visuals junction existed (BE-4 set
		// defaultVisualId; the junction lands in BE-5).
		const s = await scripts.create({ name: "S", scopeType: "global", defaultVisualId: v });
		expect(await scripts.getBoundVisualIds(s.id)).toEqual([]); // pre-backfill

		// Stale default → points at a visual that does not exist.
		const stale = await scripts.create({ name: "stale", scopeType: "global", defaultVisualId: "ghost_visual" });

		await db.run(BACKFILL_SQL);

		expect(await scripts.getBoundVisualIds(s.id)).toEqual([v]); // backfilled
		expect(await scripts.getBoundVisualIds(stale.id)).toEqual([]); // EXISTS guard skipped it
	});
});
