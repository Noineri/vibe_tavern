// Chat-owner thread listings — extracted from experience-copilot-store.ts
// when DR-12's `listActiveChatThreadsForPair` pushed that file past the
// arch-gate size cap (the ratchet's remedy is extraction, never trimming;
// same precedent as experience-copilot-session-start.ts / -fork-copy.ts /
// -auto-title.ts / -turn-delete.ts). The store class keeps thin delegating
// methods so it remains the single entry point callers see — the columns
// read here stay owned by the store family.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { experienceCopilotThreads } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { mapThread } from './experience-copilot-row-mappers.js';
import type { ExperienceCopilotThread } from './experience-copilot-store.js';

/** The store's collaborators the listings need — the fork-copy pattern: the
 * extracted reader takes the store's own db handle instead of re-deriving
 * it. */
export interface ChatThreadListingsDeps {
  db: AppDb;
}

/** Active + archived chat-owned threads for a (chat, branch, kind) triple,
 *  newest first — the chat-owner twin of the store's `listSessions`. Scoped
 *  to the exact triple: other kinds on the same branch, other branches of
 *  the same chat, and script-owned sessions never appear. */
export async function listSessionsForChat(
  deps: ChatThreadListingsDeps,
  chatId: string,
  branchId: string,
  kind: string,
): Promise<ExperienceCopilotThread[]> {
  const rows = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(
      and(
        eq(experienceCopilotThreads.chatId, chatId),
        eq(experienceCopilotThreads.branchId, branchId),
        eq(experienceCopilotThreads.agentKind, kind),
      ),
    )
    .orderBy(desc(experienceCopilotThreads.updatedAt), desc(experienceCopilotThreads.createdAt))
    .all();
  return rows.map((r) => mapThread(r));
}

/** Every ACTIVE (unarchived) chat-owned thread on one branch, across ALL
 *  agent kinds, oldest first (createdAt, then id as tiebreaker). Kinds are
 *  NEVER enumerated by the caller — whatever kinds have active threads on
 *  the branch are what this returns. Script/draft rows never match. */
export async function listActiveChatThreadsForBranch(
  deps: ChatThreadListingsDeps,
  chatId: string,
  branchId: string,
): Promise<ExperienceCopilotThread[]> {
  const rows = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(
      and(
        eq(experienceCopilotThreads.chatId, chatId),
        eq(experienceCopilotThreads.branchId, branchId),
        isNull(experienceCopilotThreads.archivedAt),
      ),
    )
    .orderBy(asc(experienceCopilotThreads.createdAt), asc(experienceCopilotThreads.id))
    .all();
  return rows.map((r) => mapThread(r));
}

/** Every ACTIVE (unarchived) chat-owned thread of one (chat, kind) pair,
 *  across ALL branches, oldest first — DR-12's profile-switch separator
 *  writes into every live feed the pair has (the assignment is chat-wide;
 *  archived feeds never move, they are history). Script/draft rows never
 *  match. */
export async function listActiveChatThreadsForPair(
  deps: ChatThreadListingsDeps,
  chatId: string,
  kind: string,
): Promise<ExperienceCopilotThread[]> {
  const rows = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(
      and(
        eq(experienceCopilotThreads.chatId, chatId),
        eq(experienceCopilotThreads.agentKind, kind),
        isNull(experienceCopilotThreads.archivedAt),
      ),
    )
    .orderBy(asc(experienceCopilotThreads.createdAt), asc(experienceCopilotThreads.id))
    .all();
  return rows.map((r) => mapThread(r));
}
