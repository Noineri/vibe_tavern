import { describe, expect, mock, test } from 'bun:test';
import { createStoreContainer, ExperienceCopilotStore } from '@vibe-tavern/db';
import type { Attachment } from '@vibe-tavern/domain';
import { estimateHistoryTokens, type AgentFlowMessage } from '../src/domain/agent/agent-prompt.js';
import { createProviderProfileService } from '../src/domain/providers/provider-profile-service.js';
import { ExperienceCopilotCompactionService } from '../src/domain/interactive/copilot/experience-copilot-compaction.js';
import { ScriptAgentCompactionService } from '../src/domain/agent/script-agent/script-agent-compaction.js';
import { SidechatOocCompactionService } from '../src/domain/sidechat/sidechat-compaction.js';
import { assembleScriptAgentPrompt } from '../src/domain/agent/script-agent/script-agent-prompt.js';
import type { ProviderExecutionInput } from '../src/infrastructure/ai/provider-execution-types.js';
import type { nonstreamingProviderExecute } from '../src/infrastructure/ai/nonstreaming-provider-executor.js';
import type { AttachmentAssetLoader } from '../src/infrastructure/ai/vision-gate.js';
import '../src/domain/agent/kinds/script-kind.js';

// T0 estimate + T2 real store/compaction/renderer; only the external executor
// and asset loader are injected. Paths: none; global mutations/restores: none;
// no waits or platform/order assumptions; stable completed calls only. Fresh
// template-backed DBs and local deterministic clocks/ids per fixture.
const file: Attachment = { id: 'file', assetId: 'file-asset', type: 'file', name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 10, tokenCount: 30000 };
const image: Attachment = { id: 'image', assetId: 'image-asset', type: 'image', name: 'tower.png', mimeType: 'image/png', sizeBytes: 4, description: 'A tall tower' };
const fullText = 'FULL FILE TEXT\nLast line';
async function fixture(attachments: Attachment[], kind: 'experience' | 'script' | 'sidechat' = 'experience') {
  const stores = await createStoreContainer(':memory:');
  const profiles = createProviderProfileService(stores.providers, stores.proxies);
  const profile = await profiles.saveProviderProfile({ name: 'Test', providerPreset: 'openai_compat', defaultModel: 'model', apiKey: 'test-key' });
  let step = 0;
  const store = new ExperienceCopilotStore(stores.db, {
    clock: { now: () => new Date(Date.UTC(2026, 9, 24) + step++ * 1000).toISOString() },
    idGenerator: { next: (prefix) => `${prefix}_${step++}` },
  });
  let thread;
  if (kind === 'sidechat') {
    const character = await stores.characters.create({ name: 'Test' });
    const chat = await stores.chats.createChat({ characterId: character.id, title: 'Test', promptPresetId: null });
    thread = await store.startNewChatSession(chat.id, chat.activeBranchId, 'sidechat-ooc');
  } else thread = await store.startNewSession('script');
  await store.appendMessage(thread.id, { role: 'user', content: 'Read this', attachments });
  await store.appendMessage(thread.id, { role: 'assistant', content: 'Understood' });
  for (let index = 0; index < 8; index++) await store.appendMessage(thread.id, { role: index % 2 ? 'assistant' : 'user', content: `Kept ${index}` });
  const calls: ProviderExecutionInput[] = [];
  const execute = (async (input: ProviderExecutionInput) => {
    calls.push(input);
    return { text: 'Digest', providerResponse: {} };
  }) as unknown as typeof nonstreamingProviderExecute;
  const loader = mock(async (id: string) => {
    if (id !== file.assetId) throw new Error('Compaction must never load image bytes');
    return Buffer.from(fullText);
  });
  async function compact(assetLoader?: AttachmentAssetLoader) {
    const Service = kind === 'experience' ? ExperienceCopilotCompactionService
      : kind === 'script' ? ScriptAgentCompactionService : SidechatOocCompactionService;
    const service = new Service(store, profiles, execute, stores.db, assetLoader);
    await service.compact({ threadId: thread.id, providerProfileId: profile.id });
    return calls.at(-1)!.prompt;
  }
  return { compact, loader };
}

describe('agent attachment estimates and digest (CA-4c)', () => {
  const history: AgentFlowMessage[] = [{ role: 'user', content: 'Read this' }];
  test('a full file adds exactly its stored token count', () => {
    expect(estimateHistoryTokens([{ role: 'user', content: 'Read this', attachments: [file] }]) - estimateHistoryTokens(history)).toBe(30000);
  });
  test('a summarized file adds the summary count instead', () => {
    expect(estimateHistoryTokens([{ role: 'user', content: 'Read this', attachments: [{ ...file, description: 'Short summary', summaryTokenCount: 20 }] }]) - estimateHistoryTokens(history)).toBe(20);
  });
  test('images add zero', () => {
    expect(estimateHistoryTokens([{ role: 'user', content: 'Read this', attachments: [image] }])).toBe(estimateHistoryTokens(history));
  });
  test('a real script assembly history meter includes the file weight', async () => {
    const input = { history, scriptName: 'Test', scriptKind: 'prompt' as const, scopeType: 'global', ownerNames: [], code: '', codeTrusted: false };
    const before = await assembleScriptAgentPrompt(input);
    const after = await assembleScriptAgentPrompt({ ...input, history: [{ role: 'user', content: 'Read this', attachments: [file] }] });
    expect(after.tokenAccounting.history - before.tokenAccounting.history).toBe(30000);
    expect(after.tokenAccounting.total - before.tokenAccounting.total).toBe(30000);
  });
  for (const kind of ['experience', 'script', 'sidechat'] as const) {
    test(`${kind}: compaction puts file text inside its owning user entry`, async () => {
      const h = await fixture([file], kind);
      const prompt = await h.compact(h.loader);
      const payload = prompt.finalPayload as { messages: { role: string; content: string }[] };
      expect(payload.messages[1]?.content).toBe(`USER: Read this\n\n[Attached file: notes.md]\n${fullText}\n\nASSISTANT: Understood`);
      expect(h.loader).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(prompt)).not.toContain('attachments');
    });
  }
  test('a summary replaces full file text and does not load the asset', async () => {
    const h = await fixture([{ ...file, description: 'Short summary', summaryTokenCount: 20 }]);
    const text = JSON.stringify(await h.compact(h.loader));
    expect(text).toContain('[Attached file: notes.md]\\nShort summary');
    expect(text).not.toContain(fullText);
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('an image renders name and description without loading pixels', async () => {
    const h = await fixture([image]);
    expect(JSON.stringify(await h.compact(h.loader))).toContain('[Attached image: tower.png]\\nA tall tower');
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('excluded files and untranscribed old voice notes never enter the digest', async () => {
    const h = await fixture([{ ...file, includeInPrompt: false }, { id: 'voice', assetId: 'voice', name: 'voice.webm', type: 'audio', mimeType: 'audio/webm', sizeBytes: 4 }]);
    const prompt = JSON.stringify(await h.compact(h.loader));
    expect(prompt).not.toContain('notes.md');
    expect(prompt).not.toContain('voice.webm');
    expect(h.loader).not.toHaveBeenCalled();
  });
  test('without a loader files are unavailable but images and summaries still render', async () => {
    const h = await fixture([file, image, { ...file, id: 'summary', name: 'summary.md', description: 'Short summary' }]);
    const text = JSON.stringify(await h.compact());
    expect(text).toContain('[Attached file: notes.md — file is no longer available]');
    expect(text).toContain('[Attached image: tower.png]\\nA tall tower');
    expect(text).toContain('[Attached file: summary.md]\\nShort summary');
  });
  test('zero-attachment compaction prompt is byte-identical with and without a loader', async () => {
    const without = await fixture([]);
    const withLoader = await fixture([]);
    expect(JSON.stringify(await withLoader.compact(withLoader.loader))).toBe(JSON.stringify(await without.compact()));
    expect(withLoader.loader).not.toHaveBeenCalled();
  });
});
