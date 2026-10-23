import { and, eq } from 'drizzle-orm';
import { experienceCopilotThreads, experienceCopilotMessages } from '../db-schema.js';
import type { DbTransaction } from '../db-connection.js';

/**
 * Auto-title from the first user message (AGENT_SHELL_POLISH AP-19). A thread
 * is born untitled and stays that way until either the user renames it (a
 * rename always wins) or the FIRST user message persists, when the server
 * derives a title from that message — so the list shows the real opening line
 * instead of the client-side numbered "Session N" fallback (that fallback
 * stays client-only: the server never writes it to the DB, and threads that
 * never got a message keep the empty title). Lives in this sibling rather
 * than the store itself per the store's extraction precedent (row-parse /
 * row-mappers / turn-delete / fork-copy) — the store sits at the arch-gate
 * line cap, and the rule is one cohesive concern with its own tests.
 */

/** Hard cap on a derived title (AP-19: first line, collapsed, at most 120 chars). */
const TITLE_MAX_LENGTH = 120;

/**
 * Derive a thread title from a user message's content: the FIRST line only,
 * every run of whitespace collapsed to a single space, edges trimmed, hard
 * cap {@link TITLE_MAX_LENGTH} characters. Pure — the ONE derivation of the
 * title rule; the store rule and its tests both read it from here.
 */
export function deriveThreadTitleFromFirstMessage(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > TITLE_MAX_LENGTH ? collapsed.slice(0, TITLE_MAX_LENGTH) : collapsed;
}

/**
 * Apply the auto-title rule inside the caller's append transaction: when the
 * thread's title is EMPTY and the thread has NO user row yet (this append
 * inserts the first one), derive the title from the incoming content and
 * persist it in the SAME transaction as the message insert (atomic with it,
 * no extra round-trip). A thread that already carries a title (created
 * titled, or renamed by the user before the first message) is never touched,
 * and a LATER user message never re-titles — a title cleared back to ""
 * stays empty for the client's numbered fallback. A whitespace-only first
 * line derives "" and leaves the empty title untouched.
 */
export function applyFirstMessageAutoTitle(tx: DbTransaction, threadId: string, content: string): void {
  const thread = tx
    .select({ title: experienceCopilotThreads.title })
    .from(experienceCopilotThreads)
    .where(eq(experienceCopilotThreads.id, threadId))
    .get();
  if (!thread || thread.title !== '') return;
  const priorUser = tx
    .select({ id: experienceCopilotMessages.id })
    .from(experienceCopilotMessages)
    .where(and(eq(experienceCopilotMessages.threadId, threadId), eq(experienceCopilotMessages.role, 'user')))
    .get();
  if (priorUser !== undefined) return;
  const title = deriveThreadTitleFromFirstMessage(content);
  if (title === '') return;
  tx
    .update(experienceCopilotThreads)
    .set({ title })
    .where(eq(experienceCopilotThreads.id, threadId))
    .run();
}
