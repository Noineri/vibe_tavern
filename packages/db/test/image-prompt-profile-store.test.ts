import { describe, expect, test } from 'bun:test';

import { createDb } from '../src/db-connection.js';
import { ImagePromptProfileStore } from '../src/stores/image-prompt-profile-store.js';
import { UiSettingsStore } from '../src/stores/ui-settings-store.js';
import type { StoreClock, StoreIdGenerator } from '../src/persistence.js';

const fixedClock: StoreClock = { now: () => '2026-09-22T00:00:00.000Z' };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
  const db = await createDb(':memory:');
  const store = new ImagePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  return { db, store, uiSettings };
}

describe('ImagePromptProfileStore', () => {
  test('ensureDefault inserts once and is idempotent on repeat', async () => {
    const { store } = await setup();
    const first = await store.ensureDefaultImagePromptProfile();
    expect(first.id).toBe('default');
    expect(first.name).toBe('Default');
    expect(first.isDefault).toBe(true);
    expect(first.overrides).toEqual({});

    const second = await store.ensureDefaultImagePromptProfile();
    expect(second.id).toBe('default');
    expect(second.createdAt).toBe(first.createdAt);

    // List still shows exactly one default row.
    const all = await store.listImagePromptProfiles();
    expect(all.filter((p) => p.id === 'default')).toHaveLength(1);
  });

  test('create → list puts Default first then by sortOrder', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();
    await store.createImagePromptProfile({ name: 'Alpha', overrides: {} });
    await store.createImagePromptProfile({ name: 'Zebra', overrides: { 'scene-illustration|pony': { body: 'z1' } } });
    const list = await store.listImagePromptProfiles();
    expect(list.map((p) => p.name)).toEqual(['Default', 'Alpha', 'Zebra']);
  });

  test('cell overrides round-trip through create and update', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();
    const profile = await store.createImagePromptProfile({
      name: 'Tuned',
      overrides: {
        'portrait|prose': { body: 'P-BODY', qualityText: 'P-QUAL' },
        'negative|qwen': { body: 'N-BODY', qualityText: null },
        'scene-illustration|pony': { body: 'S-BODY' },
      },
    });
    expect(profile.overrides['portrait|prose']).toEqual({ body: 'P-BODY', qualityText: 'P-QUAL' });
    expect(profile.overrides['negative|qwen']).toEqual({ body: 'N-BODY', qualityText: null });
    // Absent qualityText normalizes to null (family canon), not undefined.
    expect(profile.overrides['scene-illustration|pony']).toEqual({ body: 'S-BODY', qualityText: null });

    // Update replaces overrides in full (patch semantics on the column only).
    const updated = await store.updateImagePromptProfile(profile.id, {
      overrides: { 'portrait|prose': { body: 'P-BODY-2' } },
    });
    expect(updated!.overrides).toEqual({ 'portrait|prose': { body: 'P-BODY-2', qualityText: null } });

    const reread = await store.getImagePromptProfile(profile.id);
    expect(reread!.overrides).toEqual({ 'portrait|prose': { body: 'P-BODY-2', qualityText: null } });
  });

  test('unknown keys and wrong payloads are dropped at the store boundary', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();
    // Bogus input shape cast in — the store must filter it, not persist it.
    const bogus = {
      'not-a-mode|pony': { body: 'x' },
      'portrait|not-a-family': { body: 'x' },
      'portrait|prose': 'flat-string-payload',
      'no-separator': { body: 'x' },
      'negative|prose': { body: 'ok', qualityText: 42 as unknown as string },
    } as never;
    const profile = await store.createImagePromptProfile({ name: 'Dirty', overrides: bogus });
    expect(profile.overrides).toEqual({});
  });

  test('update/delete refuse default profile', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();

    const afterUpdate = await store.updateImagePromptProfile('default', {
      name: 'Hacked',
      overrides: { 'portrait|prose': { body: 'evil' } },
    });
    expect(afterUpdate).not.toBeNull();
    expect(afterUpdate!.name).toBe('Default');
    expect(afterUpdate!.overrides).toEqual({});
    // Refused mutation does not bump updatedAt (row stays inert).
    expect(afterUpdate!.updatedAt).toBe((await store.getImagePromptProfile('default'))!.updatedAt);

    await store.deleteImagePromptProfile('default');
    expect(await store.getImagePromptProfile('default')).not.toBeNull();
  });

  test('update unknown id returns null; reorder persists and Default stays pinned', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();
    expect(await store.updateImagePromptProfile('missing', { name: 'X' })).toBeNull();

    const a = await store.createImagePromptProfile({ name: 'Alpha', overrides: {} });
    const b = await store.createImagePromptProfile({ name: 'Beta', overrides: {} });
    await store.reorderImagePromptProfiles([
      { id: b.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
    ]);
    const reordered = await store.listImagePromptProfiles();
    expect(reordered.map((p) => p.name)).toEqual(['Default', 'Beta', 'Alpha']);
    // Default reorder is ignored.
    await store.reorderImagePromptProfiles([{ id: 'default', sortOrder: 99 }]);
    const still = await store.listImagePromptProfiles();
    expect(still[0].id).toBe('default');
  });

  test('delete removes a non-default profile', async () => {
    const { store } = await setup();
    await store.ensureDefaultImagePromptProfile();
    const a = await store.createImagePromptProfile({ name: 'Alpha', overrides: {} });
    await store.deleteImagePromptProfile(a.id);
    expect(await store.getImagePromptProfile(a.id)).toBeNull();
  });
});

describe('UiSettings image-prompt profile fields', () => {
  test('activeImagePromptProfileId + migration marker round-trip with defaults', async () => {
    const { uiSettings } = await setup();
    await uiSettings.ensureDefaults();
    const initial = await uiSettings.get();
    expect(initial.activeImagePromptProfileId).toBeNull();
    expect(initial.imagePromptVariantsMigrated).toBe(false);

    await uiSettings.update({ activeImagePromptProfileId: 'ipp_1', imagePromptVariantsMigrated: true });
    const after = await uiSettings.get();
    expect(after.activeImagePromptProfileId).toBe('ipp_1');
    expect(after.imagePromptVariantsMigrated).toBe(true);

    // Nullable reset (dangling-profile semantics: null → Default).
    await uiSettings.update({ activeImagePromptProfileId: null });
    expect((await uiSettings.get()).activeImagePromptProfileId).toBeNull();
  });
});
