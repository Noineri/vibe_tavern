import { expect, test } from 'bun:test';
import { createDb, type AppDb } from '@vibe-tavern/db';
import { compactTraceStorageOnce, startTraceStorageConversion } from '../src/server/trace-storage-maintenance.js';

function seedTraceRows(db: AppDb, count: number): void {
  db.$client.exec(`INSERT INTO characters(id,name,created_at,updated_at) VALUES ('c','fixture','now','now');
    INSERT INTO chats(id,character_id,active_branch_id,title,created_at,updated_at) VALUES ('chat','c','branch','fixture','now','now');
    INSERT INTO chat_branches(id,chat_id,label,created_at) VALUES ('branch','chat','root','now');
    INSERT INTO messages(id,chat_id,branch_id,role,author_type,position,content,state,created_at,updated_at) VALUES ('m','chat','branch','user','user',0,'seed','active','now','now');`);
  const insert = db.$client.query(`INSERT INTO prompt_traces(id,chat_id,branch_id,message_id,model,preset_name,assembled_layers_json,token_accounting_json,final_payload_json,provider_response_json,latency_ms,created_at)
    VALUES (?,'chat','branch','m','model','preset',?,'{}',?,NULL,5,'now')`);
  for (let i = 0; i < count; i++) insert.run(`t${i}`, `{"layers":[${i}]}`, `{"final":${i}}`);
}

test('startup scheduling returns before work, logs once, and completed boots skip silently', async () => {
  const db = await createDb(':memory:');
  const gate = Promise.withResolvers<void>();
  const logs: string[] = [];
  const run = startTraceStorageConversion(db, { yieldToEventLoop: () => gate.promise, log: (message) => logs.push(message) });
  expect(db.$client.query("SELECT name FROM app_data_migrations WHERE name = 'trace-storage-v2'").get()).toBeNull();
  gate.resolve();
  expect((await run.completed)?.skippedByMarker).toBe(false);
  expect(logs).toHaveLength(1);
  await run.stop();
  const second = startTraceStorageConversion(db, { log: (message) => logs.push(message) });
  expect((await second.completed)?.skippedByMarker).toBe(true);
  expect(logs).toHaveLength(1);
  await second.stop();
});

test('a converting boot logs throttled progress lines and the final count; skip boots add nothing', async () => {
  const db = await createDb(':memory:');
  seedTraceRows(db, 700);
  const logs: string[] = [];
  const run = startTraceStorageConversion(db, { clock: { now: () => 0 }, log: (message) => logs.push(message) });
  expect((await run.completed)?.skippedByMarker).toBe(false);
  await run.stop();
  expect(logs).toEqual([
    '[trace-storage] converting legacy traces: 1/700 (0%)',
    '[trace-storage] converting legacy traces: 501/700 (72%)',
    '[trace-storage] converting legacy traces: 700/700 (100%)',
    '[trace-storage] conversion complete: 700 traces',
  ]);
  const second = startTraceStorageConversion(db, { log: (message) => logs.push(message) });
  expect((await second.completed)?.skippedByMarker).toBe(true);
  await second.stop();
  expect(logs).toHaveLength(4);
});

test('an interrupted pass is announced as resumed before the first progress line', async () => {
  const db = await createDb(':memory:');
  seedTraceRows(db, 3);
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2-running','now')");
  const logs: string[] = [];
  const run = startTraceStorageConversion(db, { clock: { now: () => 0 }, log: (message) => logs.push(message) });
  await run.completed;
  await run.stop();
  expect(logs[0]).toBe('[trace-storage] resuming trace conversion');
  expect(logs[1]).toBe('[trace-storage] converting legacy traces: 1/3 (33%)');
  expect(logs[logs.length - 1]).toBe('[trace-storage] conversion complete: 3 traces');
});

test('the one-time compaction logs before and after; boots that skip it log nothing', async () => {
  const db = await createDb(':memory:');
  const logs: string[] = [];
  const log = (message: string): void => { logs.push(message); };
  expect(compactTraceStorageOnce(db, log)).toBe(false);
  expect(logs).toEqual([]);
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2','now')");
  expect(compactTraceStorageOnce(db, log)).toBe(true);
  expect(logs).toHaveLength(2);
  expect(logs[0]).toBe('[trace-storage] compacting the database (one-time; the server becomes ready in a moment)');
  expect(logs[1]).toMatch(/^\[trace-storage\] compaction done in \d+\.\ds$/);
  logs.length = 0;
  expect(compactTraceStorageOnce(db, log)).toBe(false);
  expect(logs).toEqual([]);
});
