import { describe, expect, test } from 'bun:test';
import { createStoreContainer } from '@vibe-tavern/db';
import type { Attachment } from '@vibe-tavern/domain';
import { toMessageWire } from '../src/api/adapters/experience-copilot-wire-mappers.js';

// Real store -> wire seam, template-backed DB; no globals, doubles or waits.
describe('agent attachment wire projection (CA-4a2)', () => {
  test('legacy messages keep the exact wire shape; empty sets do not add a key', async () => {
    const stores = await createStoreContainer(':memory:');
    const thread = await stores.experienceCopilot.startNewSession('script');
    for (const attachments of [undefined, []]) {
      const row = await stores.experienceCopilot.appendMessage(thread.id, { role: 'user', content: 'Hello', attachments });
      expect(JSON.stringify(toMessageWire(row))).toBe(JSON.stringify({
        id: row.id, threadId: row.threadId, role: 'user', content: 'Hello',
        toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null, createdAt: row.createdAt,
      }));
    }
  });

  test('the full stored attachment shape survives the real store and wire mapper', async () => {
    const stores = await createStoreContainer(':memory:');
    const thread = await stores.experienceCopilot.startNewSession('script');
    const attachment: Attachment = { id: 'file', assetId: 'asset', type: 'file', name: 'a.md', mimeType: 'text/markdown', sizeBytes: 12, tokenCount: 1200, description: 'Summary', summaryTokenCount: 20, includeInPrompt: false };
    await stores.experienceCopilot.appendMessage(thread.id, { role: 'user', attachments: [attachment] });
    expect(toMessageWire((await stores.experienceCopilot.listMessages(thread.id))[0]!).attachments).toEqual([attachment]);
  });
});
