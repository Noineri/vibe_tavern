import { beforeEach, describe, expect, test } from 'bun:test';

import { createDb, type AppDb } from '../src/db-connection.js';
import { characters, chats, flyTribunalMemory } from '../src/db-schema.js';
import type { StoreClock, StoreIdGenerator } from '../src/persistence.js';
import {
  FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
  FlyTribunalStore,
} from '../src/stores/fly-tribunal-store.js';

/**
 * Fly Tribunal memory persistence (FLY_TRIBUNAL_PLAN FT-3).
 *
 * L1 checklist:
 * 1. Paths: none — every DB is in-memory.
 * 2. Restores: no process-global state is changed; the DB test preload closes
 *    every createDb handle after the suite.
 * 3. Determinism: injected clock/id generator; no waits or sleeps.
 * 4. Platform: no paths or OS-specific behavior.
 * 5. Shared worker pool: no mocks or registries.
 * 6. Stable state: each assertion reads a completed store operation.
 */

let now = '2026-09-27T00:00:00.000Z';
let nextId = 0;
const testClock: StoreClock = { now: () => now };
const testIdGenerator: StoreIdGenerator = {
  next(prefix: string): string {
    nextId += 1;
    return `${prefix}_test_${nextId}`;
  },
};

let db: AppDb;
let store: FlyTribunalStore;

function bootstrapChats() {
  db.insert(characters).values({
    id: 'char_fly',
    name: 'Fly test character',
    description: '',
    firstMessage: 'Hello',
    alternateGreetingsJson: '[]',
    extensionsJson: '{}',
    tagsJson: '[]',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).run();
  for (const id of ['chat_fly_a', 'chat_fly_b']) {
    db.insert(chats).values({
      id,
      characterId: 'char_fly',
      activeBranchId: `branch_${id}`,
      title: id,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
}

function weights(text: string): string {
  return Buffer.from(text).toString('base64');
}

beforeEach(async () => {
  db = await createDb(':memory:');
  now = '2026-09-27T00:00:00.000Z';
  nextId = 0;
  store = new FlyTribunalStore(db, { clock: testClock, idGenerator: testIdGenerator });
  bootstrapChats();
});

describe('FlyTribunalStore (FT-3)', () => {
  test('a missing global row returns the fresh-fly shape instead of null or 404', async () => {
    expect(await store.get('global')).toEqual({
      scope: 'global',
      schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
      precedentCount: 0,
      weights: null,
      updatedAt: '',
    });
  });

  test('global put then get round-trips base64 weights through the BLOB column', async () => {
    const saved = await store.put({
      scope: 'global',
      schemaVersion: 1,
      precedentCount: 25,
      weights: weights('global delta'),
    });

    expect(saved).toEqual({
      scope: 'global',
      schemaVersion: 1,
      precedentCount: 25,
      weights: weights('global delta'),
      updatedAt: now,
    });
    expect(await store.get('global')).toEqual(saved);

    const [row] = await db.select().from(flyTribunalMemory).all();
    expect(row.weights).toBeInstanceOf(Buffer);
    expect(row.weights!.toString()).toBe('global delta');
  });

  test('per-chat rows stay isolated from each other and from the global row', async () => {
    await store.put({
      scope: 'global',
      schemaVersion: 1,
      precedentCount: 3,
      weights: weights('global'),
    });
    await store.put({
      scope: 'chat',
      chatId: 'chat_fly_a',
      schemaVersion: 1,
      precedentCount: 25,
      weights: weights('chat a'),
    });
    await store.put({
      scope: 'chat',
      chatId: 'chat_fly_b',
      schemaVersion: 1,
      precedentCount: 8,
      weights: weights('chat b'),
    });

    expect(await store.get('global')).toMatchObject({
      scope: 'global',
      precedentCount: 3,
      weights: weights('global'),
    });
    expect(await store.get('chat', 'chat_fly_a')).toMatchObject({
      scope: 'chat',
      chatId: 'chat_fly_a',
      precedentCount: 25,
      weights: weights('chat a'),
    });
    expect(await store.get('chat', 'chat_fly_b')).toMatchObject({
      scope: 'chat',
      chatId: 'chat_fly_b',
      precedentCount: 8,
      weights: weights('chat b'),
    });
  });

  test('a second put updates the existing global row instead of inserting another NULL chat_id row', async () => {
    await store.put({
      scope: 'global',
      schemaVersion: 1,
      precedentCount: 4,
      weights: weights('first'),
    });
    now = '2026-09-27T00:01:00.000Z';
    const updated = await store.put({
      scope: 'global',
      schemaVersion: 2,
      precedentCount: 26,
      weights: weights('replacement'),
    });

    expect(updated).toEqual({
      scope: 'global',
      schemaVersion: 2,
      precedentCount: 26,
      weights: weights('replacement'),
      updatedAt: now,
    });
    const rows = await db.select().from(flyTribunalMemory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.weights!.toString()).toBe('replacement');
  });

  test('precedent count persists through a new read after a per-chat write', async () => {
    await store.put({
      scope: 'chat',
      chatId: 'chat_fly_a',
      schemaVersion: 1,
      precedentCount: 24,
      weights: null,
    });

    const reread = await store.get('chat', 'chat_fly_a');
    expect(reread.precedentCount).toBe(24);
    expect(reread.weights).toBeNull();
    expect(reread.schemaVersion).toBe(1);
  });

  test('delete is idempotent and restores the fresh-fly shape', async () => {
    await store.put({
      scope: 'chat',
      chatId: 'chat_fly_a',
      schemaVersion: 1,
      precedentCount: 5,
      weights: weights('to forget'),
    });

    await store.delete('chat', 'chat_fly_a');
    await store.delete('chat', 'chat_fly_a');

    expect(await store.get('chat', 'chat_fly_a')).toEqual({
      scope: 'chat',
      chatId: 'chat_fly_a',
      schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
      precedentCount: 0,
      weights: null,
      updatedAt: '',
    });
  });
});
