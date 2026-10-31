import { expect, test } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { deflateTraceValue } from "../src/trace-chunking.js";
import { PromptTraceStore } from "../src/stores/prompt-trace-store.js";
import { runTraceStorageConversion, TRACE_STORAGE_CONVERSION_MARKER } from "../src/trace-storage-converter.js";

async function seed() {
	const db = await createDb(":memory:");
	const client = db.$client;
	client.exec(`INSERT INTO characters(id,name,created_at,updated_at) VALUES ('c','fixture','now','now');
		INSERT INTO chats(id,character_id,active_branch_id,title,created_at,updated_at) VALUES ('chat','c','branch','fixture','now','now');
		INSERT INTO chat_branches(id,chat_id,label,created_at) VALUES ('branch','chat','root','now');
		INSERT INTO messages(id,chat_id,branch_id,role,author_type,position,content,state,created_at,updated_at) VALUES ('m','chat','branch','user','user',0,'seed','active','now','now');`);
	const history = Array.from({ length: 1400 }, (_, i) => `${i}: A visitor opened the window and waited beside the table.\n`).join("");
	for (let i = 0; i < 4; i++) {
		const values = [[{ sourceType: "history", text: history + `turn ${i}` }], { messages: [{ role: "user", content: history }] }, { mode: "nonstream", steps: [{ finishReason: "stop", response: { id: `response-${i}`, modelId: "model", headers: {}, body: { text: "reply ".repeat(400) } } }] }];
		const deflated = values.map((value) => deflateTraceValue(value, 1));
		for (const value of deflated) {
			for (const chunk of value.chunks) {
				client.query('INSERT OR IGNORE INTO prompt_trace_chunks(id, byte_size, content) VALUES (?, ?, ?)').run(chunk.id, chunk.content.length, chunk.content);
				client.query('INSERT OR IGNORE INTO prompt_trace_chunk_refs(trace_id, chunk_id) VALUES (?, ?)').run(`t${i}`, chunk.id);
			}
		}
		client.query(`INSERT INTO prompt_traces(id,chat_id,branch_id,message_id,model,preset_name,assembled_layers_json,token_accounting_json,final_payload_json,provider_response_json,latency_ms,created_at)
			VALUES (?,'chat','branch','m','model','preset',?,'{}',?,?,5,'now')`)
			.run(`t${i}`, ...deflated.map((value) => JSON.stringify(value.skeleton)));
	}
	return { db, store: new PromptTraceStore(db) };
}

test("converts old rows losslessly, updates refs, yields at unit boundaries and completes once", async () => {
	const { db, store } = await seed();
	const expected = JSON.stringify(await store.getTracesByChat("chat", "branch"));
	let now = 0;
	let yields = 0;
	const stats = await runTraceStorageConversion(db, {
		clock: { now: () => (now += 5) },
		yieldToEventLoop: async () => { yields++; },
	});
	expect(stats.tracesConverted).toBe(4);
	expect(stats.chunksCompressed).toBeGreaterThan(0);
	expect(yields).toBeGreaterThan(1);
	expect(stats.sliceDurationsMs.every((duration) => duration <= 15)).toBe(true);
	expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
	expect(db.$client.query('SELECT name FROM app_data_migrations WHERE name = ?').get(TRACE_STORAGE_CONVERSION_MARKER)).not.toBeNull();
	expect(db.$client.query("SELECT id FROM prompt_trace_chunks WHERE typeof(content) != 'blob' LIMIT 1").get()).toBeNull();
	expect(db.$client.query('SELECT id FROM prompt_trace_chunks WHERE id NOT IN (SELECT chunk_id FROM prompt_trace_chunk_refs) LIMIT 1').get()).toBeNull();
	const changes = db.$client.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
	expect((await runTraceStorageConversion(db)).skippedByMarker).toBe(true);
	expect(db.$client.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n).toBe(changes);
});

for (const phase of ["chunks", "traces"] as const) {
	test(`interruption during ${phase} resumes without losing readable traces`, async () => {
		const { db, store } = await seed();
		const expected = JSON.stringify(await store.getTracesByChat("chat", "branch"));
		const abort = new AbortController();
		let now = 0;
		await expect(runTraceStorageConversion(db, {
			signal: abort.signal,
			clock: { now: () => (now += 15) },
			yieldToEventLoop: async () => {
				const table = phase === "chunks" ? "prompt_trace_chunks" : "prompt_traces";
				const column = phase === "chunks" ? "content" : "assembled_layers_json";
				const converted = db.$client.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table} WHERE typeof(${column}) = 'blob'`).get()!.n;
				if (converted > 0) abort.abort();
			},
		})).rejects.toThrow(/abort/i);
		expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
		expect(db.$client.query('SELECT name FROM app_data_migrations WHERE name = ?').get(TRACE_STORAGE_CONVERSION_MARKER)).toBeNull();
		await runTraceStorageConversion(db);
		expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
	});
}

test("a failed row rolls back its new blocks, refs and skeleton; recovery is lossless", async () => {
	const { db, store } = await seed();
	const expected = JSON.stringify(await store.getTracesByChat("chat", "branch"));
	const originalIds = db.$client.query('SELECT id FROM prompt_trace_chunks ORDER BY id').all();
	const originalRefs = db.$client.query('SELECT * FROM prompt_trace_chunk_refs ORDER BY trace_id,chunk_id').all();
	db.$client.exec("CREATE TRIGGER reject_trace_conversion BEFORE UPDATE OF assembled_layers_json ON prompt_traces BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
	await expect(runTraceStorageConversion(db)).rejects.toThrow(/injected update failure/);
	expect(db.$client.query('SELECT id FROM prompt_trace_chunks ORDER BY id').all()).toEqual(originalIds);
	expect(db.$client.query('SELECT * FROM prompt_trace_chunk_refs ORDER BY trace_id,chunk_id').all()).toEqual(originalRefs);
	expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
	db.$client.exec('DROP TRIGGER reject_trace_conversion');
	await runTraceStorageConversion(db);
	expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
});

test("new v2 writes can interleave at yields without being reconverted or losing shared blocks", async () => {
	const { db, store } = await seed();
	const legacy = (await store.getTracesByChat("chat", "branch"))[0]!;
	let addedId: string | undefined;
	const stats = await runTraceStorageConversion(db, {
		yieldToEventLoop: async () => {
			if (addedId) return;
			addedId = (await store.saveTrace(legacy)).id;
		},
	});
	expect(stats.tracesConverted).toBe(4);
	expect((await store.getTracesByChat("chat", "branch"))).toHaveLength(5);
	expect((await store.getTrace(addedId!))!.assembledLayers).toEqual(legacy.assembledLayers);
});

test("legacy missing inverted refs cannot cause premature reclamation of another trace's chunks", async () => {
	const { db, store } = await seed();
	// Historical forks could copy a skeleton without refs (LC-8 fixed new
	// forks, not old rows). The skeleton is still readable before conversion.
	db.$client.query("DELETE FROM prompt_trace_chunk_refs WHERE trace_id = 't3'").run();
	const expected = JSON.stringify(await store.getTracesByChat("chat", "branch"));
	await runTraceStorageConversion(db);
	expect(JSON.stringify(await store.getTracesByChat("chat", "branch"))).toBe(expected);
	expect(db.$client.query<{ n: number }, []>("SELECT count(*) AS n FROM prompt_trace_chunk_refs WHERE trace_id = 't3'").get()!.n).toBeGreaterThan(0);
});

test("ordinary deletes and the boot sweep cannot reclaim chunks while legacy refs are incomplete", async () => {
	const { db, store } = await seed();
	db.$client.query("DELETE FROM prompt_trace_chunk_refs WHERE trace_id = 't3'").run();
	const expected = (await store.getTracesByChat("chat", "branch")).filter((trace) => trace.id !== 't0');
	let deleted = false;
	await runTraceStorageConversion(db, {
		yieldToEventLoop: async () => {
			if (deleted) return;
			deleted = true;
			db.$client.query("DELETE FROM prompt_traces WHERE id = 't0'").run();
			await store.reclaimChunksForTraces(['t0']);
			await store.sweepOrphanedChunks();
		},
	});
	expect(await store.getTracesByChat("chat", "branch")).toEqual(expected);
	expect(db.$client.query("SELECT trace_id FROM prompt_trace_chunk_refs WHERE trace_id = 't0'").get()).toBeNull();
});
