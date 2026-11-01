import { expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createDb } from '../src/db-connection.js';
import { characters, chatGenerationJobs, chats } from '../src/db-schema.js';
import { ChatStore } from '../src/stores/chat-store.js';
import { MessageStore } from '../src/stores/message-store.js';
import { ChatGenerationJobStore } from '../src/stores/chat-generation-job-store.js';

const now = '2026-10-30T00:00:00.000Z';
async function setup(realMigrations = false, path = ':memory:') {
  const db = await createDb(path, undefined, { realMigrations });
  await db.insert(characters).values({ id: 'queue-character', name: 'Queue', createdAt: now, updatedAt: now }).run();
  const chatStore = new ChatStore(db);
  const messageStore = new MessageStore(db);
  const chat = await chatStore.createChat({ characterId: 'queue-character', title: 'Queue', promptPresetId: null });
  const message = await messageStore.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: 'assistant', authorType: 'character', content: 'Original reply' });
  let sequence = 100;
  const options = { clock: { now: () => now }, idGenerator: { next: () => `job-${sequence--}` } };
  const store = new ChatGenerationJobStore(db, options);
  const input = { chatId: chat.id, messageId: message.id, model: 'provider/model', promptPresetId: null };
  return { db, store, chatStore, messageStore, chat, message, input };
}

test('enqueue preserves keys and millisecond timestamps; equal timestamps retain insertion order, not ID order', async () => {
  const { db, store, input, chat } = await setup();
  const first = await store.enqueue(input);
  const second = await store.enqueue({ ...input, model: 'second/model', promptPresetId: 'frozen-preset' });
  const third = await store.enqueue(input);
  expect(first).toEqual({ ...input, id: 'job-100', status: 'pending', enqueuedAt: Date.parse(now) });
  expect(second).not.toHaveProperty('variantIndex');
  expect(second).not.toHaveProperty('error');
  expect((await store.listByChat(chat.id)).map((job) => job.id)).toEqual([first.id, second.id, third.id]);
  expect((await new ChatGenerationJobStore(db).listByChat(chat.id)).map((job) => job.id)).toEqual([first.id, second.id, third.id]);
  expect((await store.get(chat.id, second.id))?.promptPresetId).toBe('frozen-preset');
});

test('next pending skips every non-pending status and never crosses chat ownership', async () => {
  const { store, input, chat, chatStore, messageStore } = await setup();
  for (const status of ['running', 'done', 'failed', 'cancelled'] as const) {
    const job = await store.enqueue(input);
    await store.setStatus(chat.id, job.id, { status });
  }
  const waiting = await store.enqueue(input);
  const other = await chatStore.createChat({ characterId: 'queue-character', title: 'Other', promptPresetId: null });
  const otherMessage = await messageStore.addMessage({ chatId: other.id, branchId: other.activeBranchId, role: 'assistant', authorType: 'character', content: 'Other reply' });
  const otherJob = await store.enqueue({ ...input, chatId: other.id, messageId: otherMessage.id });
  expect((await store.nextPending(chat.id))?.id).toBe(waiting.id);
  expect((await store.nextPending(other.id))?.id).toBe(otherJob.id);
  expect(await store.get(other.id, waiting.id)).toBeNull();
  expect(await store.nextPending('missing')).toBeNull();
  await store.cancelPending(chat.id, waiting.id);
  expect(await store.nextPending(chat.id)).toBeNull();
});

test('status/result updates preserve variant zero and errors and can atomically guard a claim', async () => {
  const { store, input, chat } = await setup();
  const job = await store.enqueue(input);
  expect((await store.setStatus(chat.id, job.id, { status: 'running' }, 'pending'))?.status).toBe('running');
  expect(await store.setStatus(chat.id, job.id, { status: 'running' }, 'pending')).toBeNull();
  expect((await store.setStatus(chat.id, job.id, { status: 'done', variantIndex: 0 }, 'running'))?.variantIndex).toBe(0);
  const failed = await store.enqueue(input);
  expect(await store.setStatus(chat.id, failed.id, { status: 'failed', error: 'Provider failed' })).toMatchObject({ status: 'failed', error: 'Provider failed' });
  expect(await store.setStatus('wrong-chat', failed.id, { status: 'done' })).toBeNull();
  expect((await store.get(chat.id, failed.id))?.status).toBe('failed');
  expect(await store.setStatus(chat.id, 'missing', { status: 'done' })).toBeNull();
});

test('cancel pending is conditional and idempotent, leaving running and settled jobs untouched', async () => {
  const { store, input, chat } = await setup();
  const pending = await store.enqueue(input);
  const running = await store.enqueue(input);
  const done = await store.enqueue(input);
  await store.setStatus(chat.id, running.id, { status: 'running' });
  await store.setStatus(chat.id, done.id, { status: 'done', variantIndex: 3 });
  expect((await store.cancelPending(chat.id, pending.id))?.status).toBe('cancelled');
  expect(await store.cancelPending(chat.id, pending.id)).toBeNull();
  expect(await store.cancelPending(chat.id, running.id)).toBeNull();
  expect(await store.cancelPending(chat.id, done.id)).toBeNull();
  expect(await store.cancelPending('other-chat', pending.id)).toBeNull();
  expect((await store.listByChat(chat.id)).map((job) => job.status)).toEqual(['cancelled', 'running', 'done']);
});

test('clear removes only this chat pending work and retains all running/terminal evidence', async () => {
  const { store, input, chat, chatStore, messageStore } = await setup();
  await store.enqueue(input);
  for (const status of ['running', 'done', 'failed', 'cancelled'] as const) {
    const job = await store.enqueue(input);
    await store.setStatus(chat.id, job.id, { status });
  }
  expect(await store.clearPending('other-chat')).toBe(0);
  const other = await chatStore.createChat({ characterId: 'queue-character', title: 'Other', promptPresetId: null });
  const target = await messageStore.addMessage({ chatId: other.id, branchId: other.activeBranchId, role: 'assistant', authorType: 'character', content: 'Other' });
  const retained = await store.enqueue({ ...input, chatId: other.id, messageId: target.id });
  expect(await store.clearPending(chat.id)).toBe(1);
  expect(await store.clearPending(chat.id)).toBe(0);
  expect((await store.listByChat(chat.id)).map((job) => job.status)).toEqual(['running', 'done', 'failed', 'cancelled']);
  expect((await store.listByChat(other.id)).map((job) => job.id)).toEqual([retained.id]);
});

test('enqueue rejects missing, non-assistant and cross-chat targets', async () => {
  const { store, input, messageStore, chat, chatStore } = await setup();
  await expect(store.enqueue({ ...input, messageId: 'missing' })).rejects.toThrow('existing assistant');
  await expect(store.enqueue({ ...input, chatId: 'missing-chat' })).rejects.toThrow('existing assistant');
  const other = await chatStore.createChat({ characterId: 'queue-character', title: 'Other', promptPresetId: null });
  await expect(store.enqueue({ ...input, chatId: other.id })).rejects.toThrow('existing assistant');
  const user = await messageStore.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: 'user', authorType: 'persona', content: 'Request' });
  await expect(store.enqueue({ ...input, messageId: user.id })).rejects.toThrow('existing assistant');
  expect(await store.listByChat(chat.id)).toEqual([]);
});

test('hard foreign keys and checks reject invalid raw rows without relying on a route validator', async () => {
  const { db, store, input, chat } = await setup();
  const job = await store.enqueue(input);
  expect(() => db.insert(chatGenerationJobs).values({ ...input, id: 'missing-message', messageId: 'missing', enqueuedAt: 0 }).run()).toThrow();
  expect(() => db.insert(chatGenerationJobs).values({ ...input, id: 'missing-chat', chatId: 'missing', enqueuedAt: 0 }).run()).toThrow();
  expect(() => db.run(sql`UPDATE chat_generation_jobs SET status = 'unknown' WHERE id = ${job.id}`)).toThrow();
  expect(() => db.run(sql`UPDATE chat_generation_jobs SET variant_index = -1 WHERE id = ${job.id}`)).toThrow();
  expect(() => db.run(sql`UPDATE chat_generation_jobs SET enqueued_at = -1 WHERE id = ${job.id}`)).toThrow();
  expect((await store.get(chat.id, job.id))?.status).toBe('pending');
});

test('deleting a target message cascades only its jobs', async () => {
  const { store, input, messageStore, chat } = await setup();
  await store.enqueue(input);
  const second = await messageStore.addMessage({ chatId: chat.id, branchId: chat.activeBranchId, role: 'assistant', authorType: 'character', content: 'Second reply' });
  const retained = await store.enqueue({ ...input, messageId: second.id });
  await messageStore.deleteMessage(input.messageId);
  expect((await store.listByChat(chat.id)).map((job) => job.id)).toEqual([retained.id]);
});

test('deleting a chat cascades its jobs without affecting another chat', async () => {
  const { db, store, input, chat, chatStore, messageStore } = await setup();
  await store.enqueue(input);
  const other = await chatStore.createChat({ characterId: 'queue-character', title: 'Other', promptPresetId: null });
  const target = await messageStore.addMessage({ chatId: other.id, branchId: other.activeBranchId, role: 'assistant', authorType: 'character', content: 'Other' });
  const retained = await store.enqueue({ ...input, chatId: other.id, messageId: target.id });
  await db.delete(chats).where(eq(chats.id, chat.id)).run();
  expect(await store.listByChat(chat.id)).toEqual([]);
  expect((await store.listByChat(other.id)).map((job) => job.id)).toEqual([retained.id]);
});

test('variant changes and a branch fork leave jobs pinned to the original stable message row', async () => {
  const { store, input, messageStore, chatStore, chat } = await setup();
  const job = await store.enqueue(input);
  const variant = await messageStore.addVariant(input.messageId, 'New swipe');
  await messageStore.selectVariant(input.messageId, 0);
  await messageStore.deleteVariant(input.messageId, variant.variantIndex);
  const branch = await chatStore.forkBranch(chat.id, input.messageId);
  const copied = await messageStore.getMessages(branch.id);
  expect(copied[0]?.id).not.toBe(input.messageId);
  expect((await store.get(chat.id, job.id))?.messageId).toBe(input.messageId);
  expect(await store.listByChat(chat.id)).toHaveLength(1);
  expect(await messageStore.getMessageById(input.messageId)).not.toBeNull();
});

test('the real additive migration creates an empty queue and preserves existing chats/messages/variants', async () => {
  const { db, store, chat, message, messageStore } = await setup(true);
  const variants = await messageStore.getVariants(message.id);
  await db.run(sql`DROP TABLE chat_generation_jobs`);
  const migration = await Bun.file(join(import.meta.dir, '../drizzle/0132_naive_scarecrow.sql')).text();
  for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await db.run(sql.raw(statement));
  expect(await store.listByChat(chat.id)).toEqual([]);
  expect(await messageStore.getMessageById(message.id)).toEqual(message);
  expect(await messageStore.getVariants(message.id)).toEqual(variants);
  expect((await db.select().from(chats).where(eq(chats.id, chat.id)).get())?.id).toBe(chat.id);
});

test('jobs and results survive closing and reopening the SQLite file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vt-generation-jobs-'));
  let opened: Awaited<ReturnType<typeof createDb>> | undefined;
  try {
    const path = join(dir, 'queue.sqlite');
    const { db, store, input, chat } = await setup(false, path);
    opened = db;
    const pending = await store.enqueue(input);
    const done = await store.enqueue(input);
    await store.setStatus(chat.id, done.id, { status: 'done', variantIndex: 0 });
    const before = await store.listByChat(chat.id);
    db.$client.close(); opened = undefined;
    opened = await createDb(path);
    const recovered = new ChatGenerationJobStore(opened);
    expect(await recovered.listByChat(chat.id)).toEqual(before);
    expect((await recovered.nextPending(chat.id))?.id).toBe(pending.id);
  } finally {
    opened?.$client.close();
    // The suite preload / official spot runner sweeps this vt-* directory.
    // Windows releases WAL/SHM handles after close returns; do not race rm or
    // duplicate the shared closeAllDbs cleanup's measured grace/retry policy.
  }
});
