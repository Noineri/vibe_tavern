import { describe, expect, mock, test } from 'bun:test';
import type { LanguageModel, ModelMessage } from 'ai';
import { createStoreContainer } from '@vibe-tavern/db';
import type { Attachment } from '@vibe-tavern/domain';
import { buildAgentProviderDeps } from '../src/api/adapters/experience-copilot-provider-deps.js';
import { streamExperienceCopilot } from '../src/domain/interactive/copilot/experience-copilot-stream.js';
import { streamScriptAgentTurn } from '../src/domain/agent/script-agent/script-agent-stream.js';
import { streamSidechatTurn } from '../src/domain/sidechat/sidechat-stream.js';
import { PromptAssemblyService } from '../src/domain/prompt/prompt-assembly-service.js';
import { StaticPromptResolver } from '../src/domain/prompt/prompt-resolver.js';
import { RegexHookService } from '../src/domain/regex/regex-hook-service.js';
import type { AgentStreamDeps } from '../src/domain/agent/agent-stream.js';

// T2: the real provider-deps builder, stores, every kind's stream entry and
// generic core. Only the model call is fake (the established streamText seam).
// Template-backed DBs per test, local fixture state, no global patches,
// registry resets, timers, i18n initialization or platform/order assumptions.
const image: Attachment = { id: 'image', assetId: 'image-asset', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4 };
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
async function fixture() {
  const stores = await createStoreContainer(':memory:');
  await Promise.all([stores.personas.ensureDefault(), stores.presets.ensureDefault(), stores.uiSettings.ensureDefaults()]);
  const profile = await stores.providers.create({ name: 'Test', endpoint: 'https://provider.invalid/v1', providerPreset: 'openai_compat', defaultModel: 'model', visionModel: 'fallback', proxyMode: 'direct' });
  await stores.providers.saveCachedModels(profile.id, [{ modelSlug: 'model', modelName: 'Model', contextLength: null, capabilities: { vision: true } }]);
  const loader = mock(async () => bytes);
  const provider = buildAgentProviderDeps({ stores, attachmentAssetLoader: loader });
  let captured: ModelMessage[] = [];
  const streamText = ((options: { messages: ModelMessage[] }) => {
    captured = options.messages;
    return { stream: (async function* () { yield { type: 'text-delta', text: 'Reply' }; })(), finishReason: Promise.resolve('stop'), usage: Promise.resolve(undefined) };
  }) as unknown as AgentStreamDeps['streamText'];
  const resolveVisionAssets = mock(async (input: typeof profile) => {
    const assets = await provider.resolveVisionAssets(input);
    // The forwarding test selects native vision alone: describing an image is
    // a separate network boundary already characterized by CA-4b0.
    return { ...assets, visionModel: null };
  });
  return { stores, profile, loader, provider, resolveVisionAssets, streamText, messages: () => captured };
}

describe('agent provider/vision wiring (CA-4b2)', () => {
  test('builder returns the profile cache, injected loader, fallback and default service prompt', async () => {
    const h = await fixture();
    const assets = await h.provider.resolveVisionAssets(h.profile);
    expect(assets.cachedModels).toEqual(await h.stores.providers.getCachedModels(h.profile.id));
    expect(assets.visionModel).toBe('fallback');
    expect(assets.assetLoader).toBe(h.loader);
    expect(assets.visionDescribePrompt).toBe((await Bun.file(`${import.meta.dir}/../assets/vision-describe-ai-prompt.md`).text()).replace(/\r\n?/g, '\n'));
    expect(Object.hasOwn(assets, 'voiceTranscriber')).toBe(false);
  });
  test('the moved effective-profile rule retains the overlay and exact not-found error', async () => {
    const h = await fixture();
    expect(await h.provider.getEffectiveProviderProfile(h.profile.id, 'model')).toEqual(h.profile);
    await h.stores.providers.update(h.profile.id, { bindPerModel: true });
    await h.stores.providers.upsertModelSettings(h.profile.id, 'model', { temperature: 0.25, maxTokens: 123 });
    expect(await h.provider.getEffectiveProviderProfile(h.profile.id, 'model')).toMatchObject({ id: h.profile.id, temperature: 0.25, maxTokens: 123 });
    await expect(h.provider.getEffectiveProviderProfile('missing', 'model')).rejects.toMatchObject({ message: "Provider profile 'missing' was not found." });
  });
  for (const kind of ['experience', 'script', 'sidechat'] as const) {
    test(`${kind}: real entry forwards the turn profile and an image reaches the model as pixels`, async () => {
      const h = await fixture();
      const providerDeps = { ...h.provider, resolveVisionAssets: h.resolveVisionAssets, resolveModel: () => ({}) as LanguageModel, streamText: h.streamText };
      const common = { ...providerDeps, store: h.stores.experienceCopilot, agentPlans: h.stores.agentPlans, db: h.stores.db };
      // These getScript/visual seams match the kind harnesses' draft paths.
      const thread = await h.stores.experienceCopilot.startNewSession('script');
      const request = { threadId: thread.id, providerProfileId: h.profile.id, content: 'Look', attachments: [image] };
      let stream: AsyncIterable<{ event: string }>;
      if (kind === 'experience') {
        stream = streamExperienceCopilot(request, { ...common, getScript: async () => null, getBoundVisualIds: async () => [], getVisual: async () => null });
      } else if (kind === 'script') {
        stream = streamScriptAgentTurn(request, { ...common, stores: h.stores, getScript: async () => null, getContextCards: async () => ({ ownerNames: [], cards: [] }) });
      } else {
        const character = await h.stores.characters.create({ name: 'Test' });
        const chat = await h.stores.chats.createChat({ characterId: character.id, title: 'Test', promptPresetId: null });
        const sidechat = await h.stores.experienceCopilot.startNewChatSession(chat.id, chat.activeBranchId, 'sidechat-ooc');
        const assembly = new PromptAssemblyService(h.stores, new StaticPromptResolver(h.stores, new RegexHookService(h.stores)), h.stores.content.fileStore);
        const reads = { chats: h.stores.chats, messages: h.stores.messages, assembly, experienceCopilot: h.stores.experienceCopilot };
        // No content: this also proves the CA-4b1 predicate reached sidechat.
        stream = streamSidechatTurn({ ...request, threadId: sidechat.id, content: undefined }, {
          ...common, sync: reads, attach: reads,
          context: { ...reads, characters: h.stores.characters, traces: h.stores.traces, chatSummaries: h.stores.chatSummaries, presets: h.stores.presets },
        });
      }
      const events = [];
      for await (const event of stream) events.push(event.event);
      expect(events).toEqual(['text-delta', 'finish']);
      expect(h.resolveVisionAssets).toHaveBeenCalledTimes(1);
      expect(h.resolveVisionAssets).toHaveBeenCalledWith(h.profile);
      const parts = h.messages().flatMap((message) => Array.isArray(message.content) ? message.content : []);
      expect(parts).toContainEqual({ type: 'image', image: bytes, mediaType: 'image/png' });
    });
  }
});
