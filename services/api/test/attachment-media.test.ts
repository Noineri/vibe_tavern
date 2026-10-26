import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PROVIDER_PROFILE_GENERATION_DEFAULTS, type Attachment, type StoredProviderProfileRecord } from '@vibe-tavern/domain';
import * as transport from '../src/domain/providers/provider-fetch-factory.js';
import type { ProviderExecutionInput } from '../src/infrastructure/ai/provider-execution-types.js';
import { nonstreamingProviderExecute } from '../src/infrastructure/ai/nonstreaming-provider-executor.js';
import { streamProviderExecutor } from '../src/infrastructure/ai/stream-provider-executor.js';
import { buildOneShotPrompt } from '../src/infrastructure/ai/one-shot-prompt.js';
import { prepareAttachmentMedia } from '../src/infrastructure/ai/attachment-media.js';

// T2 characterization at BOTH real executor boundaries, captured green before
// extraction. Only the provider transport and caller-owned STT seam are fake;
// describe, multimodal gate, SDK and sentConfig all run real. No paths, sleeps,
// globals, database or registry resets; the transport spy is restored on exit.
let fetchSpy: ReturnType<typeof spyOn> | undefined;
function restore() { fetchSpy?.mockRestore(); fetchSpy = undefined; }
beforeEach(restore);
afterEach(restore);
afterAll(restore);

const profile: StoredProviderProfileRecord = {
  ...PROVIDER_PROFILE_GENERATION_DEFAULTS,
  id: 'profile', name: 'Media test', providerPreset: 'openai_compat', endpoint: 'https://provider.invalid/v1',
  apiKey: null, defaultModel: 'model', coauthorTransport: 'chat_completions', generationMode: 'chat',
  bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false, tokenPadding: 0,
  proxyMode: 'direct', proxyId: null, isActive: true, visionModel: null, generationFormat: null,
  createdAt: '2026-10-24', updatedAt: '2026-10-24',
};
const image: Attachment = { id: 'image', assetId: 'image-asset', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 };
const voice: Attachment = { id: 'voice', assetId: 'voice-asset', type: 'audio', name: 'a.webm', mimeType: 'audio/webm', sizeBytes: 4, purpose: 'voice' };

function fixture(attachments: Attachment[], vision: boolean, fallback: string | null = 'fallback') {
  const events: string[] = [];
  const bodies: Array<{ model: string; stream?: boolean; messages: unknown[] }> = [];
  const persisted: Array<Array<{ attachmentId: string; description: string }>> = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(body);
    const describe = body.model === 'fallback';
    events.push(describe ? 'describe' : 'model');
    const text = describe ? 'A tower' : 'Reply';
    if (body.stream) {
      const chunks = [
        { id: 'chunk', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
        { id: 'chunk', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      id: 'response', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'Content-Type': 'application/json' } });
  }) as transport.ProviderFetch;
  fetchSpy = spyOn(transport, 'resolveProviderFetchForProfile').mockResolvedValue(fetch);
  const input: ProviderExecutionInput = {
    profile, model: 'model', cachedModels: [{ modelSlug: 'model', capabilities: { vision } }], visionModel: fallback,
    prompt: { ...buildOneShotPrompt('System', 'Look'), finalPayload: { messages: [{ role: 'user', content: 'Look', attachments }] } },
    assetLoader: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    voiceTranscriber: async () => { events.push('transcribe'); return { transcript: 'Spoken words' }; },
    onAttachmentDescriptions: async (descriptions) => { events.push(`persist:${descriptions[0]?.attachmentId}`); persisted.push(descriptions); },
  };
  const main = () => JSON.stringify(bodies.find((body) => body.model === 'model')?.messages);
  return { input, events, bodies, persisted, main };
}

for (const stream of [false, true]) {
  async function run(input: ProviderExecutionInput) {
    if (!stream) return nonstreamingProviderExecute(input);
    const result = await streamProviderExecutor(input);
    for await (const _event of result.stream) { /* Drain the real SDK stream. */ }
    expect(await result.text).toBe('Reply');
    await result.finished;
    return result;
  }
  describe(`attachment media characterization stream=${stream} (CA-4b0)`, () => {
    for (const vision of [true, false]) {
      test(`fallback vision=${vision}: describes then persists then transcribes/persists before the model; keeps pixels only for vision`, async () => {
        const attachments = [image, voice];
        const before = structuredClone(attachments);
        const h = fixture(attachments, vision);
        const result = await run(h.input);
        expect(h.events).toEqual(['describe', 'persist:image', 'transcribe', 'persist:voice', 'model']);
        expect(h.persisted).toEqual([[{ attachmentId: 'image', description: 'A tower' }], [{ attachmentId: 'voice', description: 'Spoken words' }]]);
        expect(h.main().includes('image_url')).toBe(vision);
        expect(h.main()).toContain('Transcript: Spoken words');
        if (!vision) expect(h.main()).toContain('[Attached file: a.png]\\nA tower');
        expect(result.sentConfig?.visionDescriptions).toEqual([{ attachmentId: 'image', name: 'a.png', type: 'image', description: 'A tower' }]);
        expect(attachments).toEqual(before);
      });
    }
    test('already-described images skip describe and preserve sentConfig absence', async () => {
      const h = fixture([{ ...image, description: 'Existing description' }], false);
      const result = await run(h.input);
      expect(h.events).toEqual(['model']);
      expect(h.main()).toContain('Existing description');
      expect(result.sentConfig).not.toHaveProperty('visionDescriptions');
    });
    test('without a fallback nothing is described and the native model gets pixels', async () => {
      const h = fixture([image], true, null);
      const result = await run(h.input);
      expect(h.events).toEqual(['model']);
      expect(h.main()).toContain('image_url');
      expect(result.sentConfig).not.toHaveProperty('visionDescriptions');
    });
    test('voice-only transcription uses the description persistence seam', async () => {
      const h = fixture([voice], false, null);
      await run(h.input);
      expect(h.events).toEqual(['transcribe', 'persist:voice', 'model']);
      expect(h.main()).toContain('[Voice message: a.webm]');
    });
    test('music and ambient clips never transcribe or enter prompt content', async () => {
      const h = fixture([{ ...voice, purpose: 'music' }, { ...voice, id: 'ambient', purpose: 'ambient' }], false);
      await run(h.input);
      expect(h.events).toEqual(['model']);
      expect(h.persisted).toEqual([]);
      expect(h.main()).not.toContain('a.webm');
    });
  });
}

describe('shared media missing-loader guard (CA-4b0 named deviation)', () => {
  for (const vision of [false, true]) {
    test(`missing loader skips describe/transcribe without a TypeError, vision=${vision}`, async () => {
      const h = fixture([image, voice], vision);
      const { toSdkMessages } = await import('../src/infrastructure/ai/provider-executor-utils.js');
      const messages = toSdkMessages(h.input.prompt);
      const result = await prepareAttachmentMedia(messages, { ...h.input, assetLoader: undefined });
      expect(result.messages).toBe(messages);
      expect(result.hasAttachments).toBe(true);
      expect(result.visionGate).toEqual({ hasVision: vision, visionModel: 'fallback' });
      expect(result.visionDescriptions).toBeUndefined();
      expect(h.events).toEqual([]);
      expect(h.persisted).toEqual([]);
    });
  }
});
