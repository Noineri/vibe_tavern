import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LanguageModel, ModelMessage } from 'ai';
import { createStoreContainer, deleteCopilotTurn } from '@vibe-tavern/db';
import type { Attachment } from '@vibe-tavern/domain';
import { isAgentContentTurn, storeMessagesToHistory, streamAgentTurn, type AgentStreamDeps, type AgentStreamSeams, type AgentTurnRequest } from '../src/domain/agent/agent-stream.js';
import * as vision from '../src/infrastructure/ai/vision-gate.js';

// T2: real generic loop, store, patch writer, media step and gate. Only the
// external model and vision-description calls are fake; DBs use the template.
// Restore spies between tests and after the file; no fixed paths, global state,
// sleeps, i18n initialization or platform/order assumptions.
const spies: Array<{ mockRestore(): void }> = [];
function restore() { for (const spy of spies.splice(0)) spy.mockRestore(); }
beforeEach(restore);
afterEach(restore);
afterAll(restore);

const image: Attachment = { id: 'image', assetId: 'image-asset', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 };
const file: Attachment = { id: 'file', assetId: 'file-asset', type: 'file', name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 12, tokenCount: 1200 };
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
async function fixture(hasVision = false, visionModel: string | null = null) {
  const stores = await createStoreContainer(':memory:');
  const profile = await stores.providers.create({ name: 'Test', providerPreset: 'openai_compat', endpoint: 'https://provider.invalid/v1', defaultModel: 'model', proxyMode: 'direct' });
  const thread = await stores.experienceCopilot.startNewSession('script');
  const store = stores.experienceCopilot;
  let captured: ModelMessage[] = [];
  const stream = mock((options: { messages: ModelMessage[] }) => {
    captured = options.messages;
    return {
      stream: (async function* () { yield { type: 'text-delta', text: 'Reply' }; })(),
      finishReason: Promise.resolve('stop'), usage: Promise.resolve(undefined),
    };
  });
  const loader = mock(async (id: string): Promise<Buffer | null> => id === 'file-asset' ? Buffer.from('Whole file\nLast line\n') : bytes);
  const resolveVisionAssets = mock(async () => ({ cachedModels: [{ modelSlug: 'model', capabilities: { vision: hasVision } }], visionModel, assetLoader: loader }));
  const deps: AgentStreamDeps = {
    store: {
      getById: (id) => store.getById(id), listMessages: (id) => store.listMessages(id),
      appendMessage: (id, input) => store.appendMessage(id, input),
      setToolResultOutput: (...args) => store.setToolResultOutput(...args),
      updateContextMetrics: (...args) => store.updateContextMetrics(...args),
      updateMessageAttachment: (...args) => store.updateMessageAttachment(...args),
    },
    getProviderProfile: async () => profile, getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    streamText: stream as unknown as AgentStreamDeps['streamText'], resolveVisionAssets,
    deleteTurn: (id, messageId, includeUser) => deleteCopilotTurn({ db: stores.db }, id, messageId, includeUser),
  };
  const seams: AgentStreamSeams = {
    logChannelPrefix: 'test-agent', threadLabel: 'Thread',
    limits: { contextBudgetTokens: 10000, responseReserveTokens: 1000, toolLoopCeiling: 10 },
    loadContext: async () => null, resolveProfile: async () => null, buildTools: () => ({}),
    assemble: async ({ history }) => ({
      systemMessage: 'System', messages: [{ role: 'system', content: 'System' }, ...history.filter((message) => message.role !== 'digest')],
      tokenAccounting: { system: 1, digest: 0, attached: 0, history: 1, total: 2 },
    }),
  };
  async function run(request: Partial<AgentTurnRequest> = {}, overrides: Partial<AgentStreamDeps> = {}) {
    const events = [];
    for await (const event of streamAgentTurn({ threadId: thread.id, providerProfileId: profile.id, content: 'Look', ...request }, { ...deps, ...overrides }, seams)) events.push(event);
    return events;
  }
  return { stores, store, thread, deps, seams, run, stream, loader, resolveVisionAssets, messages: () => captured };
}

describe('generic agent attachments (CA-4b1)', () => {
  test('the shared content-mode predicate includes attachment-only turns and treats empty arrays as absent', () => {
    expect(isAgentContentTurn({})).toBe(false);
    expect(isAgentContentTurn({ attachments: [] })).toBe(false);
    expect(isAgentContentTurn({ attachments: [image] })).toBe(true);
    expect(isAgentContentTurn({ content: 'Text' })).toBe(true);
    expect(isAgentContentTurn({ content: '' })).toBe(true);
  });
  test('native vision gets the actual image bytes', async () => {
    const h = await fixture(true);
    const events = await h.run({ attachments: [image] });
    expect(events.map((event) => event.event)).toEqual(['text-delta', 'finish']);
    expect(h.messages()[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', image: bytes, mediaType: 'image/png' }] });
  });
  test('fallback describes and persists on the owning prior and newly appended rows', async () => {
    const describe = spyOn(vision, 'describeAttachments').mockResolvedValue(new Map([['old-image', 'Old tower'], ['image', 'New tower']]));
    spies.push(describe);
    const h = await fixture(false, 'fallback');
    const prior = await h.store.appendMessage(h.thread.id, { role: 'user', content: 'Earlier', attachments: [{ ...image, id: 'old-image' }, file] });
    expect((await h.run({ attachments: [image] })).at(-1)?.event).toBe('finish');
    expect(describe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.messages())).toContain('Old tower');
    expect(JSON.stringify(h.messages())).toContain('New tower');
    const rows = await h.store.listMessages(h.thread.id);
    expect(await h.store.findMessageAttachment(prior.id, 'old-image')).toEqual({ ...image, id: 'old-image', description: 'Old tower' });
    expect(rows.find((row) => row.role === 'user' && row.id !== prior.id)?.attachments).toEqual([{ ...image, description: 'New tower' }]);
    expect(await h.store.findMessageAttachment(prior.id, file.id)).toEqual(file);
  });
  test('a current unseen image produces only the setup error event, never calls the model, and keeps the user row', async () => {
    const h = await fixture();
    const events = await h.run({ attachments: [image] }, { resolveVisionAssets: undefined });
    expect(events.map((event) => event.event)).toEqual(['error']);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ message: expect.stringContaining('Cannot process images:'), category: expect.any(String) });
    expect(h.stream).not.toHaveBeenCalled();
    expect((await h.store.listMessages(h.thread.id))[0]?.attachments).toEqual([image]);
  });
  test('an unseen image in an earlier turn becomes the CA-1g note and generation proceeds', async () => {
    const h = await fixture();
    await h.store.appendMessage(h.thread.id, { role: 'user', content: 'Earlier', attachments: [image] });
    expect((await h.run()).at(-1)?.event).toBe('finish');
    expect(h.messages()[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Earlier' },
      { type: 'text', text: '[Image attachment: a.png]\nThe current model cannot see this attachment and no description is available.' },
    ] });
  });
  test('a text file sends its whole text', async () => {
    const h = await fixture();
    await h.run({ attachments: [file] });
    expect(h.messages()[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'text', text: '[Attached file: notes.md]\nWhole file\nLast line\n' }] });
  });
  test('a summarized prior file sends its summary without loading the full asset', async () => {
    const h = await fixture();
    await h.store.appendMessage(h.thread.id, { role: 'user', attachments: [{ ...file, description: 'Summary', summaryTokenCount: 20 }] });
    await h.run();
    expect(JSON.stringify(h.messages())).toContain('[Attached file: notes.md]\\nSummary');
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('excluded files and generated-image slots stay out; no visible attachments means no vision dependency', async () => {
    const h = await fixture();
    await h.run({ attachments: [{ ...file, includeInPrompt: false }, { ...image, imageGen: { mode: 'portrait', profileId: 'p', params: {} } }] });
    expect(h.messages()).toEqual([{ role: 'system', content: 'System' }, { role: 'user', content: 'Look' }]);
    expect(h.resolveVisionAssets).not.toHaveBeenCalled();
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('regenerate keeps the surviving user attachment and does not push another user row', async () => {
    const h = await fixture(true);
    const user = await h.store.appendMessage(h.thread.id, { role: 'user', content: 'Original', attachments: [image] });
    await h.store.appendMessage(h.thread.id, { role: 'assistant', content: 'Replaced' });
    await h.run({ content: undefined, regenerate: true });
    expect(JSON.stringify(h.messages())).toContain('Original');
    expect(h.messages()[1]?.content).toEqual([{ type: 'text', text: 'Original' }, { type: 'image', image: bytes, mediaType: 'image/png' }]);
    const users = (await h.store.listMessages(h.thread.id)).filter((row) => row.role === 'user');
    expect(users.map((row) => row.id)).toEqual([user.id]);
  });
  test('an attachment-only turn persists empty content plus attachments and streams', async () => {
    const h = await fixture();
    expect((await h.run({ content: undefined, attachments: [file] })).at(-1)?.event).toBe('finish');
    expect((await h.store.listMessages(h.thread.id))[0]).toMatchObject({ role: 'user', content: '', attachments: [file] });
  });
  test('zero-attachment history and tool messages use the exact converter without media calls', async () => {
    const h = await fixture();
    await h.store.appendMessage(h.thread.id, { role: 'assistant', content: '', toolCallsJson: JSON.stringify([{ toolCallId: 'call', toolName: 'tool', input: {} }]) });
    await h.store.appendMessage(h.thread.id, { role: 'tool', content: JSON.stringify({ toolName: 'tool', output: 'Result' }), toolCallId: 'call' });
    await h.run();
    expect(h.messages()).toEqual([
      { role: 'system', content: 'System' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'tool', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'tool', output: { type: 'text', value: '{"result":"Result"}' } }] },
      { role: 'user', content: 'Look' },
    ]);
    expect(h.resolveVisionAssets).not.toHaveBeenCalled();
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('description writes are optional when the port or appended row id is absent', async () => {
    spies.push(spyOn(vision, 'describeAttachments').mockResolvedValue(new Map([[image.id, 'Tower']])));
    for (const missing of ['port', 'id']) {
      const h = await fixture(false, 'fallback');
      if (missing === 'port') delete h.deps.store.updateMessageAttachment;
      else h.deps.store.appendMessage = async (id, input) => { await h.store.appendMessage(id, input); };
      expect((await h.run({ attachments: [image] })).at(-1)?.event).toBe('finish');
      expect((await h.store.listMessages(h.thread.id))[0]?.attachments).toEqual([image]);
    }
  });
  test('voice errors, missing assets and describe errors produce the same setup error event', async () => {
    for (const mode of ['voice', 'asset', 'describe']) {
      const h = await fixture(mode === 'asset', mode === 'describe' ? 'fallback' : null);
      if (mode === 'asset') h.loader.mockResolvedValue(null);
      if (mode === 'describe') spies.push(spyOn(vision, 'describeAttachments').mockRejectedValue(new Error('Describe provider failed')));
      const attachment: Attachment = mode === 'voice' ? { ...file, type: 'audio', mimeType: 'audio/webm' } : image;
      expect((await h.run({ attachments: [attachment] })).map((event) => event.event)).toEqual(['error']);
      expect(h.stream).not.toHaveBeenCalled();
    }
  });
  test('the stored history projection omits empty lists and never adds attachments to tool/assistant rows', () => {
    const base = { id: 'm', content: 'Text', toolCallId: null, toolCallsJson: null };
    expect(storeMessagesToHistory([{ ...base, role: 'user', attachments: [{ ...file, includeInPrompt: false }] }])).toEqual([{ role: 'user', content: 'Text' }]);
    expect(storeMessagesToHistory([{ ...base, role: 'assistant', attachments: [image] }])).toEqual([{ role: 'assistant', content: 'Text' }]);
  });
});
