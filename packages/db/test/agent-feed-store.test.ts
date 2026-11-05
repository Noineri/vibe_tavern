import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLQueryBindings } from 'bun:sqlite';
import { createDb } from '../src/db-connection.js';
import * as schema from '../src/db-schema.js';
import { ExperienceCopilotStore } from '../src/stores/experience-copilot-store.js';
import { buildAgentFeedSeekQuery, compareAgentFeedPositions, type AgentFeedPosition } from '../src/stores/agent-feed-order.js';
import * as rowMappers from '../src/stores/experience-copilot-row-mappers.js';
import type { AgentFeedPageResult } from '../src/stores/agent-feed-store.js';

// AFP-9 L1: (1) relative imports/derived paths only; (2) no global/env/registry
// mutations; local transparent spies restored in finally; (3) resolved-state
// assertions, no sleeps; (4) explicit ordering, no OS/discovery assumptions;
// (5) real DB/store, no module mocks; (6) stable snapshot assertions;
// (7) fresh createDb fixtures use the suite's template, no migration subjects.
const NOW = '2026-11-04T12:00:00.000Z';
async function setup() {
  const db = await createDb(':memory:');
  db.insert(schema.experienceCopilotThreads).values([
    { id: 't1', createdAt: NOW, updatedAt: NOW }, { id: 't2', createdAt: NOW, updatedAt: NOW },
  ]).run();
  const store = new ExperienceCopilotStore(db);
  return { db, store };
}

function ready(result: AgentFeedPageResult) {
  if (result.status !== 'ready') throw new Error(`Expected ready page, got ${result.status}`);
  return result;
}
function cursorOf(page: ReturnType<typeof ready>, index = 0) {
  return { threadId: page.thread.id, epoch: page.historyEpoch, position: page.records[index]!.position };
}
function seed(db: Awaited<ReturnType<typeof createDb>>, count: number, events = false, nullSeq = false) {
  db.transaction((tx) => {
    for (let i = 0; i < count; i++) {
      const base = { id: `r${i.toString().padStart(5, '0')}`, threadId: 't1', seq: nullSeq ? null : i, createdAt: NOW };
      if (events) tx.insert(schema.agentThreadContextEvents).values({ ...base, kind: 'branch_forked', payloadJson: '{"at":1}' }).run();
      else tx.insert(schema.experienceCopilotMessages).values({ ...base, role: i % 4 === 0 ? 'user' : 'assistant', content: `body-${i}` }).run();
    }
  });
}

describe('agent feed existing read boundary', () => {
  test('full history keeps NULL-prefix order and stable messages-before-events on an exact cross-table tie', async () => {
    const { db, store } = await setup();
    db.insert(schema.experienceCopilotMessages).values([
      { id: 'same', threadId: 't1', role: 'user', seq: 1, createdAt: NOW },
      { id: 'legacy', threadId: 't1', role: 'assistant', seq: null, createdAt: '2099' },
    ]).run();
    db.insert(schema.agentThreadContextEvents).values({
      id: 'same', threadId: 't1', kind: 'branch_forked', seq: 1, createdAt: NOW, payloadJson: '{"at":0}',
    }).run();
    expect((await store.listTimeline('t1')).map((row) => `${row.rowType}:${row.id}`)).toEqual([
      'message:legacy', 'message:same', 'event:same',
    ]);
    expect((await store.listMessages('t1')).map((row) => row.id)).toEqual(['same', 'legacy']);
    expect(await store.listTimeline('t2')).toEqual([]);
    expect(compareAgentFeedPositions({ record: 'message', id: 'same', seq: 1, createdAt: NOW },
      { record: 'event', id: 'same', seq: 1, createdAt: NOW })).toBeLessThan(0);
  });
});

describe('AFP-9 paged DB read seam', () => {
  test('AFP-15 digest count facts include unloaded flow rows and equal-anchor zero increments', async () => {
    const { db, store } = await setup();
    db.insert(schema.experienceCopilotMessages).values([
      { id: 'u', threadId: 't1', role: 'user', seq: null, createdAt: NOW },
      { id: 'a', threadId: 't1', role: 'assistant', seq: 1, createdAt: NOW },
      { id: 'd1', threadId: 't1', role: 'digest', toolCallId: 'a', seq: 2, createdAt: NOW },
      { id: 'd2', threadId: 't1', role: 'digest', toolCallId: 'a', seq: 3, createdAt: NOW },
    ]).run();
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 2 }));
    expect(page.boundary.digests.loadedCounts).toEqual([{ id: 'd1', coveredCount: 1 }, { id: 'd2', coveredCount: 0 }]);
    expect(page.boundary.digests.last?.anchorPosition?.id).toBe('a');
  });
  test('newest/before/after pages preserve the full timeline order, including exact cross-table ties', async () => {
    const { db, store } = await setup();
    for (let i = 0; i < 12; i++) {
      const common = { id: `row-${i.toString().padStart(2, '0')}`, threadId: 't1', seq: i < 2 ? null : i, createdAt: NOW };
      if (i % 2) db.insert(schema.agentThreadContextEvents).values({ ...common, kind: 'branch_forked', payloadJson: '{"at":0}' }).run();
      else db.insert(schema.experienceCopilotMessages).values({ ...common, role: 'user', content: `body-${i}` }).run();
    }
    const page = await store.readFeedPage('t1', { mode: 'newest', limit: 4 });
    expect(page.status).toBe('ready');
    if (page.status !== 'ready') throw new Error('Expected page');
    expect(page.records.map((r) => r.position.id)).toEqual(['row-08', 'row-09', 'row-10', 'row-11']);
    expect(page.hasOlder).toBe(true);
    expect(page.hasNewer).toBe(false);
    const cursor = { threadId: 't1', epoch: page.historyEpoch, position: page.records[0]!.position };
    const older = await store.readFeedPage('t1', { mode: 'before', cursor, limit: 4 });
    if (older.status !== 'ready') throw new Error('Expected older page');
    expect(older.records.map((r) => r.position.id)).toEqual(['row-04', 'row-05', 'row-06', 'row-07']);
    const after = await store.readFeedPage('t1', { mode: 'after', cursor: { ...cursor, position: older.records.at(-1)!.position }, limit: 4 });
    if (after.status !== 'ready') throw new Error('Expected newer page');
    expect(after.records).toEqual(page.records);
    expect(await store.readFeedPage('missing', { mode: 'newest', limit: 4 })).toEqual({ status: 'missing-thread' });
  });

  test('event detail slices load frozen items rather than the complete payload', async () => {
    const { db, store } = await setup();
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: `rp-${i}`, text: `captured-${i}` }));
    db.insert(schema.agentThreadContextEvents).values({ id: 'snapshot', threadId: 't1', seq: 0, kind: 'rp_sync',
      payloadJson: JSON.stringify({ fromPosition: 0, toPosition: 19, messages }), createdAt: NOW }).run();
    const first = await store.readEventDetail('t1', 'snapshot', { limit: 3 });
    if (first.status !== 'ready') throw new Error('Expected detail');
    expect(first.payload).toEqual({ fromPosition: 0, toPosition: 19, messages: messages.slice(0, 3) });
    expect(first.hasMore).toBe(true);
    const next = await store.readEventDetail('t1', 'snapshot', { limit: 3,
      cursor: { threadId: 't1', eventId: 'snapshot', epoch: first.historyEpoch, offset: 3 } });
    if (next.status !== 'ready') throw new Error('Expected detail continuation');
    expect(next.payload).toEqual({ fromPosition: 0, toPosition: 19, messages: messages.slice(3, 6) });
  });

  test.each([true, false])('complete forward/backward traversal is lossless with NULL-seq=%s', async (nullSeq) => {
    const { db, store } = await setup();
    seed(db, 23, false, nullSeq);
    const all = (await store.listTimeline('t1')).map((r) => r.id);
    let page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 5 }));
    const reversePages = [page];
    while (page.hasOlder) {
      page = ready(await store.readFeedPage('t1', { mode: 'before', limit: 5, cursor: cursorOf(page) }));
      reversePages.unshift(page);
      expect(reversePages.length).toBeLessThan(10);
    }
    expect(reversePages.flatMap((p) => p.records.map((r) => r.position.id))).toEqual(all);
    const seen = page.records.map((r) => r.position.id);
    while (page.hasNewer) {
      page = ready(await store.readFeedPage('t1', { mode: 'after', limit: 5, cursor: cursorOf(page, page.records.length - 1) }));
      seen.push(...page.records.map((r) => r.position.id));
      expect(seen.length).toBeLessThanOrEqual(all.length);
    }
    expect(seen).toEqual(all);
  });

  test('same-time/seq ties split at a one-item page, with the old stable cross-table tie preserved', async () => {
    const { db, store } = await setup();
    for (const id of ['z', 'a', 'same']) {
      db.insert(schema.experienceCopilotMessages).values({ id, threadId: 't1', role: 'assistant', seq: 1, createdAt: NOW }).run();
      db.insert(schema.agentThreadContextEvents).values({ id, threadId: 't1', kind: 'branch_forked', payloadJson: '{"at":0}', seq: 1, createdAt: NOW }).run();
    }
    const wanted = (await store.listTimeline('t1')).map((r) => `${r.rowType}:${r.id}`);
    let page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 1 }));
    const seen = page.records.map((r) => `${r.record}:${r.position.id}`);
    while (page.hasOlder) {
      page = ready(await store.readFeedPage('t1', { mode: 'before', limit: 1, cursor: cursorOf(page) }));
      seen.unshift(...page.records.map((r) => `${r.record}:${r.position.id}`));
      expect(seen.length).toBeLessThanOrEqual(6);
    }
    expect(seen).toEqual(wanted);
  });

  test('around reads one bounded neighborhood, fills at either edge and refuses foreign/missing targets', async () => {
    const { db, store } = await setup();
    seed(db, 1000);
    const middle = ready(await store.readFeedPage('t1', { mode: 'around', limit: 5, messageId: 'r00500' }));
    expect(middle.records.map((r) => r.position.id)).toEqual(['r00498', 'r00499', 'r00500', 'r00501', 'r00502']);
    expect(middle.hasOlder && middle.hasNewer).toBe(true);
    expect(ready(await store.readFeedPage('t1', { mode: 'around', limit: 5, messageId: 'r00000' })).records.map((r) => r.position.id))
      .toEqual(['r00000', 'r00001', 'r00002', 'r00003', 'r00004']);
    expect(ready(await store.readFeedPage('t1', { mode: 'around', limit: 5, messageId: 'r00999' })).records.map((r) => r.position.id))
      .toEqual(['r00995', 'r00996', 'r00997', 'r00998', 'r00999']);
    expect(await store.readFeedPage('t2', { mode: 'around', limit: 5, messageId: 'r00500' })).toEqual({ status: 'missing-message' });
    expect(await store.readFeedPage('t1', { mode: 'around', limit: 5, messageId: 'missing' })).toEqual({ status: 'missing-message' });
  });

  test('empty thread and true ends retain honest coverage without silently restarting newest', async () => {
    const { db, store } = await setup();
    const empty = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 5 }));
    expect(empty).toMatchObject({ records: [], head: null, hasOlder: false, hasNewer: false, historyEpoch: 0 });
    seed(db, 1);
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 5 }));
    const cursor = cursorOf(page);
    expect(ready(await store.readFeedPage('t1', { mode: 'before', cursor, limit: 5 }))).toMatchObject({ records: [], hasOlder: false, hasNewer: true });
    expect(ready(await store.readFeedPage('t1', { mode: 'after', cursor, limit: 5 }))).toMatchObject({ records: [], hasOlder: true, hasNewer: false });
  });

  test('wrong-thread cursors are refused; changed epochs are explicit; a deleted coordinate is never a newest restart', async () => {
    const { db, store } = await setup();
    seed(db, 10);
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 3 }));
    const cursor = cursorOf(page);
    expect(await store.readFeedPage('t2', { mode: 'before', cursor, limit: 3 })).toEqual({ status: 'invalid-cursor' });
    db.$client.exec("DELETE FROM experience_copilot_messages WHERE id = 'r00007'");
    expect(await store.readFeedPage('t1', { mode: 'before', cursor, limit: 3 })).toEqual({ status: 'stale-window', historyEpoch: 1 });
    const resumed = ready(await store.readFeedPage('t1', { mode: 'before', cursor: { ...cursor, epoch: 1 }, limit: 3 }));
    expect(resumed.records.map((r) => r.position.id)).toEqual(['r00004', 'r00005', 'r00006']);
  });

  test('pure suffix append advances head without invalidating a cursor', async () => {
    const { db, store } = await setup();
    seed(db, 10);
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 4 }));
    const cursor = cursorOf(page, 3);
    db.insert(schema.agentThreadContextEvents).values({ id: 'tail', threadId: 't1', seq: 10, createdAt: NOW, kind: 'branch_forked', payloadJson: '{"at":1}' }).run();
    const after = ready(await store.readFeedPage('t1', { mode: 'after', cursor, limit: 4 }));
    expect(after.historyEpoch).toBe(page.historyEpoch);
    expect(after.head?.id).toBe('tail');
    expect(after.records.map((r) => r.position.id)).toEqual(['tail']);
  });

  test('event-only pages anchor outside the page and keep genuinely trailing separators at null', async () => {
    const { db, store } = await setup();
    seed(db, 8, true);
    db.insert(schema.experienceCopilotMessages).values({ id: 'anchor', threadId: 't1', seq: 8, role: 'user', createdAt: NOW }).run();
    db.insert(schema.agentThreadContextEvents).values({ id: 'trailing', threadId: 't1', seq: 9, kind: 'branch_forked', payloadJson: '{"at":1}', createdAt: NOW }).run();
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 2 }));
    const older = ready(await store.readFeedPage('t1', { mode: 'before', cursor: cursorOf(page), limit: 3 }));
    expect(older.records.map((r) => r.record)).toEqual(['event', 'event', 'event']);
    for (const record of older.records) {
      if (record.record !== 'event') throw new Error('Expected event');
      expect(record.beforeMessageId).toBe('anchor');
    }
    expect(page.records.at(-1)).toMatchObject({ record: 'event', beforeMessageId: null });
  });

  test('summaries omit frozen texts, tolerate corrupt JSON and project only scalar facts of all five kinds', async () => {
    const { db, store } = await setup();
    const payloads = [
      ['rp_sync', { fromPosition: 0, toPosition: 2, messages: [{ text: 'SECRET'.repeat(100000) }] }],
      ['variants_attached', { position: 1, variants: [{ text: 'SECRET VARIANT' }] }],
      ['selection_changed', { position: 2, messageId: 'rp', previous: { text: 'SECRET OLD' }, current: { text: 'SECRET NEW' } }],
      ['branch_forked', { at: 3 }], ['profile_changed', { from: { id: 'a', name: 'Old' }, to: { id: 'b', name: 'New' } }],
    ] as const;
    payloads.forEach(([kind, payload], i) => db.insert(schema.agentThreadContextEvents).values({
      id: `e${i}`, threadId: 't1', seq: i, kind, payloadJson: JSON.stringify(payload), createdAt: NOW,
    }).run());
    for (const [id, payloadJson] of [['broken', '{bad'], ['null', null], ['malformed-facts', '{"fromPosition":{"text":"SECRET"},"messages":"wrong"}']] as const) {
      db.insert(schema.agentThreadContextEvents).values({ id, threadId: 't1', kind: 'rp_sync', seq: 99, payloadJson, createdAt: NOW }).run();
    }
    const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 20 }));
    expect(JSON.stringify(page)).not.toContain('SECRET');
    const facts = page.records.flatMap((r) => r.record === 'event' ? [{ id: r.position.id, facts: r.facts }] : []);
    expect(facts.find((r) => r.id === 'e0')?.facts).toMatchObject({ payloadValid: true, messageCount: 1, fromPosition: 0 });
    expect(facts.find((r) => r.id === 'e1')?.facts.variantCount).toBe(1);
    expect(facts.find((r) => r.id === 'e4')?.facts).toMatchObject({ fromName: 'Old', toName: 'New' });
    expect(facts.find((r) => r.id === 'broken')?.facts.payloadValid).toBe(false);
    expect(facts.find((r) => r.id === 'malformed-facts')?.facts).toMatchObject({ fromPosition: null, messageCount: null });
  });

  test('10k rows hydrate only the requested window; neither legacy full-list method runs', async () => {
    const { db, store } = await setup();
    seed(db, 10000);
    const mapper = spyOn(rowMappers, 'mapMessage');
    const legacy = spyOn(store, 'listTimeline');
    const messages = spyOn(store, 'listMessages');
    try {
      const page = ready(await store.readFeedPage('t1', { mode: 'around', limit: 40, messageId: 'r05000' }));
      expect(page.records).toHaveLength(40);
      expect(mapper).toHaveBeenCalledTimes(40); // Probe demonstrably fires.
      expect(legacy).not.toHaveBeenCalled();
      expect(messages).not.toHaveBeenCalled();
      for (const record of ['message', 'event'] as const) for (const nullSeq of [true, false]) for (const direction of ['before', 'after'] as const) {
        const anchor: AgentFeedPosition = { record: 'message', seq: nullSeq ? null : 5000, createdAt: NOW, id: 'r05000' };
        const query = buildAgentFeedSeekQuery('t1', record, nullSeq, direction, 40, anchor)!;
        const plan = db.$client.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query.text}`).all(...query.params);
        expect(plan.some((r) => r.detail.includes('COVERING INDEX') && r.detail.includes('_feed_seek'))).toBe(true);
        expect(plan.some((r) => /SCAN |TEMP B-TREE/.test(r.detail))).toBe(false);
      }
    } finally { mapper.mockRestore(); legacy.mockRestore(); messages.mockRestore(); }
  });

  test.each([0, -1, 1.5, NaN, Infinity])('invalid internal limit %s is rejected rather than silently clamped', async (limit) => {
    const { store } = await setup();
    await expect(store.readFeedPage('t1', { mode: 'newest', limit })).rejects.toThrow(RangeError);
    await expect(store.readEventDetail('t1', 'event', { limit })).rejects.toThrow(RangeError);
  });

  test('split tool pairs, unloaded turn opener/first assistant and last user are snapshot facts', async () => {
    const { db, store } = await setup();
    db.insert(schema.experienceCopilotMessages).values([
      { id: 'opener', threadId: 't1', seq: 0, role: 'user', content: 'begin', createdAt: NOW },
      { id: 'call', threadId: 't1', seq: 1, role: 'assistant', toolCallsJson: JSON.stringify([
        { type: 'tool-call', toolCallId: 'tc', toolName: 'ask_user', input: { question: 'SECRET INPUT' } },
      ]), createdAt: NOW },
      { id: 'result', threadId: 't1', seq: 2, role: 'tool', toolCallId: 'tc', content: 'pending', createdAt: NOW },
      { id: 'answer', threadId: 't1', seq: 3, role: 'assistant', content: 'done', createdAt: NOW },
      { id: 'next', threadId: 't1', seq: 4, role: 'user', content: 'next', createdAt: NOW },
    ]).run();
    const page = ready(await store.readFeedPage('t1', { mode: 'around', limit: 2, messageId: 'result' }));
    expect(page.records.map((r) => r.position.id)).toEqual(['result', 'answer']);
    expect(page.boundary.turnOpener?.id).toBe('opener');
    expect(page.boundary.firstAssistant?.id).toBe('call');
    expect(page.boundary.lastUser?.id).toBe('next');
    expect(page.boundary.previousMessage?.position.id).toBe('call');
    expect(page.boundary.nextMessage?.position.id).toBe('next');
    expect(page.boundary.continuedToolCalls).toEqual([{
      toolCallId: 'tc', toolName: 'ask_user', callPosition: { record: 'message', id: 'call', seq: 1, createdAt: NOW },
    }]);
    expect(JSON.stringify(page.boundary)).not.toContain('SECRET INPUT');
  });

  test('digest facts distinguish an unloaded existing anchor from a dangling/foreign one', async () => {
    const { db, store } = await setup();
    seed(db, 30);
    db.insert(schema.experienceCopilotMessages).values({ id: 'digest', threadId: 't1', seq: 30, role: 'digest',
      content: 'summary', toolCallId: 'r00005', createdAt: NOW }).run();
    let page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 3 }));
    expect(page.boundary.digests).toMatchObject({ total: 1, older: 0, last: { anchorId: 'r00005', anchorPosition: { id: 'r00005' } } });
    expect(page.records.some((r) => r.position.id === 'r00005')).toBe(false);
    const around = ready(await store.readFeedPage('t1', { mode: 'around', limit: 3, messageId: 'r00005' }));
    expect(around.boundary.digests.last?.anchorPosition?.id).toBe('r00005');
    db.$client.exec("UPDATE experience_copilot_messages SET tool_call_id = 'missing' WHERE id = 'digest'");
    page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 3 }));
    expect(page.boundary.digests.last?.anchorPosition).toBeNull();
    db.insert(schema.experienceCopilotMessages).values({ id: 'missing', threadId: 't2', role: 'user', createdAt: NOW }).run();
    page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 3 }));
    expect(page.boundary.digests.last?.anchorPosition).toBeNull();
  });

  test('a concurrent WAL writer cannot mix the page, head, event facts and epoch snapshots', async () => {
    const work = await mkdtemp(join(tmpdir(), 'vt-feed-snapshot-'));
    const path = join(work, 'snapshot.db');
    const first = await createDb(path);
    first.insert(schema.experienceCopilotThreads).values({ id: 't1', createdAt: NOW, updatedAt: NOW }).run();
    first.insert(schema.agentThreadContextEvents).values({ id: 'event', threadId: 't1', seq: 0, kind: 'branch_forked',
      payloadJson: '{"at":1}', createdAt: NOW }).run();
    const second = await createDb(path);
    const originalQuery = first.$client.query.bind(first.$client);
    let fired = false;
    const probe = spyOn(first.$client, 'query').mockImplementation((query, ...params) => {
      if (!fired && query.includes('SELECT id, seq')) {
        fired = true; // The thread/epoch SELECT has already established a read snapshot.
        second.$client.exec("UPDATE agent_thread_context_events SET payload_json = '{\"at\":2}' WHERE id = 'event'");
        second.insert(schema.experienceCopilotMessages).values({ id: 'new', threadId: 't1', seq: 1, role: 'user', createdAt: NOW }).run();
      }
      return originalQuery(query, ...params);
    });
    try {
      const store = new ExperienceCopilotStore(first);
      const page = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 5 }));
      expect(fired).toBe(true); // R11: the concurrent write actually happened.
      expect(page.historyEpoch).toBe(0);
      expect(page.head?.id).toBe('event');
      expect(page.records).toHaveLength(1);
      expect(page.records[0]).toMatchObject({ record: 'event', facts: { at: 1 }, beforeMessageId: null });
      const next = ready(await store.readFeedPage('t1', { mode: 'newest', limit: 5 }));
      expect(next.historyEpoch).toBe(1);
      expect(next.head?.id).toBe('new');
      expect(next.records[0]).toMatchObject({ record: 'event', facts: { at: 2 }, beforeMessageId: 'new' });
    } finally { probe.mockRestore(); }
  });
});

describe('AFP-9 immutable detail DB reads', () => {
  test.each(['rp_sync', 'variants_attached'] as const)('%s pages preserve captured array order and final-page bounds', async (kind) => {
    const { db, store } = await setup();
    const items = Array.from({ length: 123 }, (_, i) => ({ text: `frozen-${i}`, marker: i }));
    const payload = kind === 'rp_sync' ? { fromPosition: 0, toPosition: 122, messages: items } : { position: 0, variants: items };
    db.insert(schema.agentThreadContextEvents).values({ id: 'frozen', threadId: 't1', seq: 0, kind, payloadJson: JSON.stringify(payload), createdAt: NOW }).run();
    const all: unknown[] = [];
    for (let offset = 0; offset < items.length; offset += 7) {
      const result = await store.readEventDetail('t1', 'frozen', { limit: 7, cursor: { threadId: 't1', eventId: 'frozen', epoch: 0, offset } });
      if (result.status !== 'ready') throw new Error(`Expected slice, got ${result.status}`);
      const array = (result.payload as Record<string, unknown[]>)[kind === 'rp_sync' ? 'messages' : 'variants']!;
      expect(array.length).toBeLessThanOrEqual(7);
      expect(result.totalItems).toBe(123);
      expect(result.hasMore).toBe(offset + array.length < items.length);
      all.push(...array);
    }
    expect(all).toEqual(items);
    expect(await store.readEventDetail('t1', 'frozen', { limit: 7, cursor: { threadId: 't1', eventId: 'frozen', epoch: 0, offset: 123 } }))
      .toEqual({ status: 'invalid-cursor' });
  });

  test('detail ownership, stale cursors, bad offsets and deleted sources have explicit outcomes', async () => {
    const { db, store } = await setup();
    db.insert(schema.agentThreadContextEvents).values({ id: 'frozen', threadId: 't1', seq: 0, kind: 'rp_sync', payloadJson: '{"fromPosition":0,"toPosition":1,"messages":[{},{}]}', createdAt: NOW }).run();
    const cursor = { threadId: 't1', eventId: 'frozen', epoch: 0, offset: 1 };
    expect(await store.readEventDetail('missing', 'frozen', { limit: 1 })).toEqual({ status: 'missing-thread' });
    expect(await store.readEventDetail('t2', 'frozen', { limit: 1 })).toEqual({ status: 'missing-event' });
    expect(await store.readEventDetail('t2', 'frozen', { limit: 1, cursor })).toEqual({ status: 'invalid-cursor' });
    expect(await store.readEventDetail('t1', 'other', { limit: 1, cursor })).toEqual({ status: 'invalid-cursor' });
    for (const offset of [-1, 1.5, Infinity, 20]) {
      expect(await store.readEventDetail('t1', 'frozen', { limit: 1, cursor: { ...cursor, offset } })).toEqual({ status: 'invalid-cursor' });
    }
    db.$client.exec("UPDATE agent_thread_context_events SET payload_json = '{}' WHERE id = 'frozen'");
    expect(await store.readEventDetail('t1', 'frozen', { limit: 1, cursor })).toEqual({ status: 'stale-window', historyEpoch: 1 });
    db.$client.exec("DELETE FROM agent_thread_context_events WHERE id = 'frozen'");
    expect(await store.readEventDetail('t1', 'frozen', { limit: 1 })).toEqual({ status: 'missing-event' });
  });

  test('corrupt bodies never become empty success; empty arrays and invalid primitives stay distinguishable', async () => {
    const { db, store } = await setup();
    for (const [id, payloadJson] of [['syntax', '{bad'], ['shape', '{"messages":"wrong"}'], ['empty', '{"fromPosition":0,"toPosition":0,"messages":[]}'],
      ['primitives', '{"fromPosition":0,"toPosition":0,"messages":[true,false,null,1,"text"]}']] as const) {
      db.insert(schema.agentThreadContextEvents).values({ id, threadId: 't1', kind: 'rp_sync', payloadJson, createdAt: NOW }).run();
    }
    expect(await store.readEventDetail('t1', 'syntax', { limit: 5 })).toEqual({ status: 'corrupt' });
    expect(await store.readEventDetail('t1', 'shape', { limit: 5 })).toEqual({ status: 'corrupt' });
    expect(await store.readEventDetail('t1', 'empty', { limit: 5 })).toMatchObject({ status: 'ready', totalItems: 0, hasMore: false });
    // Domain validation (AFP-10), not a narrowing DB mapper, refuses these.
    expect(await store.readEventDetail('t1', 'primitives', { limit: 5 })).toMatchObject({ status: 'ready', payload: { messages: [true, false, null, 1, 'text'] } });
    db.insert(schema.agentThreadContextEvents).values({ id: 'unknown', threadId: 't1', kind: 'unknown-kind', payloadJson: '{}', createdAt: NOW }).run();
    expect(await store.readEventDetail('t1', 'unknown', { limit: 5 })).toEqual({ status: 'corrupt' });
  });

  test('an oversized frozen snapshot returns only the requested captured items, never every RP body', async () => {
    const { db, store } = await setup();
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: `rp-${i}`, text: `captured-${i} ${'x'.repeat(500)}` }));
    db.insert(schema.agentThreadContextEvents).values({ id: 'large', threadId: 't1', kind: 'rp_sync', seq: 0,
      payloadJson: JSON.stringify({ fromPosition: 0, toPosition: 4999, messages: items }), createdAt: NOW }).run();
    const result = await store.readEventDetail('t1', 'large', { limit: 3 });
    expect(result).toMatchObject({ status: 'ready', totalItems: 5000, hasMore: true,
      payload: { messages: items.slice(0, 3) } });
    expect(JSON.stringify(result).length).toBeLessThan(3000);
    // No RP source rows exist: these bytes come exclusively from the snapshot.
    expect(db.$client.query('SELECT id FROM messages').all()).toEqual([]);
  });

  test('detail epoch and array slice remain coherent if a sibling rewrites the event during the read', async () => {
    const work = await mkdtemp(join(tmpdir(), 'vt-feed-detail-snapshot-'));
    const path = join(work, 'detail.db');
    const first = await createDb(path);
    first.insert(schema.experienceCopilotThreads).values({ id: 't1', createdAt: NOW, updatedAt: NOW }).run();
    const captured = { fromPosition: 0, toPosition: 1, messages: [{ text: 'old-0' }, { text: 'old-1' }] };
    first.insert(schema.agentThreadContextEvents).values({ id: 'event', threadId: 't1', kind: 'rp_sync',
      payloadJson: JSON.stringify(captured), createdAt: NOW }).run();
    const second = await createDb(path);
    const originalQuery = first.$client.query.bind(first.$client);
    let fired = false;
    const probe = spyOn(first.$client, 'query').mockImplementation((query, ...params) => {
      if (!fired && query.includes('AS factsJson')) {
        fired = true;
        second.$client.query('UPDATE agent_thread_context_events SET payload_json = ? WHERE id = ?')
          .run(JSON.stringify({ fromPosition: 0, toPosition: 0, messages: [{ text: 'rewritten' }] }), 'event');
      }
      return originalQuery(query, ...params);
    });
    try {
      const store = new ExperienceCopilotStore(first);
      const detail = await store.readEventDetail('t1', 'event', { limit: 1 });
      expect(fired).toBe(true);
      expect(detail).toMatchObject({ status: 'ready', historyEpoch: 0, totalItems: 2, hasMore: true,
        payload: { messages: [captured.messages[0]] } });
      expect(await store.readEventDetail('t1', 'event', { limit: 1 })).toMatchObject({
        status: 'ready', historyEpoch: 1, totalItems: 1, hasMore: false, payload: { messages: [{ text: 'rewritten' }] },
      });
    } finally { probe.mockRestore(); }
  });

  test.each(['selection_changed', 'branch_forked', 'profile_changed'] as const)('%s retains its exact small frozen payload', async (kind) => {
    const { db, store } = await setup();
    const payload = { at: 4, position: 3, previous: { text: 'captured old' }, current: { text: 'captured new' }, from: { id: 'p', name: 'Then' }, to: { id: 'q', name: 'Now' } };
    db.insert(schema.agentThreadContextEvents).values({ id: 'frozen', threadId: 't1', kind, payloadJson: JSON.stringify(payload), createdAt: NOW }).run();
    const result = await store.readEventDetail('t1', 'frozen', { limit: 1 });
    expect(result).toMatchObject({ status: 'ready', payload, totalItems: 1, hasMore: false });
  });
});
