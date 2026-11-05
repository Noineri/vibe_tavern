// AFP-9: coordinate-only indexed seeks. No payload columns, OFFSET paging or
// all-history read. The wire layer owns cursor encoding/version and limits.
// agentFeedRangeSql forks: 1 — readDigestCounts (agent-feed-store.ts), its
// column-to-column SQL prefix predicate; ordering changes update both.
// forks: 1 — compareAgentFeedOrderPositions
//   (apps/web/src/components/shared/agent-shell/agent-feed-reconcile.ts):
//   the SPA re-implements compareAgentFeedPositions (bun:sqlite is not
//   importable there). A change to the ordering/tie semantics changes BOTH
//   files together with the AFP-7 schema doc that states the contract
//   (packages/api-contracts/src/schemas/agent-feed-schema.ts).
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { compareTimelineEntries } from './agent-thread-context-events.js';

export interface AgentFeedPosition {
  record: 'message' | 'event';
  seq: number | null;
  createdAt: string;
  id: string;
}
export interface AgentFeedCursor {
  threadId: string;
  epoch: number;
  position: AgentFeedPosition;
}
export type AgentFeedPageRequest = { limit: number } & (
  | { mode: 'newest' }
  | { mode: 'before' | 'after'; cursor: AgentFeedCursor }
  | { mode: 'around'; messageId: string }
);
export interface AgentFeedSql {
  text: string;
  params: SQLQueryBindings[];
}
const RECORDS = ['message', 'event'] as const;
export const AGENT_FEED_TABLES = {
  message: 'experience_copilot_messages', event: 'agent_thread_context_events',
} as const;

/** Existing comparator, plus its stable-sort tie: listTimeline collects the
 * message table before events. Record is only a FINAL equal-key tiebreaker,
 * not a replacement for the canonical seq/time/id order. */
export function compareAgentFeedPositions(a: AgentFeedPosition, b: AgentFeedPosition): number {
  return compareTimelineEntries(a, b) || (a.record === b.record ? 0 : a.record === 'message' ? -1 : 1);
}

/** Each NULL/non-NULL lane is its own index range, avoiding an OR predicate
 * that makes SQLite scan/sort the whole merged timeline. null = empty lane. */
export function agentFeedRangeSql(
  record: AgentFeedPosition['record'], nullSeq: boolean, direction: 'before' | 'after',
  anchor?: AgentFeedPosition, inclusive = false,
): AgentFeedSql | null {
  if (!anchor) return { text: '', params: [] };
  if (nullSeq !== (anchor.seq === null)) {
    return (direction === 'before') === nullSeq ? { text: '', params: [] } : null;
  }
  const equalRecordIncluded = inclusive && record === anchor.record
    || (direction === 'before' ? record === 'message' && anchor.record === 'event' : record === 'event' && anchor.record === 'message');
  const operator = `${direction === 'before' ? '<' : '>'}${equalRecordIncluded ? '=' : ''}`;
  return nullSeq ? {
    text: ` AND (created_at, id) ${operator} (?, ?)`, params: [anchor.createdAt, anchor.id],
  } : {
    text: ` AND (seq, created_at, id) ${operator} (?, ?, ?)`, params: [anchor.seq, anchor.createdAt, anchor.id],
  };
}

/** Exported at the helper boundary so EXPLAIN tests exercise the EXACT seek
 * statements production runs, including params and both sequence lanes. */
export function buildAgentFeedSeekQuery(
  threadId: string, record: AgentFeedPosition['record'], nullSeq: boolean,
  direction: 'before' | 'after', limit: number, anchor?: AgentFeedPosition, role?: string,
): AgentFeedSql | null {
  const range = agentFeedRangeSql(record, nullSeq, direction, anchor);
  if (!range) return null;
  const order = direction === 'before' ? 'DESC' : 'ASC';
  return {
    text: `SELECT id, seq, created_at AS createdAt FROM ${AGENT_FEED_TABLES[record]}
      WHERE thread_id = ? AND seq IS ${nullSeq ? '' : 'NOT '}NULL${range.text}${role ? ' AND role = ?' : ''}
      ORDER BY ${nullSeq ? '' : `seq ${order}, `}created_at ${order}, id ${order} LIMIT ?`,
    params: [threadId, ...range.params, ...(role ? [role] : []), limit],
  };
}

export function seekAgentFeedPositions(
  client: Database, threadId: string, direction: 'before' | 'after', limit: number,
  anchor?: AgentFeedPosition, record?: AgentFeedPosition['record'], role?: string,
): AgentFeedPosition[] {
  if (limit === 0) return [];
  const candidates: AgentFeedPosition[] = [];
  for (const type of record ? [record] : RECORDS) for (const nullSeq of [true, false]) {
    const query = buildAgentFeedSeekQuery(threadId, type, nullSeq, direction, limit, anchor, role);
    if (!query) continue;
    const rows = client.query<Omit<AgentFeedPosition, 'record'>, SQLQueryBindings[]>(query.text).all(...query.params);
    candidates.push(...rows.map((row) => ({ ...row, record: type })));
  }
  candidates.sort(compareAgentFeedPositions);
  return direction === 'before' ? candidates.slice(-limit) : candidates.slice(0, limit);
}

export function getAgentFeedPosition(
  client: Database, threadId: string, record: AgentFeedPosition['record'], id: string,
): AgentFeedPosition | null {
  const row = client.query<Omit<AgentFeedPosition, 'record'>, [string, string]>(
    `SELECT id, seq, created_at AS createdAt FROM ${AGENT_FEED_TABLES[record]} WHERE thread_id = ? AND id = ?`,
  ).get(threadId, id);
  return row ? { ...row, record } : null;
}

export function assertAgentFeedLimit(limit: number): void {
  // Policy defaults/maximum are deliberately NOT duplicated below api-contracts.
  // Domain callers must supply the policy-validated bound, never an implicit one.
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('A positive safe-integer page limit is required');
}
