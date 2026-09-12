import { describe, expect, test } from 'bun:test';

import { createDb } from '../src/db-connection.js';
import { servicePromptProfiles } from '../src/db-schema.js';
import { ServicePromptProfileStore } from '../src/stores/service-prompt-store.js';
import { UiSettingsStore } from '../src/stores/ui-settings-store.js';
import type { StoreClock, StoreIdGenerator } from '../src/persistence.js';

const fixedClock: StoreClock = { now: () => '2026-08-25T00:00:00.000Z' };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
  const db = await createDb(':memory:');
  const store = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  return { db, store, uiSettings };
}

describe('ServicePromptProfileStore', () => {
  test('ensureDefault inserts once and is idempotent on repeat', async () => {
    const { store } = await setup();
    const first = await store.ensureDefaultServicePromptProfile();
    expect(first.id).toBe('default');
    expect(first.name).toBe('Default');
    expect(first.isDefault).toBe(true);
    expect(first.overrides).toEqual({});

    const second = await store.ensureDefaultServicePromptProfile();
    expect(second.id).toBe('default');
    expect(second.createdAt).toBe(first.createdAt);

    // List still shows exactly one default row.
    const all = await store.listServicePromptProfiles();
    expect(all.filter((p) => p.id === 'default')).toHaveLength(1);
  });

  test('create → list puts Default first then by sortOrder', async () => {
    const { store } = await setup();
    await store.ensureDefaultServicePromptProfile();
    await store.createServicePromptProfile({ name: 'Alpha', overrides: {} });
    await store.createServicePromptProfile({ name: 'Zebra', overrides: { script: 's1' } });
    const list = await store.listServicePromptProfiles();
    expect(list.map((p) => p.name)).toEqual(['Default', 'Alpha', 'Zebra']);
  });

  test('reorder persists sortOrder and Default stays pinned first', async () => {
    const { store } = await setup();
    await store.ensureDefaultServicePromptProfile();
    const a = await store.createServicePromptProfile({ name: 'Alpha', overrides: {} });
    const b = await store.createServicePromptProfile({ name: 'Beta', overrides: {} });
    const c = await store.createServicePromptProfile({ name: 'Gamma', overrides: {} });
    // initial: Alpha(0), Beta(1), Gamma(2)
    await store.reorderServicePromptProfiles([
      { id: c.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
      { id: b.id, sortOrder: 2 },
    ]);
    const reordered = await store.listServicePromptProfiles();
    expect(reordered.map((p) => p.name)).toEqual(['Default', 'Gamma', 'Alpha', 'Beta']);
    // Default reorder is ignored
    await store.reorderServicePromptProfiles([{ id: 'default', sortOrder: 99 }]);
    const still = await store.listServicePromptProfiles();
    expect(still[0].id).toBe('default');
  });

  test('update/delete refuse default profile', async () => {
    const { store } = await setup();
    await store.ensureDefaultServicePromptProfile();

    // Update default's name/overrides is ignored — row stays inert.
    const afterUpdate = await store.updateServicePromptProfile('default', {
      name: 'Hacked',
      overrides: { script: 'evil' },
    });
    expect(afterUpdate).not.toBeNull();
    expect(afterUpdate!.name).toBe('Default');
    expect(afterUpdate!.overrides).toEqual({});

    // Delete default is a no-op.
    await store.deleteServicePromptProfile('default');
    const still = await store.getServicePromptProfile('default');
    expect(still).not.toBeNull();
    expect(still!.id).toBe('default');
  });

  test('non-default update and delete work', async () => {
    const { store } = await setup();
    const created = await store.createServicePromptProfile({ name: 'Mine', overrides: { summary: 'a' } });
    const updated = await store.updateServicePromptProfile(created.id, {
      name: 'Renamed',
      overrides: { summary: 'b', script: 's' },
    });
    expect(updated!.name).toBe('Renamed');
    expect(updated!.overrides).toEqual({ summary: 'b', script: 's' });

    await store.deleteServicePromptProfile(created.id);
    expect(await store.getServicePromptProfile(created.id)).toBeNull();
  });

  test('parseOverrides drops unknown keys and tolerates invalid JSON', async () => {
    const { store, db } = await setup();
    // Create via store with unknown key — should be dropped on write.
    const created = await store.createServicePromptProfile({
      name: 'Weird',
      overrides: { script: 'keep', bogus: 'drop', lore_entry: 'keep2' } as Record<string, string>,
    });
    expect(created.overrides).toEqual({ script: 'keep', lore_entry: 'keep2' });
    expect(created.overrides).not.toHaveProperty('bogus');

    // Direct DB insert with invalid JSON and unknown keys — read degrades gracefully.
    await db
      .insert(servicePromptProfiles)
      .values({
        id: 'sp_manual_invalid',
        name: 'ManualInvalid',
        isDefault: 0,
        overrides: '{not json',
        createdAt: fixedClock.now(),
        updatedAt: fixedClock.now(),
      })
      .run();
    const loadedInvalid = await store.getServicePromptProfile('sp_manual_invalid');
    expect(loadedInvalid!.overrides).toEqual({});

    await db
      .insert(servicePromptProfiles)
      .values({
        id: 'sp_manual_unknown',
        name: 'ManualUnknown',
        isDefault: 0,
        overrides: JSON.stringify({ bogus: 'x', script: 'ok' }),
        createdAt: fixedClock.now(),
        updatedAt: fixedClock.now(),
      })
      .run();
    const loadedUnknown = await store.getServicePromptProfile('sp_manual_unknown');
    expect(loadedUnknown!.overrides).toEqual({ script: 'ok' });
    expect(loadedUnknown!.overrides).not.toHaveProperty('bogus');
  });

  test('activeServicePromptProfileId round-trips through ui-settings store (null default)', async () => {
    const { store, uiSettings } = await setup();
    const defaults = await uiSettings.get();
    expect(defaults.activeServicePromptProfileId).toBeNull();

    const profile = await store.createServicePromptProfile({ name: 'ActiveOne', overrides: {} });
    const updated = await uiSettings.update({ activeServicePromptProfileId: profile.id });
    expect(updated.activeServicePromptProfileId).toBe(profile.id);

    const reread = await uiSettings.get();
    expect(reread.activeServicePromptProfileId).toBe(profile.id);

    const cleared = await uiSettings.update({ activeServicePromptProfileId: null });
    expect(cleared.activeServicePromptProfileId).toBeNull();
  });
});
