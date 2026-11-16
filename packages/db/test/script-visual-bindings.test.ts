import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import { ExperienceResourceStore } from "../src/stores/experience-resource-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

const REAL_DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");
const PRE_0036_LAST_TAG = "0035_nifty_alex_power";

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

/** Drizzle folder copy stopping immediately before migration 0036 (script_visuals junction). */
async function buildPre0036Folder(dir: string): Promise<string> {
	const folder = join(dir, "drizzle");
	await mkdir(folder, { recursive: true });
	const journal = JSON.parse(await readFile(resolve(REAL_DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
	const cut = journal.entries.findIndex((e) => e.tag === PRE_0036_LAST_TAG);
	if (cut < 0) throw new Error(`journal does not contain ${PRE_0036_LAST_TAG}`);
	const kept = journal.entries.slice(0, cut + 1);
	for (const entry of kept) {
		const sqlText = await readFile(resolve(REAL_DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
		await Bun.write(resolve(folder, `${entry.tag}.sql`), sqlText);
	}
	await mkdir(resolve(folder, "meta"), { recursive: true });
	await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
	return folder;
}

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

		await scripts.bindVisual(s.id, v1); // bind the already-default visual
		await scripts.bindVisual(s.id, v1); // repeat same pair to prove idempotence
		await scripts.bindVisual(s.id, v2);
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

	test("real migration 0036 backfills script_visuals from default_visual_id and skips stale defaults", async () => {
		const work = await mkdtemp(join(tmpdir(), "vt-scriptvis-0036-"));
		const preFolder = await buildPre0036Folder(work);
		const dbPath = join(work, "upgrade.db");
		const preDb = await createDb(dbPath, preFolder);

		const beforeTable = preDb.$client
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'script_visuals'")
			.get();
		expect(beforeTable).toBeNull();

		preDb.$client.exec(`
			INSERT INTO experience_visuals (id, name, source, source_hash, api_version, scope_type, created_at, updated_at)
			VALUES ('vis_1', 'V', 'V', 'hash_v1', 1, 'global', '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z');
			INSERT INTO scripts (id, name, scope_type, default_visual_id, created_at, updated_at)
			VALUES
				('sc_valid', 'S', 'global', 'vis_1', '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z'),
				('sc_stale', 'stale', 'global', 'ghost_visual', '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z');
		`);
		preDb.$client.close();

		// Upgrade through the real committed migrations (0036+ through latest).
		const upgradedDb = await createDb(dbPath);
		const upgradedScripts = new ScriptStore(upgradedDb, {
			content: new ContentStore({ fileStore: createFileStore(work) }),
			clock: fixedClock,
			idGenerator: idGen,
		});

		expect(await upgradedScripts.getBoundVisualIds("sc_valid")).toEqual(["vis_1"]);
		expect(await upgradedScripts.getBoundVisualIds("sc_stale")).toEqual([]);
	});
});
