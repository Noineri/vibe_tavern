import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoreContainer } from '@vibe-tavern/db';
import type { Attachment } from '@vibe-tavern/domain';
import { ExperienceCopilotAdapter } from '../src/api/adapters/experience-copilot-adapter.js';
import type { RuntimeApi } from '../src/api/contract/runtime-api.js';
import { AssetService } from '../src/domain/asset/asset-service.js';
import { createProviderProfileService } from '../src/domain/providers/provider-profile-service.js';
import type { ProviderExecutionInput } from '../src/infrastructure/ai/provider-execution-types.js';
import { countTokensDefault } from '../src/infrastructure/ai/tokenizer-service.js';
import { createApp } from '../src/server/app-factory.js';

// T2: real Hono/adapter/store/asset files/profile ladder/shared actions service;
// only the external model executor is injected. Paths derive from tmpdir/join,
// workspace preload sweeps DB roots; no globals, timers or order assumptions.
// Stable completed responses only; every fresh DB rides the template.
async function setup(cleanupEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'vt-agent-attachment-actions-'));
  const stores = await createStoreContainer(join(root, 'test.db'), root);
  await stores.uiSettings.ensureDefaults();
  const providers = createProviderProfileService(stores.providers, stores.proxies);
  const profile = await providers.saveProviderProfile({ name: 'Test', providerPreset: 'openai_compat', defaultModel: 'model', temperature: 0.4 });
  const thread = await stores.experienceCopilot.startNewSession('script');
  const other = await stores.experienceCopilot.startNewSession('other-script');
  const assets = new AssetService(join(root, 'assets'), stores.content);
  const cleanup = mock(async (id: string) => assets.cleanup(id));
  const execute = mock(async (_input: ProviderExecutionInput) => ({ text: '  Short summary.\n' }));
  const adapter = new ExperienceCopilotAdapter(stores, providers, undefined, undefined, undefined,
    (id) => assets.loadBuffer(id), cleanupEnabled ? cleanup : undefined, execute);
  const app = await createApp({ runtime: { experienceCopilot: adapter } as RuntimeApi });
  async function file(text = 'Full original notes.'): Promise<Attachment> {
    const result = await assets.upload(new File([text], 'notes.md', { type: 'text/markdown' }));
    return { id: crypto.randomUUID(), assetId: result.assetId, name: 'notes.md', type: 'file', mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(text), tokenCount: result.tokenCount };
  }
  const seed = (attachments: Attachment[], threadId = thread.id) => stores.experienceCopilot.appendMessage(threadId, { role: 'user', content: 'Read this', attachments });
  function request(messageId: string, attachmentId: string, action: string, init: RequestInit = {}, threadId = thread.id) {
    return app.request(`http://localhost/api/experience-copilot/${threadId}/messages/${messageId}/attachments/${attachmentId}${action ? `/${action}` : ''}`, { method: 'POST', ...init });
  }
  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function forkWithAttachment(attachment: Attachment) {
    const character = await stores.characters.create({ name: 'Test' });
    const chat = await stores.chats.createChat({ characterId: character.id, title: 'Test', promptPresetId: null });
    const rpMessage = await stores.messages.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: 'user', authorType: 'user', content: 'Fork point' });
    const branch = await stores.chats.forkBranch(chat.id, rpMessage.id, 'Fork');
    const source = await stores.experienceCopilot.startNewChatSession(chat.id, chat.activeBranchId, 'sidechat-ooc');
    const message = await seed([attachment], source.id);
    const copy = await stores.experienceCopilot.forkChatThreadToBranch(source.id, branch.id, {
      eventPayload: (_kind, payloadJson) => ({ payloadJson }), frontierJson: (value) => value,
      trailingEvent: { kind: 'branch_forked', payload: { at: 0 } },
    });
    return { source, message, copy: copy! };
  }
  return { stores, profile, providers, thread, other, assets, cleanup, execute, file, seed, request, json, forkWithAttachment, app };
}

describe('agent attachment routes (CA-4d1)', () => {
  test('summarize persists summary/count, full-file prompt, effective profile and abort signal', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    await h.stores.experienceCopilot.updateContextMetrics(h.thread.id, { systemTokens: 0, digestTokens: 0, historyTokens: 0, totalTokens: 0, budgetTokens: 1000, reserveTokens: 100, source: 'estimate', measuredAt: '2026-10-24' }, h.profile.id, 'last-model');
    const response = await h.request(message.id, file.id, 'summarize');
    expect(response.status).toBe(200);
    const updated = { ...file, description: 'Short summary.', summaryTokenCount: countTokensDefault('Short summary.') };
    expect(await response.json()).toEqual(updated);
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toEqual(updated);
    const input = h.execute.mock.calls[0]![0];
    expect(input.model).toBe('last-model');
    expect(input.profile.id).toBe(h.profile.id);
    const system = (await Bun.file(join(import.meta.dir, '../assets/attachment-summarize.md')).text()).replace(/\r\n?/g, '\n');
    expect(input.prompt.finalPayload).toEqual({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'Full original notes.' }] });
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });
  test('body profile/model override last-used and apply that model overlay', async () => {
    const h = await setup();
    const selected = await h.providers.saveProviderProfile({ name: 'Selected', providerPreset: 'openai_compat', defaultModel: 'wrong-default', bindPerModel: true });
    await h.stores.providers.update(selected.id, { bindPerModel: true });
    await h.stores.providers.upsertModelSettings(selected.id, 'selected-model', { temperature: 0.25 });
    await h.stores.experienceCopilot.updateContextMetrics(h.thread.id, { systemTokens: 0, digestTokens: 0, historyTokens: 0, totalTokens: 0, budgetTokens: 1000, reserveTokens: 100, source: 'estimate', measuredAt: '2026-10-24' }, h.profile.id, 'last-model');
    const file = await h.file();
    const message = await h.seed([file]);
    expect((await h.request(message.id, file.id, 'summarize', h.json({ providerProfileId: selected.id, model: 'selected-model' }))).status).toBe(200);
    expect(h.execute.mock.calls[0]![0]).toMatchObject({ model: 'selected-model', profile: { id: selected.id, temperature: 0.25 } });
  });
  test('an explicit profile without any last model uses its default', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    expect((await h.request(message.id, file.id, 'summarize', h.json({ providerProfileId: h.profile.id }))).status).toBe(200);
    expect(h.execute.mock.calls[0]![0].model).toBe('model');
  });
  test('without a resolvable profile the summarize validation error names summarizing', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    const response = await h.request(message.id, file.id, 'summarize');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { kind: 'Validation', message: 'Provider profile is required to summarize the attachment (no prior turn to inherit).' } });
    expect(h.execute).not.toHaveBeenCalled();
  });
  test('clear-summary removes both values and include false/true persists independently', async () => {
    const h = await setup();
    const file = { ...await h.file(), description: 'Summary', summaryTokenCount: 4, includeInPrompt: false };
    const message = await h.seed([file]);
    const response = await h.request(message.id, file.id, 'clear-summary');
    expect(response.status).toBe(200);
    const { summaryTokenCount: _removed, ...rest } = file;
    expect(await response.json()).toEqual({ ...rest, description: null });
    for (const includeInPrompt of [true, false]) {
      const response = await h.request(message.id, file.id, 'include-in-prompt', h.json({ includeInPrompt }, 'PATCH'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const stored = await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id);
      expect(stored).toEqual({ ...rest, description: null, includeInPrompt });
      expect(Object.hasOwn(stored!, 'summaryTokenCount')).toBe(false);
    }
  });
  test('include validates a boolean rather than silently changing state', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    expect((await h.request(message.id, file.id, 'include-in-prompt', h.json({ includeInPrompt: 'false' }, 'PATCH'))).status).toBe(400);
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toEqual(file);
  });
  test('delete removes the asset after the row edit and is idempotent', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await h.request(message.id, file.id, '', { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toBeNull();
    expect(await h.assets.loadBuffer(file.assetId)).toBeNull();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
  test('a fork copy retains the shared file until its last reference is removed', async () => {
    const h = await setup();
    const file = await h.file();
    const { source, message, copy } = await h.forkWithAttachment(file);
    expect((await h.request(message.id, file.id, '', { method: 'DELETE' }, source.id)).status).toBe(200);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
    const copied = (await h.stores.experienceCopilot.listMessages(copy.id))[0]!;
    expect(copied.attachments).toEqual([file]);
    expect((await h.request(copied.id, file.id, '', { method: 'DELETE' }, copy.id)).status).toBe(200);
    expect(h.cleanup).toHaveBeenCalledWith(file.assetId);
    expect(await h.assets.loadBuffer(file.assetId)).toBeNull();
  });
  test('every route refuses foreign-thread and missing messages without side effects', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    const actions = [['summarize', h.json({ providerProfileId: h.profile.id })], ['clear-summary', {}], ['include-in-prompt', h.json({ includeInPrompt: false }, 'PATCH')], ['', { method: 'DELETE' }]] as const;
    for (const [action, init] of actions) {
      expect((await h.request(message.id, file.id, action, init, h.other.id)).status).toBe(404);
      expect((await h.request('missing', file.id, action, init)).status).toBe(404);
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toEqual(file);
  });
  test('image summarize returns the shared refusal code', async () => {
    const h = await setup();
    const image: Attachment = { ...await h.file(), type: 'image', mimeType: 'image/png' };
    const message = await h.seed([image]);
    const response = await h.request(message.id, image.id, 'summarize', h.json({ providerProfileId: h.profile.id }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { code: 'attachment_not_text' } } });
    expect(h.execute).not.toHaveBeenCalled();
  });
  test('request abort reaches generation and a late result cannot overwrite attachments', async () => {
    const h = await setup();
    const file = await h.file();
    const message = await h.seed([file]);
    const controller = new AbortController();
    h.execute.mockImplementation(async ({ signal }) => {
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { text: 'Too late' };
    });
    await h.request(message.id, file.id, 'summarize', { ...h.json({ providerProfileId: h.profile.id }), signal: controller.signal });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toEqual(file);
  });
  test('without optional cleanup row deletion leaves the physical asset alone', async () => {
    const h = await setup(false);
    const file = await h.file();
    const message = await h.seed([file]);
    expect((await h.request(message.id, file.id, '', { method: 'DELETE' })).status).toBe(200);
    expect(await h.stores.experienceCopilot.findMessageAttachment(message.id, file.id)).toBeNull();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
    expect(h.cleanup).not.toHaveBeenCalled();
  });
});

describe('agent turn attachment cleanup (CA-4d2)', () => {
  async function deleteTurn(h: Awaited<ReturnType<typeof setup>>, messageId: string, includeUserMessage: boolean, threadId = h.thread.id) {
    return h.app.request(`http://localhost/api/experience-copilot/${threadId}/turns/delete`, h.json({ messageId, includeUserMessage }));
  }
  test('deleting the exchange deletes all user files after removing the rows, with unchanged wire shape', async () => {
    const h = await setup();
    const first = await h.file('First file');
    const second = await h.file('Second file');
    const user = await h.seed([first, second]);
    const assistant = await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'assistant', content: 'Answer' });
    h.cleanup.mockImplementation(async (assetId) => {
      expect(await h.stores.experienceCopilot.listMessages(h.thread.id)).toEqual([]);
      h.assets.cleanup(assetId);
    });
    const response = await deleteTurn(h, assistant.id, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedMessageIds: [user.id, assistant.id], deletedUserMessageId: user.id });
    expect(h.cleanup).toHaveBeenCalledTimes(2);
    expect(await h.assets.loadBuffer(first.assetId)).toBeNull();
    expect(await h.assets.loadBuffer(second.assetId)).toBeNull();
  });
  test('a forked thread keeps the shared asset until its own turn is deleted', async () => {
    const h = await setup();
    const file = await h.file();
    const { source, message, copy } = await h.forkWithAttachment(file);
    expect((await deleteTurn(h, message.id, true, source.id)).status).toBe(200);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
    const copied = (await h.stores.experienceCopilot.listMessages(copy.id))[0]!;
    expect(copied.attachments).toEqual([file]);
    expect((await deleteTurn(h, copied.id, true, copy.id)).status).toBe(200);
    expect(h.cleanup).toHaveBeenCalledWith(file.assetId);
    expect(await h.assets.loadBuffer(file.assetId)).toBeNull();
  });
  test('a digest-floor refusal deletes neither rows nor files', async () => {
    const h = await setup();
    const file = await h.file();
    const user = await h.seed([file]);
    await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'assistant', content: 'Answer' });
    const anchor = await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'user', content: 'Kept turn' });
    await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'digest', content: 'Digest', toolCallId: anchor.id });
    const before = await h.stores.experienceCopilot.listMessages(h.thread.id);
    expect((await deleteTurn(h, user.id, true)).status).toBe(409);
    expect(await h.stores.experienceCopilot.listMessages(h.thread.id)).toEqual(before);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
  });
  test('deleting only the assistant turn preserves the user attachment and its file', async () => {
    const h = await setup();
    const file = await h.file();
    const user = await h.seed([file]);
    const assistant = await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'assistant', content: 'Answer' });
    const response = await deleteTurn(h, assistant.id, false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedMessageIds: [assistant.id], deletedUserMessageId: null });
    expect(await h.stores.experienceCopilot.findMessageAttachment(user.id, file.id)).toEqual(file);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
  });
  test('user-row refusal and missing message/thread delete no assets', async () => {
    const h = await setup();
    const file = await h.file();
    const user = await h.seed([file]);
    expect((await deleteTurn(h, user.id, false)).status).toBe(400);
    expect((await deleteTurn(h, 'missing', true)).status).toBe(404);
    expect((await deleteTurn(h, user.id, true, 'missing-thread')).status).toBe(404);
    expect(await h.stores.experienceCopilot.findMessageAttachment(user.id, file.id)).toEqual(file);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
  });
  test('absent cleanup deletes the rows without deleting files', async () => {
    const h = await setup(false);
    const file = await h.file();
    const user = await h.seed([file]);
    expect((await deleteTurn(h, user.id, true)).status).toBe(200);
    expect(await h.stores.experienceCopilot.listMessages(h.thread.id)).toEqual([]);
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
    expect(h.cleanup).not.toHaveBeenCalled();
  });
  test('keepAttachmentFiles (CA-4e1) deletes the rows and keeps the files', async () => {
    const h = await setup();
    const file = await h.file();
    const user = await h.seed([file]);
    const assistant = await h.stores.experienceCopilot.appendMessage(h.thread.id, { role: 'assistant', content: 'Answer' });
    const response = await h.app.request(`http://localhost/api/experience-copilot/${h.thread.id}/turns/delete`,
      h.json({ messageId: assistant.id, includeUserMessage: true, keepAttachmentFiles: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedMessageIds: [user.id, assistant.id], deletedUserMessageId: user.id });
    expect(await h.stores.experienceCopilot.listMessages(h.thread.id)).toEqual([]);
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(await h.assets.loadBuffer(file.assetId)).not.toBeNull();
  });
});

describe('shell profile image route (CA-4e1)', () => {
  function imageRoute(h: Awaited<ReturnType<typeof setup>>, query: string) {
    return h.app.request(`http://localhost/api/experience-copilot/image-route${query}`);
  }
  test('a vision model answers native', async () => {
    const h = await setup();
    await h.stores.providers.saveCachedModels(h.profile.id, [{ modelSlug: 'model', modelName: 'Model', contextLength: null, capabilities: { vision: true } }]);
    const response = await imageRoute(h, `?providerProfileId=${h.profile.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: 'native' });
  });
  test('a non-vision model with a fallback answers describe, without one none', async () => {
    const h = await setup();
    await h.stores.providers.saveCachedModels(h.profile.id, [{ modelSlug: 'model', modelName: 'Model', contextLength: null, capabilities: { vision: false } }]);
    expect(await (await imageRoute(h, `?providerProfileId=${h.profile.id}`)).json()).toEqual({ route: 'none' });
    await h.providers.saveProviderProfile({ ...h.profile, visionModel: 'fallback' });
    expect(await (await imageRoute(h, `?providerProfileId=${h.profile.id}&model=model`)).json()).toEqual({ route: 'describe' });
  });
  test('an unknown profile is the shared not-found family', async () => {
    const h = await setup();
    const response = await imageRoute(h, '?providerProfileId=missing');
    expect(response.status).toBe(404);
  });
  test('no model in the query and none in the profile is a validation error', async () => {
    const h = await setup();
    const bare = await h.providers.saveProviderProfile({ name: 'Bare', providerPreset: 'openai_compat', defaultModel: null });
    const response = await imageRoute(h, `?providerProfileId=${bare.id}`);
    expect(response.status).toBe(400);
  });
});
