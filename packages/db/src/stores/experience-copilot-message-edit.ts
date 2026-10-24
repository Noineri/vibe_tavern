// In-place assistant-message edit for agent threads (AGENT_SHELL_POLISH,
// AP-30) — the store-seam writer that replaces the stored `content` of ONE
// assistant TEXT row, nothing else. Sibling of experience-copilot-turn-
// delete.ts (the fork-copy sibling pattern): experience-copilot-store.ts
// keeps a thin delegating method, while the eligibility checks and the
// single-row update live here, owned by the store family. Everything runs
// inside ONE synchronous transaction — the read, the checks, and the update
// share it, so a compaction landing mid-edit can never fold the row this
// edit is about to rewrite (bun:sqlite transactions are synchronous; no
// await can interleave between the read and the write).
//
// Eligibility (the AP-30 contract): the row must be an assistant TEXT row —
// role "assistant", non-empty current content, no `toolCallsJson` (a
// tool-call carrier's empty `content` is not the model's text) — and not
// folded: at or after the LAST digest's anchor, read through the SAME
// single derivation the stream, the compaction service, and the turn delete
// consume (resolveDigestBoundary, @vibe-tavern/domain — the digest's
// `toolCallId` carries the first KEPT message's id). Membership in the
// boundary's `kept` window is the rule: the kept tail between the anchor
// and the digest row's own chronological position stays editable (AP-33's
// boundary semantics — never "after the digest row itself"), the covered
// prefix does not (the model sees the digest, not those rows), and the
// digest row is refused by the role check before the boundary is consulted.
// A dangling anchor degrades to no-drop (kept = every non-digest row), the
// same never-wrong-side floor the delete uses.
//
// What an edit must NOT touch (pinned by tests): the row's id, createdAt,
// seq (SC-1), reasoning pair (AP-28), every other row, frozen context
// events, and the message order — the UPDATE writes `content` only. The
// thread's updated_at IS bumped (the store family's every-write convention,
// so the thread surfaces as touched). The next turn's model history carries
// the edited text because storeMessagesToHistory reads `content` — no
// special path, pinned by the agent history test.

import { eq } from 'drizzle-orm';
import { resolveDigestBoundary } from '@vibe-tavern/domain';
import { experienceCopilotThreads, experienceCopilotMessages } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock } from '../persistence.js';
import { mapMessage } from './experience-copilot-row-mappers.js';
import type { ExperienceCopilotMessage } from './experience-copilot-store.js';

/** The edit's collaborators — the store family's own db handle plus a clock
 *  for the thread's updated_at bump (defaults to the system clock when
 *  omitted, the same default a bare `new ExperienceCopilotStore(db)` gets).
 *  No id generator: an edit inserts nothing. */
export interface MessageEditDeps {
  db: AppDb;
  clock?: StoreClock;
}

/** What {@link updateAssistantMessageContent} can answer. The caller (the
 *  adapter) owns the HTTP mapping: `edited` is the updated row, each
 *  refusal/missing status is one error family — the store family throws
 *  plain Errors only for MISUSE, never for caller-reachable outcomes. */
export type CopilotMessageEditResult =
  | {
      status: 'edited';
      /** The updated row, re-read after the write (id, createdAt, seq, and
       *  the reasoning pair are exactly the pre-edit values). */
      message: ExperienceCopilotMessage;
    }
  /** The addressed row's role is not "assistant" (a user, tool, or digest
   *  row — `role` echoes it for the error message). */
  | { status: 'refused-not-assistant'; role: string }
  /** An assistant row carrying `toolCallsJson` — a tool-call carrier, not a
   *  text row. */
  | { status: 'refused-tool-call-row' }
  /** The replacement content is empty/blank — the seam refuses it before
   *  any I/O (the route's zod schema refuses an empty string the same way;
   *  blank-only text is caught only here). */
  | { status: 'refused-empty-content' }
  /** An assistant row whose CURRENT content is empty/blank — a degenerate
   *  row with no text to edit (persistTurn never writes one; forks and
   *  legacy rows can carry it). */
  | { status: 'refused-empty-row' }
  /** The addressed row sits in the covered prefix of the last digest — the
   *  model sees the digest, not that row. */
  | { status: 'refused-folded' }
  | { status: 'missing-thread' }
  | { status: 'missing-message' };

/**
 * Replace ONE assistant text row's `content` in place (AP-30). Refuses
 * everything that is not an editable assistant text row (see the module
 * comment for the boundary), then updates that single row's `content` and
 * bumps the thread's updated_at inside ONE synchronous transaction.
 * Works for every owner (script, draft, chat-owned); the chat-owned guard
 * is vacuous here — an edit never deletes anything, so frozen context
 * events are untouched by construction.
 */
export async function updateAssistantMessageContent(
  deps: MessageEditDeps,
  threadId: string,
  messageId: string,
  content: string,
): Promise<CopilotMessageEditResult> {
  // Cheap, pure refusal first: an empty/blank replacement is invalid for
  // every thread, so it never pays a read (mirrors persistTurn, which never
  // writes a whitespace-only text row).
  if (content.trim() === '') {
    return { status: 'refused-empty-content' };
  }
  const clock = resolveStoreRuntime({ clock: deps.clock }).clock;
  let result!: CopilotMessageEditResult;
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
    // tiebreaker) — the order the digest boundary resolves in.
    const rows = tx
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.threadId, threadId))
      .orderBy(experienceCopilotMessages.createdAt, experienceCopilotMessages.id)
      .all();
    const row = rows.find((r) => r.id === messageId);
    if (row === undefined) {
      result = { status: 'missing-message' };
      return;
    }

    // ── Eligibility: an assistant TEXT row, not folded ────────────────────
    // The role check also catches the digest row (role "digest") and the
    // anchor's own family — before the boundary is consulted.
    if (row.role !== 'assistant') {
      result = { status: 'refused-not-assistant', role: row.role };
      return;
    }
    if (row.toolCallsJson !== null) {
      result = { status: 'refused-tool-call-row' };
      return;
    }
    if (row.content.trim() === '') {
      result = { status: 'refused-empty-row' };
      return;
    }
    // The fold boundary (one derivation: resolveDigestBoundary) — kept
    // membership, NOT "after the digest row's own position": the kept tail
    // between the anchor and the digest row stays editable.
    const boundary = resolveDigestBoundary(rows);
    if (!boundary.kept.some((kept) => kept.id === messageId)) {
      result = { status: 'refused-folded' };
      return;
    }

    // ── The in-place update: `content` only, plus the updated_at bump ────
    const now = clock.now();
    tx
      .update(experienceCopilotMessages)
      .set({ content })
      .where(eq(experienceCopilotMessages.id, messageId))
      .run();
    tx
      .update(experienceCopilotThreads)
      .set({ updatedAt: now })
      .where(eq(experienceCopilotThreads.id, threadId))
      .run();
    const updated = tx
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.id, messageId))
      .get();
    result = { status: 'edited', message: mapMessage(updated!) };
  });
  return result;
}
