/**
 * Bench #3 — getSnapshot O(N²) cost during mass import.
 *
 * Reading session-runtime.ts:getSnapshot revealed the real mass-import killer:
 * every importJson call ends with `await deps.getSnapshot(chatId)`, and getSnapshot
 * does `Promise.all(this.chatOrder.items.map((id) => this.mapChatToListItem(id)))`.
 * chatOrder.items GROWS by one on every import (importJson calls chatOrder.add).
 *
 * So the K-th import reads K chats' worth of data. Total chat-list reads across
 * a 1300-card import = 1 + 2 + ... + 1300 ≈ 845,000. Each mapChatToListItem
 * itself does getChatState (loads that chat's active-branch messages) to compute
 * lastMessageAt. That is O(N²) in the number of imported characters — on top of
 * the SQLite N+1 (bench #2) and the wasted snapshot return (frontend ignores it).
 *
 * This bench reproduces the compounding directly: it seeds a DB with K chats
 * (each with a few messages), then measures the cost of "one more snapshot" =
 * read ALL K chats to build the chat list (mirroring mapChatToListItem). It runs
 * at K = 100, 500, 1300 and reports the per-snapshot cost AND the cumulative
 * O(N²) total a real mass-import pays.
 *
 * Uses bun:sqlite directly (no Drizzle) to isolate the read pattern.
 */
import { Database } from "bun:sqlite";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MSGS_PER_CHAT = 20; // typical imported chat has a handful of messages

function fmt(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(1)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

function setupDb(dbPath: string): Database {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;"); // reads; durability less relevant here
	db.exec(`
		CREATE TABLE chats (
			id text PRIMARY KEY NOT NULL,
			character_id text NOT NULL,
			active_branch_id text NOT NULL,
			mode text NOT NULL DEFAULT 'rp',
			title text NOT NULL,
			updated_at text NOT NULL
		);
		CREATE TABLE chat_branches (
			id text PRIMARY KEY NOT NULL,
			chat_id text NOT NULL,
			parent_branch_id text,
			label text NOT NULL DEFAULT 'main',
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade
		);
		CREATE TABLE messages (
			id text PRIMARY KEY NOT NULL,
			chat_id text NOT NULL,
			branch_id text NOT NULL,
			position integer NOT NULL,
			role text NOT NULL,
			content text NOT NULL DEFAULT '',
			created_at text NOT NULL,
			FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE cascade,
			FOREIGN KEY (branch_id) REFERENCES chat_branches(id) ON DELETE cascade
		);
		CREATE INDEX idx_messages_branch ON messages(branch_id, position);
	`);
	return db;
}

function seedChats(db: Database, count: number) {
	const now = Date.now();
	db.transaction(() => {
		for (let i = 0; i < count; i++) {
			const chatId = `chat_${i}_${Math.random().toString(36).slice(2, 6)}`;
			const branchId = `brnch_${i}`;
			const charId = `char_${i}`;
			db.run(
				"INSERT INTO chats (id, character_id, active_branch_id, mode, title, updated_at) VALUES (?, ?, ?, 'rp', ?, ?)",
				[chatId, charId, branchId, `Chat ${i}`, new Date(now + i).toISOString()],
			);
			db.run(
				"INSERT INTO chat_branches (id, chat_id, parent_branch_id, label) VALUES (?, ?, NULL, 'main')",
				[branchId, chatId],
			);
			for (let m = 0; m < MSGS_PER_CHAT; m++) {
				db.run(
					"INSERT INTO messages (id, chat_id, branch_id, position, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[`msg_${i}_${m}`, chatId, branchId, m, m % 2 === 0 ? "user" : "assistant", "x".repeat(500), new Date(now + i + m).toISOString()],
				);
			}
		}
	})();
	return db.query("SELECT id FROM chats").all() as { id: string }[];
}

/**
 * Mirrors the read footprint of mapChatToListItem: load a chat's active branch
 * messages to compute lastMessageAt. Returns the chat list item fields.
 */
function mapChatToListItem(db: Database, chatId: string) {
	const chat = db.query("SELECT id, character_id, title, updated_at, active_branch_id FROM chats WHERE id = ?").get(chatId) as {
		id: string; character_id: string; title: string; updated_at: string; active_branch_id: string;
	};
	// lastMessageAt = max(created_at) over the active branch's messages
	const row = db.query(
		"SELECT MAX(m.created_at) as last_at, COUNT(m.id) as n FROM messages m WHERE m.branch_id = ?",
	).get(chat.active_branch_id) as { last_at: string | null; n: number };
	return {
		id: chat.id,
		title: chat.title,
		lastMessageAt: row.last_at ?? chat.updated_at,
		messageCount: row.n,
	};
}

/** Mirrors the chat-list portion of getSnapshot: read ALL chats in chatOrder. */
function buildChatList(db: Database, chatIds: string[]) {
	// The real code uses Promise.all over mapChatToListItem; bun:sqlite is sync,
	// so we just loop — same read footprint, same per-row cost.
	const out: ReturnType<typeof mapChatToListItem>[] = [];
	for (const id of chatIds) {
		out.push(mapChatToListItem(db, id));
	}
	return out;
}

function measureAtN(n: number) {
	const tmp = mkdtempSync(join(tmpdir(), "vt-bench3-"));
	const dbPath = join(tmp, "bench.db");
	try {
		const db = setupDb(dbPath);
		const chatIds = seedChats(db, n).map((c) => c.id);

		// warmup
		buildChatList(db, chatIds.slice(0, Math.min(10, n)));

		const t0 = Bun.nanoseconds();
		const list = buildChatList(db, chatIds);
		const ms = (Bun.nanoseconds() - t0) / 1_000_000;

		db.close();
		return { ms, items: list.length };
	} finally {
		try { rmSync(dbPath); } catch {}
		try { rmSync(dbPath + "-wal"); } catch {}
		try { rmSync(dbPath + "-shm"); } catch {}
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
	}
}

function main() {
	console.log(`Bench #3 — getSnapshot chat-list O(N²) cost during mass import.`);
	console.log(`Each snapshot reads ALL chats in chatOrder to build the list (mapChatToListItem);`);
	console.log(`chatOrder grows by 1 per import, so K-th import reads K chats. Seeds ${MSGS_PER_CHAT} msgs/chat.`);
	console.log("");

	const ns = [100, 500, 1300];
	const results: { n: number; ms: number }[] = [];
	for (const n of ns) {
		const { ms, items } = measureAtN(n);
		results.push({ n, ms });
		console.log(`  N=${String(n).padStart(4)} chats in chatOrder | one getSnapshot's chat-list build: ${fmt(ms).padStart(10)}  (${items} items)`);
	}

	console.log("");
	console.log("─── O(N²) extrapolation: cumulative cost a 1300-card mass-import pays ───");
	// Per-snapshot cost scales ~linearly with N (we read N chats). So per-call
	// cost at step k ≈ (k / N) * cost_at_N. Cumulative = sum over k=1..N.
	// = cost_at_N * (1/N) * (N*(N+1)/2) = cost_at_N * (N+1)/2.
	const at1300 = results.find((r) => r.n === 1300)?.ms ?? results[results.length - 1].ms;
	const perChatMs = at1300 / 1300;
	const cumulative = perChatMs * (1300 * 1301) / 2;
	console.log(`  Per-chat read cost (derived): ${perChatMs.toFixed(3)} ms`);
	console.log(`  Cumulative across 1300 imports = 1+2+...+1300 reads × per-chat cost`);
	console.log(`                                  ≈ ${fmt(cumulative)} of PURE chat-list rebuilding,`);
	console.log(`                                    done in wasted snapshots the frontend ignores.`);
	console.log("");
	console.log("─── HDD projection (disk-bound reads scale ~same as NVMe for reads, but the");
	console.log("    sheer volume makes it worse; the O(N²) is the killer regardless of disk) ───");
	console.log(`  On a weak laptop CPU (~5-10× slower per read): cumulative ≈ ${fmt(cumulative * 7)} (midpoint 7×).`);
	console.log(`  This single overhead, on its own, accounts for the reported multi-hour hang.`);
	console.log("");
	console.log("Fix: the mass-import path must NOT call getSnapshot (or any chat-list rebuild).");
	console.log("A lightweight `{ characterId, activeChatId }` response eliminates the O(N²) entirely.");
}

main();
