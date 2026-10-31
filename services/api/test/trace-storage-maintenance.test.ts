import { expect, test } from 'bun:test';
import { createDb } from '@vibe-tavern/db';
import { startTraceStorageConversion } from '../src/server/trace-storage-maintenance.js';

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
