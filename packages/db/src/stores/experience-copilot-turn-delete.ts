// Turn delete for agent threads (AGENT_SHELL_POLISH, AP-8) — the store-seam
// writer that deletes ONE turn of a copilot thread: the rows after a user row
// up to the next user row (continuation rows after an ask/permission answer
// belong to the same turn — the answer rewrites the wait-tool row instead of
// appending a user row), optionally together with that user row. Extracted
// into its own module (the fork-copy sibling pattern) because
// experience-copilot-store.ts sits at the arch-gate size cap: the sibling is
// the entry point callers import (no thin class method fits the cap), and the
// columns it writes (experience_copilot_messages rows + the thread's
// updated_at) stay owned by the store family. Every write runs through ONE
// synchronous transaction opened here — the read, the digest-floor check, and
// the delete share it, so a compaction landing mid-delete can never fold rows
// this delete is about to remove (bun:sqlite transactions are synchronous; no
// await can interleave between the read and the writes).
//
// The digest floor: rows a context digest already folded are refused, using
// the SAME single derivation the stream and the compaction service read
// (resolveDigestBoundary, @vibe-tavern/domain — the digest's `toolCallId`
// carries the first KEPT message's id; everything strictly before it is
// covered). The refusal covers three shapes that would all corrupt the
// boundary: a turn intersecting the covered prefix, the turn that CONTAINS
// the anchor row (deleting the anchor would dangle the digest), and the
// digest row itself (addressed by messageId, it resolves to its enclosing
// span). The user deletes from the newest turn backward — the digest is a
// floor, exactly like the compact semantics.
//
// Chat-owned threads (sidechat): this deletes MESSAGE rows only. The
// thread's frozen context events (agent_thread_context_events) are NEVER
// deleted with a turn — they carry RP the frontier has already passed, and
// the next sync starts from the advanced frontier, so deleting an rp_sync
// would drop that RP from the sidechat's context for good. Surviving events
// keep their seq and stay in place on the merged timeline (an event left
// between two separators is fine); the thread's next_seq counter is a
// thread-row counter (never max(seq)), so future appends continue past every
// allocated seq — no reuse, no collision.

import { eq, inArray } from 'drizzle-orm';
import { resolveDigestBoundary } from '@vibe-tavern/domain';
import { brandId, type ExperienceCopilotMessageId } from '@vibe-tavern/domain';
import { experienceCopilotThreads, experienceCopilotMessages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';

/** The delete's collaborators — the store family's own db handle plus a
 *  clock for the thread's updated_at bump (defaults to the system clock when
 *  omitted, the same default a bare `new ExperienceCopilotStore(db)` gets).
 *  No id generator: a delete inserts nothing. */
export interface TurnDeleteDeps {
  db: AppDb;
  clock?: StoreClock;
}

/** What {@link deleteCopilotTurn} can answer. The caller (the adapter) owns
 *  the HTTP mapping: `deleted` is a success payload, each refusal/missing
 *  status is one error family (digest floor / user-row semantics / 404s) —
 *  the store family throws plain Errors only for MISUSE (the fork-copy
 *  pattern), never for caller-reachable outcomes. */
export type CopilotTurnDeleteResult =
  | {
      status: 'deleted';
      /** Every deleted row id, in timeline order (the user row included when
       *  it was deleted with the turn). */
      deletedMessageIds: ExperienceCopilotMessageId[];
      /** The user row deleted with the turn (a member of
       *  `deletedMessageIds`), or null when the turn's user row stayed. */
      deletedUserMessageId: ExperienceCopilotMessageId | null;
    }
  /** The resolved turn intersects the digest floor (covered rows, the anchor
   *  row, or the digest row itself) — refused, nothing written. */
  | { status: 'refused-digest' }
  /** `messageId` addresses a user row and `includeUserMessage` is false — the
   *  user's own message is only deletable together with its turn. */
  | { status: 'refused-user-row' }
  | { status: 'missing-thread' }
  | { status: 'missing-message' };

/**
 * Delete ONE turn of a copilot thread (AP-8): resolve the turn enclosing
 * `messageId` — the rows after the previous user row up to the next user row
 * (a `messageId` ON a user row resolves to that row's turn) — refuse what a
 * digest already folded, then delete the turn's rows (plus the user row when
 * `includeUserMessage`) and bump the thread's updated_at, all inside ONE
 * synchronous transaction. Tool-call pairing can never split: a carrier and
 * its tool rows are written within one turn, so whole-turn deletion always
 * removes both sides together. Never touches context events, the frontier,
 * next_seq, digests, or other threads. Works for every owner (script,
 * draft, chat-owned) — the chat-owned guard IS the event-preservation rule
 * above, not a refusal.
 */
export async function deleteCopilotTurn(
  deps: TurnDeleteDeps,
  threadId: string,
  messageId: string,
  includeUserMessage: boolean,
): Promise<CopilotTurnDeleteResult> {
  const clock = resolveStoreRuntime({ clock: deps.clock }).clock;
  let result!: CopilotTurnDeleteResult;
  deps.db.transaction((tx) => {
    const thread = tx
      .select({ id: experienceCopilotThreads.id })
      .from(experienceCopilotThreads)
      .where(eq(experienceCopilotThreads.id, threadId))
      .get();
    if (thread === undefined) {
      result = { status: 'missing-thread' };
      return;
    }
    // listMessages' own order (createdAt, then id as the same-timestamp
    // tiebreaker) — the timeline order the span is resolved in.
    const rows = tx
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.threadId, threadId))
      .orderBy(experienceCopilotMessages.createdAt, experienceCopilotMessages.id)
      .all();
    const idx = rows.findIndex((row) => row.id === messageId);
    if (idx === -1) {
      result = { status: 'missing-message' };
      return;
    }

    // ── Resolve the enclosing turn's span [start, end) ────────────────────
    // The span ends at the next user row after the addressed row; it starts
    // right after the previous user row — or AT the addressed row when that
    // row IS the user row (then only deletable together with its turn).
    let start: number;
    let userRowId: string | null = null;
    if (rows[idx]!.role === 'user') {
      if (!includeUserMessage) {
        result = { status: 'refused-user-row' };
        return;
      }
      start = idx;
      userRowId = rows[idx]!.id;
    } else {
      start = idx;
      while (start > 0 && rows[start - 1]!.role !== 'user') start -= 1;
      if (includeUserMessage && start > 0 && rows[start - 1]!.role === 'user') {
        userRowId = rows[start - 1]!.id;
        start -= 1;
      }
    }
    let end = rows.length;
    for (let i = idx + 1; i < rows.length; i++) {
      if (rows[i]!.role === 'user') {
        end = i;
        break;
      }
    }

    // ── The digest floor (one derivation: resolveDigestBoundary) ──────────
    const spanIds = new Set(rows.slice(start, end).map((row) => row.id));
    const boundary = resolveDigestBoundary(rows);
    if (boundary.lastDigest !== null) {
      const anchorId = boundary.lastDigest.toolCallId;
      const hitsFloor =
        spanIds.has(boundary.lastDigest.id) ||
        (anchorId !== null && spanIds.has(anchorId)) ||
        boundary.covered.some((row) => spanIds.has(row.id));
      if (hitsFloor) {
        result = { status: 'refused-digest' };
        return;
      }
    }

    // ── Delete the span's message rows, bump the thread, answer ───────────
    tx
      .delete(experienceCopilotMessages)
      .where(inArray(experienceCopilotMessages.id, [...spanIds]))
      .run();
    tx
      .update(experienceCopilotThreads)
      .set({ updatedAt: clock.now() })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
    result = {
      status: 'deleted',
      deletedMessageIds: rows.slice(start, end).map((row) => brandId<ExperienceCopilotMessageId>(row.id)),
      deletedUserMessageId: userRowId === null ? null : brandId<ExperienceCopilotMessageId>(userRowId),
    };
  });
  return result;
}
