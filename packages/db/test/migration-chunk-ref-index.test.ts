import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";

/**
 * LONG_CHAT_PERFORMANCE_REPORT step 8 — the prompt_trace_chunk_refs(chunk_id)
 * secondary index migration.
 *
 * The refs table carried only the (trace_id, chunk_id) PK, whose left prefix
 * serves the trace side; the chunk side had no index, so every "is this
 * chunk still referenced?" lookup was a table scan. The scoped reclamation
 * (`reclaimChunksForTraces`) needs per-candidate lookups on chunk_id.
 */

const DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

async function readJournal(): Promise<JournalEntry[]> {
	const journal = JSON.parse(
		await readFile(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };
	return journal.entries;
}

describe("prompt_trace_chunk_refs chunk_id index (LONG_CHAT_PERFORMANCE_REPORT step 8)", () => {
	test("journal `when` stays strictly increasing at the tail after the new entry", async () => {
		const entries = await readJournal();
		const last = entries[entries.length - 1]!;
		const prev = entries[entries.length - 2]!;
		// The new entry must not regress the stamp (a non-increasing `when`
		// makes drizzle skip the migration on already-migrated DBs).
		expect(last.when).toBeGreaterThan(prev.when);
	});

	test("the idx-126 non-monotonic pair stays as committed (owner-closed regression — do not fix)", async () => {
		const entries = await readJournal();
		// Pre-existing, owner-closed (see the packet): 0126's `when` predates
		// 0125's. Pinned here so a future "tidy-up" cannot silently rewrite a
		// committed migration journal entry.
		expect(entries[126]!.when).toBeLessThan(entries[125]!.when);
	});

	test("the newest migration creates idx_prompt_trace_chunk_refs_chunk on chunk_id", async () => {
		const entries = await readJournal();
		const tag = entries[entries.length - 1]!.tag;
		const migrationSql = await readFile(join(DRIZZLE_DIR, `${tag}.sql`), "utf8");
		expect(migrationSql).toContain("CREATE INDEX");
		expect(migrationSql).toContain("idx_prompt_trace_chunk_refs_chunk");
		expect(migrationSql).toContain("chunk_id");
		// The (trace_id, chunk_id) PK stays the table's key — the index is
		// purely additive.
		expect(migrationSql).not.toContain("DROP");
	});

	test("a fresh DB carries the index (the test template rides the new migration)", async () => {
		const db = await createDb(":memory:");
		const rows = db.all(
			sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'prompt_trace_chunk_refs'`,
		) as unknown as Array<{ name: string }>;
		expect(rows.map((r) => r.name)).toContain("idx_prompt_trace_chunk_refs_chunk");
	});
});
