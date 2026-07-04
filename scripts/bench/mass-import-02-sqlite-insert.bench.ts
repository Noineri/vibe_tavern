/**
 * Bench #2 — SQLite insert strategies for mass character import.
 *
 * The reported "2-hour hang" is almost certainly not PNG parse (bench #1 showed
 * 324ms for 1300 cards). The prime suspect is SQLite N+1: today's `importJson`
 * runs without an explicit transaction, so each insert is an auto-commit — and
 * every auto-commit forces a WAL fsync on disk-backed SQLite.
 *
 * This bench isolates the DB layer (no HTTP, no parsing, no snapshot) and
 * compares four strategies for inserting 1300 characters + their seed chat
 * (roughly mirroring one importJson's write footprint):
 *
 *   A. auto-commit       — current per-call shape (1 fsync per write)
 *   B. single txn        — all 1300 inserts in one db.transaction()
 *   C. chunked txn (50)  — txn per 50 inserts
 *   D. chunked txn (500) — txn per 500 inserts (Gemini's recommendation)
 *
 * File-backed temp DB (NOT in-memory) so the fsync cost reflects what a user
 * with an HDD or slow SSD actually pays. WAL mode + synchronous=FULL to match
 * prod durability. Uses bun:sqlite directly (no Drizzle) to isolate DB cost.
 */
import { Database } from "bun:sqlite";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUNT = 1300;

function fmt(ms: number): string {
	return ms.toFixed(1);
}

function makeRow(i: number) {
	return {
		id: `char_bench_${i}_${Math.random().toString(36).slice(2, 8)}`,
		slug: `bench-${i}`,
		name: `Bench Character ${i}`,
		description: "x".repeat(2000),
		personality_summary: "y".repeat(500),
		default_scenario: "z".repeat(500),
		first_message: "opening",
		mes_example: "",
		creator_notes: "",
		system_prompt: "",
		post_history_instructions: "",
		depth_prompt: null,
		depth_prompt_depth: 4,
		depth_prompt_role: "system",
		alternate_greetings_json: "[]",
		extensions_json: "{}",
		tags_json: "[]",
		character_book_json: null,
		avatar_asset_id: null,
		avatar_full_asset_id: null,
		avatar_ext: null,
		status: "active",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

function makeChatRow(i: number, charId: string) {
	return {
		id: `chat_bench_${i}`,
		character_id: charId,
		persona_id: null,
		active_branch_id: `brnch_bench_${i}`,
		prompt_preset_id: null,
		mode: "rp",
		title: `Bench Chat ${i}`,
		summary: "",
		message_history_limit: 0,
		auto_summary_config_json: '{"enabled":false}',
		status: "active",
		selected_greeting_index: 0,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		lore_activation_state_json: "{}",
		script_state_json: "{}",
		coauthor_lorebook_ids_json: "[]",
		coauthor_module_id: null,
	};
}

function setupDb(dbPath: string): Database {
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA synchronous = FULL;");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE characters (
			id text PRIMARY KEY NOT NULL,
			slug text NOT NULL,
			name text NOT NULL,
			description text NOT NULL,
			personality_summary text,
			default_scenario text,
			first_message text,
			mes_example text NOT NULL DEFAULT '',
			creator_notes text,
			system_prompt text,
			post_history_instructions text,
			depth_prompt text,
			depth_prompt_depth integer,
			depth_prompt_role text,
			alternate_greetings_json text NOT NULL DEFAULT '[]',
			extensions_json text NOT NULL DEFAULT '{}',
			tags_json text NOT NULL DEFAULT '[]',
			character_book_json text,
			avatar_asset_id text,
			avatar_full_asset_id text,
			avatar_ext text,
			status text NOT NULL DEFAULT 'active',
			created_at text NOT NULL,
			updated_at text NOT NULL
		);
		CREATE TABLE chats (
			id text PRIMARY KEY NOT NULL,
			character_id text NOT NULL,
			persona_id text,
			active_branch_id text NOT NULL,
			prompt_preset_id text,
			mode text NOT NULL DEFAULT 'rp',
			title text NOT NULL,
			summary text NOT NULL DEFAULT '',
			message_history_limit integer NOT NULL DEFAULT 0,
			auto_summary_config_json text NOT NULL DEFAULT '{}',
			status text NOT NULL DEFAULT 'active',
			selected_greeting_index integer NOT NULL DEFAULT 0,
			created_at text NOT NULL,
			updated_at text NOT NULL,
			lore_activation_state_json text NOT NULL DEFAULT '{}',
			script_state_json text NOT NULL DEFAULT '{}',
			coauthor_lorebook_ids_json text NOT NULL DEFAULT '[]',
			coauthor_module_id text,
			FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE cascade
		);
	`);
	return sqlite;
}

function resetTables(db: Database) {
	db.run("DELETE FROM chats;");
	db.run("DELETE FROM characters;");
}

function insertOne(db: Database, i: number) {
	const char = makeRow(i);
	db.run(
		`INSERT INTO characters (id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, creator_notes, system_prompt, post_history_instructions, depth_prompt, depth_prompt_depth, depth_prompt_role, alternate_greetings_json, extensions_json, tags_json, character_book_json, avatar_asset_id, avatar_full_asset_id, avatar_ext, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[char.id, char.slug, char.name, char.description, char.personality_summary, char.default_scenario, char.first_message, char.mes_example, char.creator_notes, char.system_prompt, char.post_history_instructions, char.depth_prompt, char.depth_prompt_depth, char.depth_prompt_role, char.alternate_greetings_json, char.extensions_json, char.tags_json, char.character_book_json, char.avatar_asset_id, char.avatar_full_asset_id, char.avatar_ext, char.status, char.created_at, char.updated_at],
	);
	const chat = makeChatRow(i, char.id);
	db.run(
		`INSERT INTO chats (id, character_id, persona_id, active_branch_id, prompt_preset_id, mode, title, summary, message_history_limit, auto_summary_config_json, status, selected_greeting_index, created_at, updated_at, lore_activation_state_json, script_state_json, coauthor_lorebook_ids_json, coauthor_module_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[chat.id, chat.character_id, chat.persona_id, chat.active_branch_id, chat.prompt_preset_id, chat.mode, chat.title, chat.summary, chat.message_history_limit, chat.auto_summary_config_json, chat.status, chat.selected_greeting_index, chat.created_at, chat.updated_at, chat.lore_activation_state_json, chat.script_state_json, chat.coauthor_lorebook_ids_json, chat.coauthor_module_id],
	);
}

function strategyAutoCommit(db: Database) {
	for (let i = 0; i < COUNT; i++) insertOne(db, i);
}

function strategySingleTxn(db: Database) {
	db.transaction(() => {
		for (let i = 0; i < COUNT; i++) insertOne(db, i);
	})();
}

function strategyChunkedTxn(db: Database, chunkSize: number) {
	for (let start = 0; start < COUNT; start += chunkSize) {
		db.transaction(() => {
			for (let i = start; i < Math.min(start + chunkSize, COUNT); i++) insertOne(db, i);
		})();
	}
}

function timeIt(label: string, fn: (db: Database) => void): number {
	const tmp = mkdtempSync(join(tmpdir(), "vt-bench-"));
	const dbPath = join(tmp, "bench.db");
	try {
		const db = setupDb(dbPath);
		insertOne(db, -1); // warmup
		resetTables(db);

		const t0 = Bun.nanoseconds();
		fn(db);
		const ms = (Bun.nanoseconds() - t0) / 1_000_000;

		const charCount = db.query("SELECT COUNT(*) as n FROM characters").get() as { n: number };
		const chatCount = db.query("SELECT COUNT(*) as n FROM chats").get() as { n: number };
		console.log(`  ${label.padEnd(28)} ${fmt(ms).padStart(9)} ms  (${charCount.n} chars, ${chatCount.n} chats)`);
		return ms;
	} finally {
		try { rmSync(dbPath); } catch {}
		try { rmSync(dbPath + "-wal"); } catch {}
		try { rmSync(dbPath + "-shm"); } catch {}
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
	}
}

function main() {
	console.log(`Bench #2 — SQLite insert strategies for ${COUNT} characters (+1 chat each).`);
	console.log(`File-backed temp DB, WAL mode, synchronous=FULL (mirrors prod durability).`);
	console.log("");

	const autoReal = timeIt("A. auto-commit (current)", (db) => strategyAutoCommit(db));
	const single = timeIt("B. single transaction", (db) => strategySingleTxn(db));
	const chunk50 = timeIt("C. chunked txn (50)", (db) => strategyChunkedTxn(db, 50));
	const chunk500 = timeIt("D. chunked txn (500)", (db) => strategyChunkedTxn(db, 500));

	console.log("");
	console.log("─── Relative speedup vs current (auto-commit) ───");
	console.log(`  B. single txn:        ${(autoReal / single).toFixed(1)}× faster`);
	console.log(`  C. chunked txn (50):  ${(autoReal / chunk50).toFixed(1)}× faster`);
	console.log(`  D. chunked txn (500): ${(autoReal / chunk500).toFixed(1)}× faster`);
	console.log("");
	console.log(`Note: WAL fsync cost dominates auto-commit. On an HDD (the reported`);
	console.log(`case), each fsync is 5-20ms; ${COUNT} of them is 6.5-26s of pure I/O. On`);
	console.log(`this dev machine (NVMe), the absolute number is small but the ratio holds.`);
}

main();
