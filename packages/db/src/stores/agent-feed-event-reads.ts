// AFP-9: lightweight SQL projection and sliced immutable bodies. This module
// extracts facts, NOT a second event validator: AFP-10 reuses the frozen parser.
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { AgentFeedPosition } from './agent-feed-order.js';
import { AGENT_THREAD_CONTEXT_EVENT_KINDS } from './agent-thread-context-events.js';

export interface AgentFeedEventFacts {
  payloadValid: boolean;
  payloadType: string | null;
  fromPosition: number | null;
  toPosition: number | null;
  position: number | null;
  at: number | null;
  messageId: string | null;
  messagesType: string | null;
  variantsType: string | null;
  messageCount: number | null;
  variantCount: number | null;
  fromId: string | null;
  fromName: string | null;
  toId: string | null;
  toName: string | null;
}
export interface AgentFeedEventRecord {
  position: AgentFeedPosition;
  kind: string;
  beforeMessageId: string | null;
  facts: AgentFeedEventFacts;
}

function scalar(path: string, number: boolean): string {
  return `CASE WHEN json_type(payload, '${path}') ${number ? "IN ('integer', 'real')" : "= 'text'"}
    THEN json_extract(payload, '${path}') END`;
}

// Paths are fixed module-owned strings, NEVER request data. No body/variant
// text escapes into a summary, even when a corrupt scalar contains an object.
const FACTS_SQL = `json_object(
  'payloadValid', valid, 'payloadType', json_type(payload),
  'fromPosition', ${scalar('$.fromPosition', true)}, 'toPosition', ${scalar('$.toPosition', true)},
  'position', ${scalar('$.position', true)}, 'at', ${scalar('$.at', true)},
  'messageId', ${scalar('$.messageId', false)},
  'messagesType', json_type(payload, '$.messages'), 'variantsType', json_type(payload, '$.variants'),
  'messageCount', CASE WHEN json_type(payload, '$.messages') = 'array' THEN json_array_length(payload, '$.messages') END,
  'variantCount', CASE WHEN json_type(payload, '$.variants') = 'array' THEN json_array_length(payload, '$.variants') END,
  'fromId', ${scalar('$.from.id', false)}, 'fromName', ${scalar('$.from.name', false)},
  'toId', ${scalar('$.to.id', false)}, 'toName', ${scalar('$.to.name', false)}
)`;

export function readAgentFeedEventFacts(client: Database, threadId: string, eventId: string): {
  kind: string; facts: AgentFeedEventFacts;
} | null {
  const row = client.query<{ kind: string; factsJson: string }, [string, string]>(`
    SELECT kind, ${FACTS_SQL} AS factsJson FROM (
      SELECT kind, json_valid(payload_json) AS valid,
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END AS payload
      FROM agent_thread_context_events WHERE thread_id = ? AND id = ?
    )`).get(threadId, eventId);
  if (!row) return null;
  // SQL owns this fixed projection, so only the compact facts object is parsed.
  const facts = JSON.parse(row.factsJson) as Omit<AgentFeedEventFacts, 'payloadValid'> & { payloadValid: number };
  return { kind: row.kind, facts: { ...facts, payloadValid: facts.payloadValid === 1 } };
}

export interface AgentEventDetailSlice {
  kind: string;
  payload: unknown;
  offset: number;
  totalItems: number;
  hasMore: boolean;
}

export function readAgentEventDetailSlice(
  client: Database, threadId: string, eventId: string, offset: number, limit: number,
): AgentEventDetailSlice | 'missing' | 'corrupt' | 'invalid-offset' {
  const event = readAgentFeedEventFacts(client, threadId, eventId);
  if (!event) return 'missing';
  if (!event.facts.payloadValid) return 'corrupt';
  const { kind, facts } = event;
  if (!AGENT_THREAD_CONTEXT_EVENT_KINDS.some((known) => known === kind)) return 'corrupt';
  if (kind !== 'rp_sync' && kind !== 'variants_attached') {
    if (offset !== 0) return 'invalid-offset';
    const row = client.query<{ payloadJson: string }, [string, string]>(
      'SELECT payload_json AS payloadJson FROM agent_thread_context_events WHERE thread_id = ? AND id = ?',
    ).get(threadId, eventId)!;
    return { kind, payload: JSON.parse(row.payloadJson) as unknown, offset, totalItems: 1, hasMore: false };
  }
  const totalItems = kind === 'rp_sync' ? facts.messageCount : facts.variantCount;
  if (totalItems === null) return 'corrupt';
  if (offset > totalItems || (offset === totalItems && totalItems !== 0)) return 'invalid-offset';
  const path = kind === 'rp_sync' ? '$.messages' : '$.variants';
  // json_each walks the frozen array in SQLite; only LIMITed items cross the
  // DB boundary. No full payload is parsed/sliced in JS, and source RP tables
  // are never consulted. JSON primitives are preserved for the shared validator.
  const items = client.query<{ itemJson: string }, SQLQueryBindings[]>(`
    SELECT CASE WHEN item.type IN ('object', 'array') THEN item.value
      WHEN item.type = 'true' THEN 'true' WHEN item.type = 'false' THEN 'false'
      ELSE json_quote(item.value) END AS itemJson
    FROM agent_thread_context_events AS event, json_each(event.payload_json, ?) AS item
    WHERE event.thread_id = ? AND event.id = ? AND item.key >= ?
    ORDER BY item.key LIMIT ?`).all(path, threadId, eventId, offset, limit).map((row) => JSON.parse(row.itemJson) as unknown);
  const payload = kind === 'rp_sync'
    ? { fromPosition: facts.fromPosition, toPosition: facts.toPosition, messages: items }
    : { position: facts.position, variants: items };
  return { kind, payload, offset, totalItems, hasMore: offset + items.length < totalItems };
}
