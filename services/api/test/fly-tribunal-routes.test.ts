import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  characters,
  chats,
  createDb,
  flyTribunalSettings,
  FlyTribunalSettingsStore,
  FlyTribunalStore,
  type AppDb,
} from '@vibe-tavern/db';
import * as schemas from '@vibe-tavern/api-contracts';
import { FlyTribunalAdapter } from '../src/api/adapters/fly-tribunal-adapter.js';
import { createFlyTribunalRoutes } from '../src/api/routes/fly-tribunal.js';

/**
 * Fly Tribunal routes (FLY_TRIBUNAL_PLAN FT-4), against real in-memory stores.
 *
 * L1 checklist:
 * 1. Paths: assetDir is derived from import.meta.dir; no machine paths.
 * 2. Restores: no process-global state, registry, fetch, or environment changes.
 * 3. Determinism: in-memory DB and completed request assertions; no waits.
 * 4. Platform: node:path join derives the asset path across Windows and Linux.
 * 5. Shared worker pool: no module mocks or shared mutable registries.
 * 6. Stable state: assertions read completed HTTP responses/store rows only.
 */

const ASSET_DIR = join(import.meta.dir, '..', 'assets', 'fly');
const NOW = '2026-09-27T00:00:00.000Z';

let db: AppDb;
let app: ReturnType<typeof createFlyTribunalRoutes>;

function bootstrapChat() {
  db.insert(characters).values({
    id: 'char_fly_route',
    name: 'Fly route character',
    description: '',
    firstMessage: 'Hello',
    alternateGreetingsJson: '[]',
    extensionsJson: '{}',
    tagsJson: '[]',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(chats).values({
    id: 'chat_fly_route',
    characterId: 'char_fly_route',
    activeBranchId: 'branch_fly_route',
    title: 'Fly route chat',
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

beforeEach(async () => {
  db = await createDb(':memory:');
  bootstrapChat();
  const adapter = new FlyTribunalAdapter({
    flyTribunal: new FlyTribunalStore(db),
    flyTribunalSettings: new FlyTribunalSettingsStore(db),
  });
  app = createFlyTribunalRoutes(adapter, { assetDir: ASSET_DIR });
});

describe('Fly Tribunal routes (FT-4)', () => {
  test('GET /api/fly/brain/manifest returns the validated committed manifest', async () => {
    const response = await app.request('/api/fly/brain/manifest');
    expect(response.status).toBe(200);

    const manifest = schemas.flyBrainManifestSchema.parse(await response.json());
    expect(manifest.format).toBe('fly-brain-manifest/1');
    expect(manifest.binary.file).toBe('connectome.bin.gz');
    expect(manifest.binary.sizeBytes).toBeGreaterThan(0);
  });

  test('GET /api/fly/brain streams the opaque gzip artifact with exact size and strong ETag', async () => {
    const manifestResponse = await app.request('/api/fly/brain/manifest');
    const manifest = schemas.flyBrainManifestSchema.parse(await manifestResponse.json());

    const response = await app.request('/api/fly/brain');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(manifest.binary.sizeBytes));
    expect(response.headers.get('ETag')).toBe(`"${manifest.binary.sha256}"`);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    // The .gz file is an opaque worker payload, not HTTP Content-Encoding.
    expect(response.headers.get('Content-Encoding')).toBeNull();
  });

  test('GET defaults then two PUTs keep settings singleton and round-trip the second full replacement', async () => {
    const initial = await app.request('/api/fly/settings');
    expect(initial.status).toBe(200);
    expect(schemas.flyTribunalSettingsSchema.parse(await initial.json())).toEqual(
      schemas.flyTribunalSettingsSchema.parse({}),
    );

    const first = schemas.flyTribunalSettingsSchema.parse({
      enabled: true,
      reactionTier: 'hint',
      regenCap: 1,
      sensitivity: 'soft',
      autoSwipeConfidence: 'normal',
      trainingEnabled: false,
      trainingSpeed: 'slow',
      precedentLifetimeDays: 7,
      hints: ['Detected: {detected}'],
      memoryScope: 'global',
    });
    const second = { ...first, reactionTier: 'auto' as const, regenCap: 3, trainingSpeed: 'fast' as const };

    for (const body of [first, second]) {
      const response = await app.request('/api/fly/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(schemas.flyTribunalSettingsSchema.parse(await response.json())).toEqual(body);
    }

    const persisted = await app.request('/api/fly/settings');
    expect(schemas.flyTribunalSettingsSchema.parse(await persisted.json())).toEqual(second);
    expect(await db.select().from(flyTribunalSettings).all()).toHaveLength(1);
  });

  test('memory GET serves the fresh global shape, then global and per-chat PUT/GET round-trip', async () => {
    const fresh = await app.request('/api/fly/memory/global');
    expect(fresh.status).toBe(200);
    expect(schemas.flyMemoryGetResponseSchema.parse(await fresh.json())).toMatchObject({
      scope: 'global',
      precedentCount: 0,
      weights: null,
    });

    const globalMemory = {
      scope: 'global' as const,
      schemaVersion: 1,
      precedentCount: 25,
      weights: Buffer.from('global learned deltas').toString('base64'),
    };
    const globalPut = await app.request('/api/fly/memory/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(globalMemory),
    });
    expect(globalPut.status).toBe(200);
    expect(schemas.flyMemoryGetResponseSchema.parse(await globalPut.json())).toMatchObject(globalMemory);

    const globalGet = await app.request('/api/fly/memory/global');
    expect(schemas.flyMemoryGetResponseSchema.parse(await globalGet.json())).toMatchObject(globalMemory);

    const chatMemory = {
      scope: 'chat' as const,
      chatId: 'chat_fly_route',
      schemaVersion: 1,
      precedentCount: 3,
      weights: null,
    };
    const chatPut = await app.request('/api/fly/memory/chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatMemory),
    });
    expect(chatPut.status).toBe(200);
    expect(schemas.flyMemoryGetResponseSchema.parse(await chatPut.json())).toMatchObject(chatMemory);

    const chatGet = await app.request('/api/fly/memory/chat?chatId=chat_fly_route');
    expect(schemas.flyMemoryGetResponseSchema.parse(await chatGet.json())).toMatchObject(chatMemory);
  });

  test('invalid memory scope is a route-level 400', async () => {
    const response = await app.request('/api/fly/memory/not-a-scope');
    expect(response.status).toBe(400);
  });
});
