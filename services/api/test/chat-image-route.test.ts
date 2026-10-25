import { describe, expect, test } from 'bun:test';
import { createStoreContainer } from '@vibe-tavern/db';
import { ChatAdapter } from '../src/api/adapters/chat-adapter.js';
import type { RuntimeApi } from '../src/api/contract/runtime-api.js';
import { createProviderProfileService } from '../src/domain/providers/provider-profile-service.js';
import { createApp } from '../src/server/app-factory.js';

// T2: real Hono, profile resolution, cache, stores and error mapping. Unused
// generation dependencies are inert; no network/globals/waits/paths. Fresh
// template-backed DB per test, no shared ordering or mutable fixture state.
async function setup(mode: 'rp' | 'coauthor' = 'rp') {
  const stores = await createStoreContainer(':memory:');
  await stores.uiSettings.ensureDefaults();
  const providers = createProviderProfileService(stores.providers, stores.proxies);
  const rp = await providers.saveProviderProfile({ name: 'RP', providerPreset: 'openai_compat', defaultModel: 'rp-model' });
  await providers.activateProviderProfile(rp.id);
  const coauthor = await providers.saveProviderProfile({ name: 'Co-Author', providerPreset: 'openai_compat', defaultModel: 'wrong-base-model' });
  await stores.coauthorSettings.upsert(coauthor.id, { modelName: 'coauthor-model', settings: {} });
  await stores.uiSettings.update({ coauthorProviderId: coauthor.id });
  const character = await stores.characters.create({ name: 'Test' });
  const chat = await stores.chats.createChat({ characterId: character.id, title: 'Test', promptPresetId: null, mode });
  const adapter = new ChatAdapter(stores, null!, null!, null!, providers, null!, async () => null);
  const app = await createApp({ runtime: { chat: adapter } as RuntimeApi });
  async function cache(profileId: string, modelSlug: string, vision: boolean) {
    await stores.providers.saveCachedModels(profileId, [{ modelSlug, modelName: modelSlug, contextLength: null, capabilities: { vision } }]);
  }
  return { stores, providers, rp, coauthor, chat, cache, request: (id = chat.id) => app.request(`http://localhost/api/chats/${id}/image-route`) };
}

describe('chat image route (CA-1h1)', () => {
  test('the effective cached RP model supports native vision', async () => {
    const h = await setup();
    await h.cache(h.rp.id, 'rp-model', true);
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: 'native' });
  });
  test('non-vision plus a configured fallback describes', async () => {
    const h = await setup();
    await h.cache(h.rp.id, 'rp-model', false);
    await h.providers.saveProviderProfile({ ...h.rp, visionModel: 'fallback' });
    expect(await (await h.request()).json()).toEqual({ route: 'describe' });
  });
  test('no native vision and no fallback returns none', async () => {
    const h = await setup();
    await h.cache(h.rp.id, 'rp-model', false);
    expect(await (await h.request()).json()).toEqual({ route: 'none' });
  });
  test('Co-Author uses its own bound profile and connection-settings model, not the RP or base model', async () => {
    const h = await setup('coauthor');
    await h.cache(h.rp.id, 'rp-model', false);
    await h.stores.providers.saveCachedModels(h.coauthor.id, [
      { modelSlug: 'wrong-base-model', modelName: 'Base', contextLength: null, capabilities: { vision: false } },
      { modelSlug: 'coauthor-model', modelName: 'Co-Author', contextLength: null, capabilities: { vision: true } },
    ]);
    expect(await (await h.request()).json()).toEqual({ route: 'native' });
  });
  test('unknown chats return the existing not-found family', async () => {
    const h = await setup();
    const response = await h.request('missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { kind: 'NotFound', message: "Chat 'missing' was not found." } });
  });
  test('missing Co-Author connection keeps the send error unchanged', async () => {
    const h = await setup('coauthor');
    await h.stores.uiSettings.update({ coauthorProviderId: null });
    const response = await h.request();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { kind: 'Validation', message: 'Choose a model for the Co-Author.', details: { code: 'coauthor_model_required' } } });
  });
});
