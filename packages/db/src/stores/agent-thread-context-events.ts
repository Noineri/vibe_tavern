// Frozen-context read model for agent threads (SIDECHAT_PLAN SC-1): the event
// kinds, the event / frontier / merged-timeline types, and their pure helpers.
// Extracted from experience-copilot-store.ts when that file hit the arch-gate
// size cap; the store class remains the only writer/reader of the underlying
// columns (agent_thread_context_events, next_seq, rp_frontier_json) — this
// module holds the vocabulary it reads and writes with. Later units import
// these types from the @vibe-tavern/db barrel (SC-2c writes rp_sync events;
// SC-3 reads the timeline into a prompt).

import { log } from '@vibe-tavern/domain';
import type { AgentThreadContextEventId, ExperienceCopilotThreadId } from '@vibe-tavern/domain';
import type { ExperienceCopilotMessage } from './experience-copilot-store.js';

const logger = log.tag('agent-thread-context-events');

/** The kinds of frozen-context event a chat-owned thread's timeline can
 *  record (SC-1). Single source for the derived union; the writer of each
 *  kind's payload ships in later units (SC-2c+). */
export const AGENT_THREAD_CONTEXT_EVENT_KINDS = [
  'rp_sync',
  'variants_attached',
  'selection_changed',
  'branch_forked',
] as const;
export type AgentThreadContextEventKind = (typeof AGENT_THREAD_CONTEXT_EVENT_KINDS)[number];

/** The RP-chat frontier a chat-owned thread has frozen (SC-1): the chat edge
 *  the thread's context was synced to — `lastPosition` plus the chosen
 *  variant per message id. `selected` keys/semantics are owned by the sync
 *  writer (SC-2c); the store only round-trips the shape wholesale. */
export interface AgentThreadRpFrontier {
  lastPosition: number;
  selected: Record<string, string>;
}

/** One RP sync's write plan (SC-2c): the frozen-context events to append plus
 *  the next frontier to store wholesale. The store's applyRpSync asks the
 *  sync writer for this INSIDE its transaction — the callback form keeps the
 *  pure diff (services/api's computeRpSync) out of this package's imports
 *  (dependency direction) while the input frontier is still read inside the
 *  same transaction that commits the plan. */
export interface RpSyncWritePlan {
  events: readonly { kind: AgentThreadContextEventKind; payload: unknown }[];
  frontier: AgentThreadRpFrontier;
}

/** One frozen-context event row (SC-1) — store projection. `payload` is the
 *  parsed `payload_json`; its shape is kind-specific and owned by the event's
 *  writer (SC-2c+), so it stays `unknown` here. */
export interface AgentThreadContextEvent {
  id: AgentThreadContextEventId;
  threadId: ExperienceCopilotThreadId;
  seq: number | null;
  kind: AgentThreadContextEventKind;
  payload: unknown;
  createdAt: string;
}

/** Merged timeline row of ONE thread (SC-1), tagged by row type so consumers
 *  can discriminate a message from a context event (the event's own `kind`
 *  discriminates within events). Chat-owned threads interleave by `seq`
 *  (ascending; pre-SC-1 NULL-seq rows sort first); a thread whose rows are
 *  all-NULL seq (script/draft) orders by `createdAt` + id — byte-identical to
 *  the store's listMessages today. */
export type AgentThreadTimelineEntry =
  | (ExperienceCopilotMessage & { rowType: 'message' })
  | (AgentThreadContextEvent & { rowType: 'event' });

/** Stable merged-timeline order (SC-1): seq ascending with NULL first
 *  (pre-SC-1 legacy rows are the oldest), then createdAt, then id. For an
 *  all-NULL-seq thread (script/draft) this degenerates to exactly
 *  listMessages' (createdAt, id) order — the unit's must-stay-true. */
export function compareTimelineEntries(a: AgentThreadTimelineEntry, b: AgentThreadTimelineEntry): number {
  if (a.seq !== b.seq) {
    if (a.seq === null) return -1;
    if (b.seq === null) return 1;
    return a.seq - b.seq;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Type guard for the `selected` map of an AgentThreadRpFrontier (SC-1): a
 *  plain object whose every value is a string (messageId → variantId). */
function isVariantMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const variant of Object.values(value as Record<string, unknown>)) {
    if (typeof variant !== 'string') return false;
  }
  return true;
}

/** Parse `rp_frontier_json` into a validated AgentThreadRpFrontier (SC-1), or
 *  null when malformed or of the wrong shape (logged, never fatal) — the
 *  defensive-parse twin of the metrics/todo/link parsers: the column is
 *  always written via JSON.stringify of a valid object, so a failure
 *  indicates corruption, and the next setFrontier write heals it. */
export function parseFrontier(text: string, threadId: string): AgentThreadRpFrontier | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.lastPosition === 'number' && isVariantMap(rec.selected)) {
        return { lastPosition: rec.lastPosition, selected: rec.selected };
      }
    }
  } catch (err) {
    logger.warn(
      'malformed rp_frontier_json for thread %s (%s)',
      threadId,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  logger.warn('invalid rp_frontier_json shape for thread %s', threadId);
  return null;
}
