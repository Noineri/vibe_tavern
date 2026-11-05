// AFP-9: additive, coherent UI reads. Legacy listMessages/listTimeline and
// model-context reads are deliberately untouched. No wire parsers/HTTP here.
// fork #1 of agentFeedRangeSql (agent-feed-order.ts): readDigestCounts needs
// the same NULL-prefix/seq/time/id predicate against SQL columns, not bound
// coordinates. Ordering changes update BOTH predicates and their tests.
import { eq, and } from 'drizzle-orm';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { AppDb } from '../db-connection.js';
import { experienceCopilotThreads, experienceCopilotMessages } from '../db-schema.js';
import { mapMessage, mapThread } from './experience-copilot-row-mappers.js';
import type { ExperienceCopilotMessage, ExperienceCopilotThread } from './experience-copilot-store.js';
import {
  agentFeedRangeSql, assertAgentFeedLimit, compareAgentFeedPositions, getAgentFeedPosition,
  seekAgentFeedPositions, type AgentFeedPageRequest, type AgentFeedPosition,
} from './agent-feed-order.js';
import { readAgentFeedEventFacts, readAgentEventDetailSlice, type AgentFeedEventRecord, type AgentEventDetailSlice } from './agent-feed-event-reads.js';

export type AgentFeedRecord =
  | { record: 'message'; position: AgentFeedPosition; message: ExperienceCopilotMessage }
  | ({ record: 'event' } & AgentFeedEventRecord);
export interface AgentFeedMessageFact {
  position: AgentFeedPosition;
  role: string;
}
/** Raw DB facts, not final UI boundary decisions. All are read in the SAME
 * snapshot as the page, including unloaded anchors and split call identities. */
export interface AgentFeedBoundaryFacts {
  previousMessage: AgentFeedMessageFact | null;
  nextMessage: AgentFeedMessageFact | null;
  turnOpener: AgentFeedPosition | null;
  firstAssistant: AgentFeedPosition | null;
  lastUser: AgentFeedPosition | null;
  continuedToolCalls: { toolCallId: string; toolName: string | null; callPosition: AgentFeedPosition }[];
  digests: {
    loadedCounts?: { id: string; coveredCount: number }[];
    total: number;
    older: number;
    last: { position: AgentFeedPosition; anchorId: string | null; anchorPosition: AgentFeedPosition | null } | null;
  };
}
export type AgentFeedPageResult =
  | { status: 'missing-thread' | 'missing-message' | 'invalid-cursor' }
  | { status: 'stale-window'; historyEpoch: number }
  | {
    status: 'ready'; thread: ExperienceCopilotThread; historyEpoch: number;
    head: AgentFeedPosition | null; records: AgentFeedRecord[];
    hasOlder: boolean; hasNewer: boolean; resumePosition: AgentFeedPosition | null;
    boundary: AgentFeedBoundaryFacts;
  };
export interface AgentEventDetailRequest {
  limit: number;
  cursor?: { threadId: string; eventId: string; epoch: number; offset: number };
}
export type AgentEventDetailResult =
  | { status: 'missing-thread' | 'missing-event' | 'invalid-cursor' | 'corrupt' }
  | { status: 'stale-window'; historyEpoch: number }
  | ({ status: 'ready'; threadId: string; eventId: string; historyEpoch: number } & AgentEventDetailSlice);

function messageFact(client: Database, threadId: string, position?: AgentFeedPosition): AgentFeedMessageFact | null {
  if (!position) return null;
  const row = client.query<{ role: string }, [string, string]>(
    'SELECT role FROM experience_copilot_messages WHERE thread_id = ? AND id = ?',
  ).get(threadId, position.id);
  return row ? { position, role: row.role } : null;
}

function digestCount(client: Database, threadId: string, before?: AgentFeedPosition): number {
  let count = 0;
  for (const nullSeq of [true, false]) {
    const range = agentFeedRangeSql('message', nullSeq, 'before', before);
    if (!range) continue;
    count += client.query<{ count: number }, SQLQueryBindings[]>(`
      SELECT count(*) AS count FROM experience_copilot_messages
      WHERE thread_id = ? AND seq IS ${nullSeq ? '' : 'NOT '}NULL AND role = 'digest'${range.text}
    `).get(threadId, ...range.params)!.count;
  }
  return count;
}

function readBoundaryFacts(
  client: Database, threadId: string, records: AgentFeedRecord[],
): AgentFeedBoundaryFacts {
  const oldest = records[0]?.position;
  const newest = records.at(-1)?.position;
  const lastUser = seekAgentFeedPositions(client, threadId, 'before', 1, undefined, 'message', 'user')[0] ?? null;
  const firstIsUser = records[0]?.record === 'message' && records[0].message.role === 'user';
  const turnOpener = firstIsUser ? oldest! : oldest
    ? seekAgentFeedPositions(client, threadId, 'before', 1, oldest, 'message', 'user')[0] ?? null : null;
  const candidateAssistant = oldest
    ? seekAgentFeedPositions(client, threadId, 'after', 1, turnOpener ?? undefined, 'message', 'assistant')[0] ?? null : null;
  const nextUser = oldest ? seekAgentFeedPositions(client, threadId, 'after', 1, turnOpener ?? undefined, 'message', 'user')[0] : undefined;
  const firstAssistant = candidateAssistant && (!nextUser || compareAgentFeedPositions(candidateAssistant, nextUser) < 0) ? candidateAssistant : null;
  const digest = seekAgentFeedPositions(client, threadId, 'before', 1, undefined, 'message', 'digest')[0];
  const anchorId = digest ? client.query<{ anchorId: string | null }, [string, string]>(
    'SELECT tool_call_id AS anchorId FROM experience_copilot_messages WHERE thread_id = ? AND id = ?',
  ).get(threadId, digest.id)!.anchorId : null;
  const continuedToolCalls: AgentFeedBoundaryFacts['continuedToolCalls'] = [];
  const toolIds = new Set(records.flatMap((record) => record.record === 'message'
    && record.message.role === 'tool' && record.message.toolCallId ? [record.message.toolCallId] : []));
  for (const toolCallId of toolIds) {
    // Only compact call identity/name is projected; large input argument blobs
    // and every other historical call stay in SQLite. Invalid JSON is safe.
    const call = client.query<AgentFeedPosition & { toolName: string | null }, [string, string]>(`
      SELECT m.id, m.seq, m.created_at AS createdAt,
        CASE WHEN json_type(call.value, '$.toolName') = 'text' THEN json_extract(call.value, '$.toolName') END AS toolName
      FROM experience_copilot_messages AS m,
        json_each(CASE WHEN json_valid(m.tool_calls_json) THEN m.tool_calls_json ELSE '[]' END) AS call
      WHERE m.thread_id = ? AND m.role = 'assistant'
        AND CASE WHEN call.type = 'object' THEN json_extract(call.value, '$.toolCallId') END = ?
      ORDER BY m.seq DESC, m.created_at DESC, m.id DESC LIMIT 1
    `).get(threadId, toolCallId);
    if (call && oldest) {
      const callPosition: AgentFeedPosition = { record: 'message', id: call.id, seq: call.seq, createdAt: call.createdAt };
      if (compareAgentFeedPositions(callPosition, oldest) < 0) continuedToolCalls.push({ toolCallId, toolName: call.toolName, callPosition });
    }
  }
  return {
    previousMessage: oldest ? messageFact(client, threadId, seekAgentFeedPositions(client, threadId, 'before', 1, oldest, 'message')[0]) : null,
    nextMessage: newest ? messageFact(client, threadId, seekAgentFeedPositions(client, threadId, 'after', 1, newest, 'message')[0]) : null,
    turnOpener, firstAssistant, lastUser, continuedToolCalls,
    digests: {
      loadedCounts: readDigestCounts(client, threadId, records),
      total: digestCount(client, threadId), older: oldest ? digestCount(client, threadId, oldest) : 0,
      last: digest ? { position: digest, anchorId, anchorPosition: anchorId ? getAgentFeedPosition(client, threadId, 'message', anchorId) : null } : null,
    },
  };
}

/** Count full-thread flow boundaries in SQL, hydrating only selected digest
 * facts. Equal anchors follow chronological digest order, just like the legacy
 * stable anchor sort; dangling anchors resolve to the full flow's end. */
function readDigestCounts(client: Database, threadId: string, records: AgentFeedRecord[]): { id: string; coveredCount: number }[] {
  const ids = records.flatMap((r) => r.record === 'message' && r.message.role === 'digest' ? [r.position.id] : []);
  if (ids.length === 0) return [];
  return client.query<{ id: string; coveredCount: number }, SQLQueryBindings[]>(`
    WITH counts AS (
      SELECT d.id, d.seq, d.created_at,
        (SELECT count(*) FROM experience_copilot_messages m
         WHERE m.thread_id = d.thread_id AND m.role IN ('user', 'assistant') AND (
           a.id IS NULL OR (m.seq IS NULL AND a.seq IS NOT NULL)
           OR (m.seq IS a.seq AND (m.created_at, m.id) < (a.created_at, a.id))
           OR (m.seq IS NOT NULL AND a.seq IS NOT NULL AND m.seq < a.seq)
         )) AS n
      FROM experience_copilot_messages d
      LEFT JOIN experience_copilot_messages a ON a.thread_id = d.thread_id AND a.id = d.tool_call_id
      WHERE d.thread_id = ? AND d.role = 'digest'
    ), covered AS (
      SELECT id, seq, created_at, n - lag(n, 1, 0) OVER (ORDER BY n, seq, created_at, id) AS coveredCount FROM counts
    )
    SELECT id, coveredCount FROM covered WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY seq, created_at, id
  `).all(threadId, ...ids);
}

/** Caller supplies a decoded/validated cursor and policy-bounded limit.
 * Each lane seeks/limits COORDINATES first, then hydrates only the selected
 * page. At most four bounded candidate lists are merged, never full history. */
export function readAgentFeedPage(db: AppDb, threadId: string, request: AgentFeedPageRequest): AgentFeedPageResult {
  assertAgentFeedLimit(request.limit);
  return db.transaction((tx): AgentFeedPageResult => {
    const thread = tx.select().from(experienceCopilotThreads).where(eq(experienceCopilotThreads.id, threadId)).get();
    if (!thread) return { status: 'missing-thread' };
    const historyEpoch = thread.historyEpoch;
    const client = db.$client;
    if ('cursor' in request) {
      if (request.cursor.threadId !== threadId) return { status: 'invalid-cursor' };
      if (request.cursor.epoch !== historyEpoch) return { status: 'stale-window', historyEpoch };
    }
    let positions: AgentFeedPosition[];
    let resumePosition: AgentFeedPosition | null = null;
    if (request.mode === 'around') {
      const target = getAgentFeedPosition(client, threadId, 'message', request.messageId);
      if (!target) return { status: 'missing-message' };
      const left = seekAgentFeedPositions(client, threadId, 'before', Math.floor((request.limit - 1) / 2), target);
      const right = seekAgentFeedPositions(client, threadId, 'after', request.limit - left.length - 1, target);
      positions = [
        ...seekAgentFeedPositions(client, threadId, 'before', request.limit - right.length - 1, target), target, ...right,
      ];
      resumePosition = target;
    } else {
      const direction = request.mode === 'after' ? 'after' : 'before';
      resumePosition = 'cursor' in request ? request.cursor.position : null;
      positions = seekAgentFeedPositions(client, threadId, direction, request.limit, resumePosition ?? undefined);
    }
    const head = seekAgentFeedPositions(client, threadId, 'before', 1)[0] ?? null;
    const records: AgentFeedRecord[] = positions.map((position) => {
      if (position.record === 'message') {
        const row = tx.select().from(experienceCopilotMessages).where(and(
          eq(experienceCopilotMessages.threadId, threadId), eq(experienceCopilotMessages.id, position.id),
        )).get()!;
        return { record: 'message', position, message: mapMessage(row) };
      }
      const event = readAgentFeedEventFacts(client, threadId, position.id)!;
      const beforeMessageId = seekAgentFeedPositions(client, threadId, 'after', 1, position, 'message')[0]?.id ?? null;
      return { record: 'event', position, ...event, beforeMessageId };
    });
    return {
      status: 'ready', thread: mapThread(thread), historyEpoch, records, head, resumePosition,
      hasOlder: positions.length ? seekAgentFeedPositions(client, threadId, 'before', 1, positions[0])[0] !== undefined : request.mode === 'after' && head !== null,
      hasNewer: positions.length ? seekAgentFeedPositions(client, threadId, 'after', 1, positions.at(-1))[0] !== undefined : request.mode === 'before' && head !== null,
      boundary: readBoundaryFacts(client, threadId, records),
    };
  });
}

/** Frozen detail and its epoch use one snapshot, just like the feed read.
 * Payload shape validation remains the API domain's existing frozen parser. */
export function readAgentEventDetail(db: AppDb, threadId: string, eventId: string, request: AgentEventDetailRequest): AgentEventDetailResult {
  assertAgentFeedLimit(request.limit);
  const offset = request.cursor?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) return { status: 'invalid-cursor' };
  return db.transaction((tx): AgentEventDetailResult => {
    const thread = tx.select({ epoch: experienceCopilotThreads.historyEpoch }).from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId)).get();
    if (!thread) return { status: 'missing-thread' };
    if (request.cursor) {
      if (request.cursor.threadId !== threadId || request.cursor.eventId !== eventId) return { status: 'invalid-cursor' };
      if (request.cursor.epoch !== thread.epoch) return { status: 'stale-window', historyEpoch: thread.epoch };
    }
    const slice = readAgentEventDetailSlice(db.$client, threadId, eventId, offset, request.limit);
    if (slice === 'missing') return { status: 'missing-event' };
    if (slice === 'corrupt') return { status: 'corrupt' };
    if (slice === 'invalid-offset') return { status: 'invalid-cursor' };
    return { status: 'ready', threadId, eventId, historyEpoch: thread.epoch, ...slice };
  });
}
