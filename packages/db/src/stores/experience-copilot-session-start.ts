// New-session creation (AP-20 extraction) — the two "new session" writers
// of experience-copilot-store.ts, moved into their own module when AP-20's
// per-kind auto-compact default would have pushed that file past the
// arch-gate size cap (the ratchet's remedy is extraction, never trimming;
// same precedent as experience-copilot-fork-copy.ts / -auto-title.ts /
// -turn-delete.ts). The store class keeps thin delegating methods so it
// remains the single entry point callers see — the columns written here
// stay owned by the store family, and every write still goes through ONE
// synchronous transaction opened here.

import { and, eq, isNull } from 'drizzle-orm';
import { experienceCopilotThreads } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import type { StoreClock, StoreIdGenerator } from '../persistence.js';
import { mapThread } from './experience-copilot-row-mappers.js';
import type { ExperienceCopilotThread } from './experience-copilot-store.js';

/** The store's collaborators the creation writers need — the fork-copy
 *  pattern: the extracted writer takes the store's own db handle, clock, and
 *  id generator instead of re-deriving them. */
export interface SessionStartDeps {
  db: AppDb;
  clock: StoreClock;
  idGen: StoreIdGenerator;
}

/**
 * "New session": archive the current active thread for this script (if any)
 * and create+return a fresh active one. The archive-then-insert runs inside a
 * single synchronous transaction so two actives can never coexist (the app-
 * level half of the at-most-one-active invariant; the partial unique index is
 * the DB half). AP-20: `autoCompact` seeds the new row's toggle from the
 * script's agent-kind default (the ADAPTER resolves the kind and reads it —
 * packages/db cannot cross the dependency graph into the kind registry);
 * undefined leaves the column default (1 = on), the pre-AP-20 behavior every
 * caller that does not know a kind keeps.
 */
export async function startNewSession(
  deps: SessionStartDeps,
  scriptId: string,
  title?: string,
  autoCompact?: boolean,
): Promise<ExperienceCopilotThread> {
  const now = deps.clock.now();
  const id = deps.idGen.next('expcop_thread');
  deps.db.transaction((tx) => {
    tx
      .update(experienceCopilotThreads)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(experienceCopilotThreads.scriptId, scriptId), isNull(experienceCopilotThreads.archivedAt)))
      .run();
    tx
      .insert(experienceCopilotThreads)
      .values({
        id,
        scriptId,
        draftSessionId: null,
        title: title ?? '',
        archivedAt: null,
        autoCompact: (autoCompact ?? true) ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  const row = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(eq(experienceCopilotThreads.id, id))
    .get();
  return mapThread(row!);
}

/**
 * "New session" for a chat owner (SC-0a): archive the current active sibling
 * thread of the SAME (chat, branch, kind) triple (if any) and create+return a
 * fresh active one — the chat-owner twin of {@link startNewSession}. The kind
 * is required here (store-level enforcement of "agent_kind required when
 * chat_id is set": chat rows are only ever born through this method). Sibling
 * archiving is scoped to the exact triple — other kinds on the same branch,
 * other branches, and script-owned threads are never touched. The
 * archive-then-insert runs inside a single synchronous transaction so two
 * actives can never coexist (the app-level half of the at-most-one-active
 * invariant; the partial unique index on the triple is the DB half). AP-20:
 * `autoCompact` seeds the new row's toggle from this kind's default (the
 * adapter reads it before calling); undefined leaves the column default
 * (1 = on).
 */
export async function startNewChatSession(
  deps: SessionStartDeps,
  chatId: string,
  branchId: string,
  kind: string,
  title?: string,
  autoCompact?: boolean,
): Promise<ExperienceCopilotThread> {
  if (!kind) {
    // Store-level guard: chat-owned rows must never exist with a NULL
    // agent_kind (the partial unique index has no NULL hole to fill).
    throw new Error(`[experience-copilot-store] startNewChatSession requires a non-empty agent kind (chat '${chatId}')`);
  }
  const now = deps.clock.now();
  const id = deps.idGen.next('expcop_thread');
  deps.db.transaction((tx) => {
    tx
      .update(experienceCopilotThreads)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(experienceCopilotThreads.chatId, chatId),
          eq(experienceCopilotThreads.branchId, branchId),
          eq(experienceCopilotThreads.agentKind, kind),
          isNull(experienceCopilotThreads.archivedAt),
        ),
      )
      .run();
    tx
      .insert(experienceCopilotThreads)
      .values({
        id,
        scriptId: null,
        draftSessionId: null,
        chatId,
        branchId,
        agentKind: kind,
        title: title ?? '',
        archivedAt: null,
        autoCompact: (autoCompact ?? true) ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  const row = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(eq(experienceCopilotThreads.id, id))
    .get();
  return mapThread(row!);
}
