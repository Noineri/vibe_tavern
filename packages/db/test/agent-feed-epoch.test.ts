import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createDb } from '../src/db-connection.js';
import * as schema from '../src/db-schema.js';
import { ExperienceCopilotStore } from '../src/stores/experience-copilot-store.js';
import { splitMigrationStatements } from '../src/db-migration-repair.js';
import { buildJournalCutFolder, REAL_DRIZZLE_DIR } from './migration-journal-cut.js';
import { deleteCopilotTurn } from '../src/stores/experience-copilot-turn-delete.js';

// AFP-8 L1: (1) repo-relative/import.meta.dir paths; (2) no patched globals,
// registries or env; handles belong to createDb's suite cleanup; (3) synchronous
// resolved states, no waits; (4) join/tmpdir-derived paths, explicit SQL order;
// (5) no module mocks/shared-process mutations; (6) committed-state reads or
// reads INSIDE the transaction under test; (7) cheap createDb fixtures, real
// migration replay once in beforeAll plus the explicit upgrade/healing subjects.
const NOW = '2026-11-04T12:00:00.000Z';
const MIGRATION_TAG = '0136_panoramic_onslaught';
const TABLES = ['experience_copilot_messages', 'agent_thread_context_events'] as const;

function epoch(client: Database, threadId = 't1'): number {
  return client.query<{ history_epoch: number }, [string]>(
    'SELECT history_epoch FROM experience_copilot_threads WHERE id = ?',
  ).get(threadId)!.history_epoch;
}

function insertRow(client: Database, table: typeof TABLES[number], id: string, seq: number | null, at = NOW, threadId = 't1') {
  if (table === 'experience_copilot_messages') {
    client.query(`INSERT INTO experience_copilot_messages (id, thread_id, role, seq, created_at)
      VALUES (?, ?, 'assistant', ?, ?)`).run(id, threadId, seq, at);
  } else {
    client.query(`INSERT INTO agent_thread_context_events (id, thread_id, kind, payload_json, seq, created_at)
      VALUES (?, ?, 'branch_forked', '{}', ?, ?)`).run(id, threadId, seq, at);
  }
}

async function setup() {
  const db = await createDb(':memory:');
  db.insert(schema.experienceCopilotThreads).values([
    { id: 't1', createdAt: NOW, updatedAt: NOW },
    { id: 't2', createdAt: NOW, updatedAt: NOW },
  ]).run();
  return { db, client: db.$client, store: new ExperienceCopilotStore(db) };
}

describe('agent feed migration boundary characterization', () => {
  test('legacy NULL prefix, seq ties and event/message interleaving use the existing total order', async () => {
    const { db, store } = await setup();
    db.insert(schema.experienceCopilotMessages).values([
      { id: 'z-legacy', threadId: 't1', role: 'user', seq: null, createdAt: NOW },
      { id: 'b', threadId: 't1', role: 'assistant', seq: 2, createdAt: NOW },
      { id: 'a', threadId: 't1', role: 'assistant', seq: 2, createdAt: NOW },
    ]).run();
    db.insert(schema.agentThreadContextEvents).values([
      { id: 'a-legacy', threadId: 't1', kind: 'branch_forked', payloadJson: '{}', seq: null, createdAt: NOW },
      { id: 'event', threadId: 't1', kind: 'branch_forked', payloadJson: '{}', seq: 1, createdAt: '2099' },
    ]).run();
    expect((await store.listTimeline('t1')).map((row) => row.id)).toEqual(['a-legacy', 'z-legacy', 'event', 'a', 'b']);
    // Legacy listMessages still orders by createdAt/id, independently of seq.
    expect((await store.listMessages('t1')).map((row) => row.id)).toEqual(['a', 'b', 'z-legacy']);
  });

  test('message and frozen event writes roll back together on the store transaction boundary', async () => {
    const { db, client } = await setup();
    expect(() => db.transaction((tx) => {
      tx.insert(schema.experienceCopilotMessages).values({ id: 'm', threadId: 't1', role: 'user', createdAt: NOW }).run();
      tx.insert(schema.agentThreadContextEvents).values({ id: 'e', threadId: 't1', kind: 'rp_sync', payloadJson: '{}', createdAt: NOW }).run();
      throw new Error('abort fixture');
    })).toThrow('abort fixture');
    expect(client.query('SELECT id FROM experience_copilot_messages').all()).toEqual([]);
    expect(client.query('SELECT id FROM agent_thread_context_events').all()).toEqual([]);
  });

  test('repair statement splitting preserves quoted semicolons and comment text', () => {
    expect(splitMigrationStatements("-- ignored ;\nSELECT 'a;''b'; SELECT \"semi;colon\"; -- final ;")).toEqual([
      "SELECT 'a;''b'", 'SELECT "semi;colon"',
    ]);
  });

  test('repair keeps a complete trigger, including CASE END and multiple body statements', () => {
    const trigger = `CREATE TRIGGER sample AFTER UPDATE ON source BEGIN
      UPDATE target SET value = CASE WHEN NEW.value = 'END;' THEN 1 ELSE CASE WHEN 1 THEN 2 END END;
      -- END; must not close the body
      UPDATE target SET value = 3;
    END`;
    const statements = splitMigrationStatements(`SELECT 1; ${trigger};\n--> statement-breakpoint\nSELECT 2;`);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe('SELECT 1');
    expect(statements[1]).toStartWith('CREATE TRIGGER sample');
    expect(statements[1]).toContain('UPDATE target SET value = 3;');
    expect(statements[1]).toEndWith('END');
    expect(statements[2]).toBe('SELECT 2');
  });
});

describe('AFP-8 real migration and seek structure', () => {
  let migrated: Awaited<ReturnType<typeof createDb>>;
  beforeAll(async () => { migrated = await createDb(':memory:', undefined, { realMigrations: true }); });

  test('fresh real migration installs the default epoch, six triggers and covering seek indexes', () => {
    const client = migrated.$client;
    const columns = client.query<{ name: string; notnull: number; dflt_value: string }, []>(
      'PRAGMA table_info(experience_copilot_threads)',
    ).all();
    expect(columns.find((col) => col.name === 'history_epoch')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(client.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'agent_feed_%'").all()).toHaveLength(6);
    for (const table of TABLES) {
      const columns = client.query<{ name: string }, []>(`PRAGMA index_info(idx_${table}_feed_seek)`).all();
      expect(columns.map((col) => col.name)).toEqual(['thread_id', 'seq', 'created_at', 'id']);
    }
    const problems = client.query('PRAGMA foreign_key_check').all();
    expect(problems).toEqual([]);
  });

  test('upgrade preserves existing bytes, seq/frontier metadata and epoch across reopening', async () => {
    const folder = await buildJournalCutFolder('0135_premium_plazm');
    const work = await mkdtemp(join(tmpdir(), 'vt-feed-epoch-'));
    const path = join(work, 'upgrade.db');
    let db = await createDb(path, folder);
    let client = db.$client;
    client.exec(`INSERT INTO experience_copilot_threads (id, next_seq, rp_frontier_json, created_at, updated_at)
      VALUES ('t1', 42, '{"lastPosition":7,"selected":{}}', 'before', 'before')`);
    insertRow(client, TABLES[0], 'legacy', null);
    insertRow(client, TABLES[0], 'message', 4);
    insertRow(client, TABLES[1], 'frozen', 8);
    client.query('UPDATE agent_thread_context_events SET payload_json = ? WHERE id = ?').run('{"text":"frozen  bytes"}', 'frozen');
    const messages = client.query('SELECT * FROM experience_copilot_messages').all();
    const events = client.query('SELECT * FROM agent_thread_context_events').all();
    expect(client.query<{ name: string }, []>('PRAGMA table_info(experience_copilot_threads)').all().some((c) => c.name === 'history_epoch')).toBe(false);
    client.close();
    db = await createDb(path);
    client = db.$client;
    expect(epoch(client)).toBe(0);
    expect(client.query('SELECT * FROM experience_copilot_messages').all()).toEqual(messages);
    expect(client.query('SELECT * FROM agent_thread_context_events').all()).toEqual(events);
    expect(client.query('SELECT next_seq, rp_frontier_json, updated_at FROM experience_copilot_threads').get()).toEqual({
      next_seq: 42, rp_frontier_json: '{"lastPosition":7,"selected":{}}', updated_at: 'before',
    });
    client.exec("UPDATE experience_copilot_messages SET content = 'edited' WHERE id = 'message'");
    const savedEpoch = epoch(client);
    expect(savedEpoch).toBe(1);
    client.close();
    db = await createDb(path);
    expect(epoch(db.$client)).toBe(savedEpoch);
    expect(db.$client.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'agent_feed_%'").all()).toHaveLength(6);
  });

  test('new journal watermark is strictly later; migration is additive and repair splits intact triggers', async () => {
    const journal = await Bun.file(join(REAL_DRIZZLE_DIR, 'meta', '_journal.json')).json() as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const index = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
    expect(journal.entries[index]!.idx).toBe(journal.entries[index - 1]!.idx + 1);
    const source = await Bun.file(join(REAL_DRIZZLE_DIR, `${MIGRATION_TAG}.sql`)).text();
    expect(source).not.toMatch(/\bDROP\b|__new_/i);
    const statements = splitMigrationStatements(source);
    expect(statements.filter((statement) => /^CREATE TRIGGER/i.test(statement))).toHaveLength(6);
    // Actually exercise the repair executor, not just a string assertion.
    const db = await createDb(':memory:');
    for (const statement of statements.filter((statement) => /^CREATE TRIGGER/i.test(statement))) {
      db.$client.exec(statement.replace(/^CREATE TRIGGER/i, 'CREATE TRIGGER IF NOT EXISTS'));
    }
  });

  test('real partial-state recovery installs whole triggers after an unstamped ALTER already succeeded', async () => {
    const folder = await buildJournalCutFolder('0135_premium_plazm');
    const work = await mkdtemp(join(tmpdir(), 'vt-feed-heal-'));
    const path = join(work, 'partial.db');
    const before = await createDb(path, folder);
    before.$client.exec('ALTER TABLE experience_copilot_threads ADD history_epoch integer DEFAULT 0 NOT NULL');
    before.$client.close();
    // createDb sees a duplicate column, then its REAL heal path splits the
    // pending migration, tolerates the ALTER and installs each intact trigger.
    const after = await createDb(path);
    const client = after.$client;
    client.exec(`INSERT INTO experience_copilot_threads (id, created_at, updated_at) VALUES ('t1', '${NOW}', '${NOW}')`);
    insertRow(client, TABLES[0], 'm', 0);
    insertRow(client, TABLES[1], 'e', 1);
    client.exec("UPDATE experience_copilot_messages SET content = 'healed' WHERE id = 'm'");
    client.exec("DELETE FROM agent_thread_context_events WHERE id = 'e'");
    expect(epoch(client)).toBe(2);
    expect(client.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'agent_feed_%'").all()).toHaveLength(6);
  });

  test('long fixtures use covering indexes for forward/backward seq and NULL-prefix seeks without a temp sort', async () => {
    const { client } = await setup();
    client.transaction(() => {
      for (let i = 0; i < 5000; i++) insertRow(client, TABLES[i % 2]!, `row-${i}`, i < 100 ? null : i);
    })();
    for (const table of TABLES) {
      for (const query of [
        `WHERE thread_id = 't1' ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1`,
        `WHERE thread_id = 't1' AND seq IS NOT NULL AND (seq, created_at, id) > (2000, '${NOW}', '') ORDER BY seq, created_at, id LIMIT 40`,
        `WHERE thread_id = 't1' AND seq IS NOT NULL AND (seq, created_at, id) < (3000, '${NOW}', '') ORDER BY seq DESC, created_at DESC, id DESC LIMIT 40`,
        `WHERE thread_id = 't1' AND seq IS NULL AND (created_at, id) > ('${NOW}', '') ORDER BY created_at, id LIMIT 40`,
      ]) {
        const plan = client.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT seq, created_at, id FROM ${table} ${query}`).all();
        expect(plan.some((row) => row.detail.includes(`COVERING INDEX idx_${table}_feed_seek`))).toBe(true);
        expect(plan.some((row) => /SCAN |TEMP B-TREE/.test(row.detail))).toBe(false);
      }
    }
  });
});

describe('AFP-8 transactional history invalidation', () => {
  test.each(TABLES)('%s: every changed stored field invalidates, no-op updates do not', async (table) => {
    const { client } = await setup();
    insertRow(client, table, 'target', 0);
    const changes = table === TABLES[0] ? [
      "content = 'edited'", "role = 'tool'", "tool_calls_json = '[]'", "tool_call_id = 'call'",
      "reasoning = 'thought'", 'reasoning_duration_ms = 10', "attachments_json = '[]'",
    ] : ["payload_json = '{broken'", "kind = 'rp_sync'"];
    changes.push("created_at = 'later'", 'seq = NULL', "id = 'renamed'");
    for (const change of changes) {
      const before = epoch(client);
      client.exec(`UPDATE ${table} SET ${change} WHERE thread_id = 't1'`);
      expect(epoch(client)).toBe(before + 1);
      expect(epoch(client, 't2')).toBe(0);
    }
    const before = epoch(client);
    client.exec(`UPDATE ${table} SET id = id, seq = seq, created_at = created_at WHERE thread_id = 't1'`);
    expect(epoch(client)).toBe(before);
    client.exec(`UPDATE ${table} SET thread_id = 't2' WHERE id = 'renamed'`);
    expect(epoch(client)).toBe(before + 1);
    expect(epoch(client, 't2')).toBe(1);
    client.exec(`DELETE FROM ${table} WHERE id = 'renamed'`);
    expect(epoch(client, 't2')).toBe(2);
  });

  test.each(TABLES)('%s: suffix classification matches the canonical NULL-first/seq/time/id order across BOTH tables', async (table) => {
    const { client } = await setup();
    const other = table === TABLES[0] ? TABLES[1] : TABLES[0];
    insertRow(client, other, 'head', null);
    expect(epoch(client)).toBe(0);
    insertRow(client, table, 'z-suffix', null); // Same time, larger id: proved suffix.
    expect(epoch(client)).toBe(0);
    insertRow(client, table, 'a-old', null); // Same time, smaller id: old range changed.
    expect(epoch(client)).toBe(1);
    insertRow(client, table, 'new-time', null, '2099');
    expect(epoch(client)).toBe(1);
    insertRow(client, other, 'seq-start', 0, '1900'); // Seq wins over time.
    expect(epoch(client)).toBe(1);
    insertRow(client, table, 'legacy-late', null, '2199'); // Legacy cannot follow seq.
    expect(epoch(client)).toBe(2);
    insertRow(client, table, 'seq-append', 1, '1800');
    expect(epoch(client)).toBe(2);
    insertRow(client, other, 'seq-middle', 0, '2200');
    expect(epoch(client)).toBe(3);
    insertRow(client, other, 'seq-tie-later', 1, '1801');
    expect(epoch(client)).toBe(3);
    insertRow(client, table, 'z-seq-id-tie', 1, '1801');
    expect(epoch(client)).toBe(3);
    insertRow(client, other, 'a-seq-id-tie', 1, '1801');
    expect(epoch(client)).toBe(4);
    // Equal keys across tables cannot prove a strict suffix: invalidate.
    insertRow(client, other, 'z-seq-id-tie', 1, '1801');
    expect(epoch(client)).toBe(5);
    expect(epoch(client, 't2')).toBe(0);
  });

  test.each(TABLES)('%s: REPLACE invalidates the prior owner even with recursive_triggers off', async (table) => {
    const { client } = await setup();
    client.exec('PRAGMA recursive_triggers = OFF');
    insertRow(client, table, 'target', 0);
    const roleOrKind = table === TABLES[0] ? 'role' : 'kind';
    const value = table === TABLES[0] ? 'assistant' : 'branch_forked';
    client.exec(`INSERT OR REPLACE INTO ${table} (id, thread_id, ${roleOrKind}, seq, created_at)
      VALUES ('target', 't2', '${value}', 5, '${NOW}')`);
    expect(epoch(client)).toBeGreaterThan(0);
    expect(epoch(client, 't2')).toBeGreaterThan(0);
  });

  test('rollback restores BOTH mutated rows and their epoch; failed constraints cannot leave an epoch bump', async () => {
    const { db, client } = await setup();
    insertRow(client, TABLES[0], 'm', 0);
    insertRow(client, TABLES[1], 'e', 1);
    expect(() => db.transaction(() => {
      client.exec("UPDATE experience_copilot_messages SET content = 'edited' WHERE id = 'm'");
      client.exec("DELETE FROM agent_thread_context_events WHERE id = 'e'");
      expect(epoch(client)).toBe(2);
      throw new Error('abort invalidation');
    })).toThrow('abort invalidation');
    expect(epoch(client)).toBe(0);
    expect(client.query("SELECT content FROM experience_copilot_messages WHERE id = 'm'").get()).toEqual({ content: '' });
    expect(client.query("SELECT id FROM agent_thread_context_events WHERE id = 'e'").get()).toEqual({ id: 'e' });
    expect(() => insertRow(client, TABLES[0], 'm', 0)).toThrow();
    expect(epoch(client)).toBe(0);
  });

  test('real store append, answer, attachment, edit, compaction and regenerate-delete writers cannot forget the epoch', async () => {
    let tick = 0;
    const { db, client } = await setup();
    const store = new ExperienceCopilotStore(db, {
      clock: { now: () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString() }, idGenerator: { next: (prefix) => `${prefix}-${tick}` },
    });
    const user = await store.appendMessage('t1', { role: 'user', content: 'go' });
    const assistant = await store.appendMessage('t1', { role: 'assistant', content: 'reply', attachments: [
      { id: 'att', type: 'image', assetId: 'asset', mimeType: 'image/png', name: 'image', sizeBytes: 10 },
    ] });
    const tool = await store.appendMessage('t1', { role: 'tool', toolCallId: 'call', content: 'awaiting' });
    await store.appendContextEvent('t1', 'branch_forked', { at: 1 });
    expect(epoch(client)).toBe(0);
    await store.setToolResultOutput('t1', 'call', { toolName: 'ask_user', output: 'answer' });
    expect(epoch(client)).toBe(1);
    await store.updateMessageAttachment(assistant.id, 'att', { includeInPrompt: false });
    expect(epoch(client)).toBe(2);
    await store.removeMessageAttachment(assistant.id, 'att');
    expect(epoch(client)).toBe(3);
    expect((await store.updateAssistantContent('t1', assistant.id, 'revised')).status).toBe('edited');
    expect(epoch(client)).toBe(4);
    // Compaction is an append-only digest; context folding is NOT a rewrite.
    await store.appendMessage('t1', { role: 'digest', content: 'summary', toolCallId: user.id });
    expect(epoch(client)).toBe(4);
    const nextUser = await store.appendMessage('t1', { role: 'user', content: 'next' });
    const nextAnswer = await store.appendMessage('t1', { role: 'assistant', content: 'next answer' });
    const beforeDelete = epoch(client);
    expect((await deleteCopilotTurn({ db }, 't1', nextAnswer.id, false)).status).toBe('deleted');
    expect(epoch(client)).toBeGreaterThan(beforeDelete);
    expect(await store.listMessages('t1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tool.id }), expect.objectContaining({ id: nextUser.id }),
    ]));
    const beforeMetadata = epoch(client);
    await store.renameSession('t1', 'Renamed');
    await store.setFrontier('t1', { lastPosition: 2, selected: {} });
    await store.updateTodo('t1', []);
    expect(epoch(client)).toBe(beforeMetadata);
  });

  test('chat-owned appends interleave by allocated seq even when the clock goes backwards', async () => {
    const { db, client } = await setup();
    db.insert(schema.characters).values({ id: 'char', name: 'Character', createdAt: NOW, updatedAt: NOW }).run();
    db.insert(schema.chats).values({ id: 'chat', characterId: 'char', activeBranchId: 'branch', title: 'Chat', createdAt: NOW, updatedAt: NOW }).run();
    db.insert(schema.chatBranches).values({ id: 'branch', chatId: 'chat', label: 'Main', createdAt: NOW }).run();
    let step = 0;
    const store = new ExperienceCopilotStore(db, {
      clock: { now: () => new Date(Date.parse(NOW) - ++step * 1000).toISOString() },
      idGenerator: { next: (prefix) => `${prefix}-${step}` },
    });
    const thread = await store.startNewChatSession('chat', 'branch', 'sidechat-ooc');
    await store.appendMessage(thread.id, { role: 'user', content: 'first' });
    await store.appendContextEvent(thread.id, 'branch_forked', { at: 0 });
    await store.appendMessage(thread.id, { role: 'assistant', content: 'last' });
    expect(epoch(client, thread.id)).toBe(0);
    expect((await store.listTimeline(thread.id)).map((row) => row.seq)).toEqual([0, 1, 2]);
  });

  test('a sibling SQLite writer bumps the durable epoch without calling a store touch method', async () => {
    const work = await mkdtemp(join(tmpdir(), 'vt-feed-sibling-'));
    const path = join(work, 'shared.db');
    const first = await createDb(path);
    first.$client.exec(`INSERT INTO experience_copilot_threads (id, created_at, updated_at) VALUES ('t1', '${NOW}', '${NOW}')`);
    insertRow(first.$client, TABLES[0], 'm', null);
    const second = await createDb(path);
    second.$client.exec("UPDATE experience_copilot_messages SET attachments_json = '[]' WHERE id = 'm'");
    expect(epoch(first.$client)).toBe(1);
    insertRow(second.$client, TABLES[1], 'non-tail', null, '1900');
    expect(epoch(first.$client)).toBe(2);
    expect(first.$client.query('SELECT updated_at FROM experience_copilot_threads').get()).toEqual({ updated_at: NOW });
  });
});
