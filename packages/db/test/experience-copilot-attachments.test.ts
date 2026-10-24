import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Attachment } from '@vibe-tavern/domain';
import { createDb } from '../src/db-connection.js';
import { experienceCopilotMessages, characters, chats, chatBranches } from '../src/db-schema.js';
import { ExperienceCopilotStore } from '../src/stores/experience-copilot-store.js';

// T1: real template-backed DB and store, no doubles/global state/waits/paths.
// Fresh DB per test; deterministic local clock/ids avoid ordering assumptions.
const file: Attachment = { id: 'file', assetId: 'asset-file', type: 'file', name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 12, tokenCount: 1200 };
const image: Attachment = { id: 'image', assetId: 'asset-image', type: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 4, includeInPrompt: false };
async function setup() {
  const db = await createDb(':memory:');
  let step = 0;
  let id = 0;
  const store = new ExperienceCopilotStore(db, {
    clock: { now: () => new Date(Date.UTC(2026, 9, 24) + step++ * 1000).toISOString() },
    idGenerator: { next: (prefix) => `${prefix}_${++id}` },
  });
  const thread = await store.startNewSession('script');
  const raw = (messageId: string) => db.select().from(experienceCopilotMessages).where(eq(experienceCopilotMessages.id, messageId)).get()!;
  return { db, store, thread, raw };
}

describe('agent message attachments (CA-4a2)', () => {
  test('append round-trips the complete set, including excluded attachments, through listMessages and timeline', async () => {
    const { store, thread, raw } = await setup();
    const attachments = [{ ...file, description: 'Summary', summaryTokenCount: 20 }, image];
    const row = await store.appendMessage(thread.id, { role: 'user', attachments });
    expect(row.attachments).toEqual(attachments);
    expect((await store.listMessages(thread.id))[0]?.attachments).toEqual(attachments);
    expect((await store.listTimeline(thread.id))[0]).toMatchObject({ attachments });
    expect(raw(row.id).attachmentsJson).toBe(JSON.stringify(attachments));
  });

  test('absent and empty attachments store NULL and omit the key on append and read', async () => {
    const { store, thread, raw } = await setup();
    for (const input of [{ role: 'user' }, { role: 'user', attachments: [] }]) {
      const row = await store.appendMessage(thread.id, input);
      expect(Object.hasOwn(row, 'attachments')).toBe(false);
      expect(raw(row.id).attachmentsJson).toBeNull();
    }
    for (const row of await store.listMessages(thread.id)) expect(Object.hasOwn(row, 'attachments')).toBe(false);
  });

  test('find hits by attachment id and returns null for a missing member, row or empty set', async () => {
    const { store, thread } = await setup();
    const row = await store.appendMessage(thread.id, { role: 'user', attachments: [file, image] });
    const empty = await store.appendMessage(thread.id, { role: 'assistant' });
    expect(await store.findMessageAttachment(row.id, file.id)).toEqual(file);
    expect(await store.findMessageAttachment(row.id, 'missing')).toBeNull();
    expect(await store.findMessageAttachment('missing', file.id)).toBeNull();
    expect(await store.findMessageAttachment(empty.id, file.id)).toBeNull();
  });

  test('update applies description, summary count and visibility without losing siblings', async () => {
    const { store, thread } = await setup();
    const row = await store.appendMessage(thread.id, { role: 'user', attachments: [file, image] });
    const updated = { ...file, description: 'Summary', summaryTokenCount: 20, includeInPrompt: false };
    expect(await store.updateMessageAttachment(row.id, file.id, { description: 'Summary', summaryTokenCount: 20, includeInPrompt: false })).toEqual(updated);
    expect((await store.listMessages(thread.id))[0]?.attachments).toEqual([updated, image]);
    expect(await store.updateMessageAttachment(row.id, file.id, { description: null, summaryTokenCount: null })).toEqual({ ...file, description: null, includeInPrompt: false });
    expect(Object.hasOwn((await store.findMessageAttachment(row.id, file.id))!, 'summaryTokenCount')).toBe(false);
  });

  test('back-to-back edits re-read the set and preserve a sibling update', async () => {
    const { store, thread } = await setup();
    const row = await store.appendMessage(thread.id, { role: 'user', attachments: [file, image] });
    await Promise.all([
      store.updateMessageAttachment(row.id, image.id, { description: 'Tower' }),
      store.updateMessageAttachment(row.id, file.id, { description: 'Summary' }),
    ]);
    expect((await store.listMessages(thread.id))[0]?.attachments).toEqual([{ ...file, description: 'Summary' }, { ...image, description: 'Tower' }]);
  });

  test('update missing message or attachment returns null without a write', async () => {
    const { store, thread, raw } = await setup();
    const row = await store.appendMessage(thread.id, { role: 'user', attachments: [file] });
    const before = raw(row.id);
    expect(await store.updateMessageAttachment('missing', file.id, { description: 'No' })).toBeNull();
    expect(await store.updateMessageAttachment(row.id, 'missing', { description: 'No' })).toBeNull();
    expect(raw(row.id)).toEqual(before);
  });

  test('remove keeps siblings, clears the last column to NULL and is idempotent', async () => {
    const { store, thread, raw } = await setup();
    const row = await store.appendMessage(thread.id, { role: 'user', attachments: [file, image] });
    expect(await store.removeMessageAttachment(row.id, file.id)).toEqual(file);
    expect((await store.listMessages(thread.id))[0]?.attachments).toEqual([image]);
    expect(await store.removeMessageAttachment(row.id, image.id)).toEqual(image);
    expect(raw(row.id).attachmentsJson).toBeNull();
    expect(Object.hasOwn((await store.listMessages(thread.id))[0]!, 'attachments')).toBe(false);
    expect(await store.removeMessageAttachment(row.id, image.id)).toBeNull();
    expect(await store.removeMessageAttachment('missing', file.id)).toBeNull();
  });

  test('fork copies attachment JSON verbatim and shares asset ids without sharing edits', async () => {
    const { db, store, raw } = await setup();
    const now = '2026-10-24T00:00:00.000Z';
    db.insert(characters).values({ id: 'character', name: 'Test', createdAt: now, updatedAt: now }).run();
    db.insert(chats).values({ id: 'chat', characterId: 'character', activeBranchId: 'main', title: 'Test', createdAt: now, updatedAt: now }).run();
    for (const id of ['main', 'fork']) db.insert(chatBranches).values({ id, chatId: 'chat', label: id, createdAt: now }).run();
    const source = await store.startNewChatSession('chat', 'main', 'sidechat-ooc');
    const row = await store.appendMessage(source.id, { role: 'user', attachments: [file, image] });
    const copy = await store.forkChatThreadToBranch(source.id, 'fork', {
      eventPayload: (_kind, payloadJson) => ({ payloadJson }), frontierJson: (value) => value,
      trailingEvent: { kind: 'branch_forked', payload: { at: 0 } },
    });
    const copied = (await store.listMessages(copy!.id))[0]!;
    expect(copied.id).not.toBe(row.id);
    expect(raw(copied.id).attachmentsJson).toBe(raw(row.id).attachmentsJson);
    expect(copied.attachments).toEqual([file, image]);
    await store.removeMessageAttachment(copied.id, file.id);
    expect((await store.listMessages(source.id))[0]?.attachments).toEqual([file, image]);
  });
});
