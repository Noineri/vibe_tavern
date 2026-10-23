// Branch-sidechat fork copy (SIDECHAT_PLAN SC-20) — the store-seam writer
// that copies ONE chat-owned copilot thread onto another branch of the same
// chat. Extracted into its own module when it pushed experience-copilot-
// store.ts past the arch-gate size cap (the ratchet's remedy is extraction,
// never trimming); the store class keeps a thin delegating method so it
// remains the single entry point callers see — the columns it writes
// (experience_copilot_threads / _messages / agent_thread_context_events)
// stay owned by the store family, and every write still goes through ONE
// synchronous transaction opened here.

import { eq } from 'drizzle-orm';
import { experienceCopilotThreads, experienceCopilotMessages, agentThreadContextEvents } from '../db-schema.js';
import type { AppDb, DbTransaction } from '../db-connection.js';
import type { StoreClock, StoreIdGenerator } from '../persistence.js';
import type { AgentThreadContextEventKind } from './agent-thread-context-events.js';
import { mapThread } from './experience-copilot-row-mappers.js';
import type { ExperienceCopilotThread } from './experience-copilot-store.js';

/** What the fork copy does with one source event row (SC-20): a rewritten
 *  `payloadJson` (re-keyed id references), the row's original bytes to copy
 *  as-is (null/unknown/unmodified payload), or `drop` to leave the row out
 *  entirely (its references point past the fork point). The callback is PURE
 *  (a function of `kind` + `payloadJson` only) — the id-remap knowledge
 *  (rp_sync/selection_changed payload shapes) lives in services/api's domain
 *  module, kept out of this package by the same dependency-direction rule as
 *  `applyRpSync`'s `compute` callback. */
export type ForkEventPayloadDecision =
  | { payloadJson: string | null }
  | { drop: true };

/** The pure remap hooks SC-20's fork passes into the copy: per-event payload
 *  decisions, the wholesale target frontier JSON, and the one trailing event
 *  the copy appends after everything it copied (SC-20's `branch_forked
 *  { at }`). */
export interface ForkThreadRemap {
  eventPayload: (kind: AgentThreadContextEventKind, payloadJson: string | null) => ForkEventPayloadDecision;
  frontierJson: (sourceFrontierJson: string | null) => string | null;
  trailingEvent: { kind: AgentThreadContextEventKind; payload: unknown };
}

/** The copy's collaborators — the store's own db handle, clock, and id
 *  generator, plus the store's seq allocator (the ONE derivation of SC-1's
 *  gapless-seq rule; passing it keeps the fork's trailing event on the same
 *  counter appendMessage/appendContextEvent use, instead of a private copy). */
export interface ForkThreadCopyDeps {
  db: AppDb;
  clock: StoreClock;
  idGen: StoreIdGenerator;
  allocateSeq: (tx: DbTransaction, threadId: string, now: string) => number | null;
}

/**
 * Copy ONE chat-owned thread onto another branch of the same chat (SC-20):
 * insert a new thread row owned by `targetBranchId` (same chat + agent kind,
 * ACTIVE, metrics reset to null — the source's numbers stay on the source),
 * bulk-copy its messages and frozen-context events with FRESH ids (seq,
 * createdAt, role/content/tool payloads preserved verbatim; event payloads
 * routed through the pure `remap` hooks so id references can be re-keyed to
 * the target branch's message/variant ids and post-fork-point rows dropped),
 * write the remapped frontier, then append `remap.trailingEvent` with the
 * next allocated seq — all inside ONE synchronous transaction. The caller
 * guarantees the target slot is EMPTY (the fork orchestrator's typed
 * `target_branch_thread_active` refusal fires first, owner 2026-10-21: the
 * UI forks into a freshly created branch); the at-most-one-active partial
 * unique index is the final fail-loud guard if that contract is ever
 * broken — an occupied target makes the insert THROW, never silently
 * replace the existing conversation.
 *
 * contextLinksJson and todoJson copy verbatim (thread-scoped JSON, no
 * message-id references); lastProviderProfileId/lastModel and autoCompact
 * copy too (the compaction fallback pair is the conversation's provenance,
 * not a counter); `nextSeq` copies so the first post-copy append continues
 * the copied timeline's seq sequence. The SOURCE thread is never touched.
 * Returns the new thread row, or null when `sourceThreadId` does not exist.
 * A non-chat-owned source is refused (plain Error, the `startNewChatSession`
 * guard pattern) — the fork orchestrator only passes chat-owned actives.
 */
export async function forkChatThreadToBranch(
  deps: ForkThreadCopyDeps,
  sourceThreadId: string,
  targetBranchId: string,
  remap: ForkThreadRemap,
): Promise<ExperienceCopilotThread | null> {
  // The RAW row (not the mapThread projection): the fork copies JSON columns
  // verbatim as stored strings (links, todo) and reads the raw frontier/
  // next_seq the projection does not expose.
  const sourceRow = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(eq(experienceCopilotThreads.id, sourceThreadId))
    .get();
  if (sourceRow === undefined) return null;
  if (sourceRow.chatId === null || sourceRow.agentKind === null) {
    throw new Error(
      `[experience-copilot-fork-copy] forkChatThreadToBranch requires a chat-owned source thread (got '${sourceThreadId}')`,
    );
  }
  // Narrowed locals — property narrowings do not survive into the transaction
  // closure below (TS conservatively resets them there).
  const sourceChatId: string = sourceRow.chatId;
  const sourceAgentKind: string = sourceRow.agentKind;

  const now = deps.clock.now();
  const newId = deps.idGen.next('expcop_thread');
  deps.db.transaction((tx) => {
    // The target slot is the caller's contract (see the header): no
    // archive-then-insert here — the partial unique index enforces
    // at-most-one-active and THROWS on violation (fail-loud, never a silent
    // replacement of the target's existing conversation).
    tx
      .insert(experienceCopilotThreads)
      .values({
        id: newId,
        scriptId: null,
        draftSessionId: null,
        chatId: sourceChatId,
        branchId: targetBranchId,
        agentKind: sourceAgentKind,
        title: sourceRow.title,
        archivedAt: null,
        // Metrics reset (SC-20): the copy starts with no usage numbers.
        contextMetricsJson: null,
        // Thread-scoped JSON with no message-id references — verbatim bytes.
        contextLinksJson: sourceRow.contextLinksJson,
        todoJson: sourceRow.todoJson,
        lastProviderProfileId: sourceRow.lastProviderProfileId,
        lastModel: sourceRow.lastModel,
        autoCompact: sourceRow.autoCompact,
        // Copied so the first post-copy append continues the copied timeline.
        nextSeq: sourceRow.nextSeq,
        rpFrontierJson: remap.frontierJson(sourceRow.rpFrontierJson),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const messageRows = tx
      .select()
      .from(experienceCopilotMessages)
      .where(eq(experienceCopilotMessages.threadId, sourceThreadId))
      .all();
    const newMessages: (typeof experienceCopilotMessages.$inferInsert)[] = [];
    for (const row of messageRows) {
      newMessages.push({
        id: deps.idGen.next('expcop_msg'),
        threadId: newId,
        role: row.role,
        content: row.content,
        toolCallsJson: row.toolCallsJson,
        toolCallId: row.toolCallId,
        // AP-28: the row's reasoning pair copies verbatim with the rest of
        // the row (a fork keeps the full history, reasoning included).
        reasoning: row.reasoning,
        reasoningDurationMs: row.reasoningDurationMs,
        seq: row.seq,
        createdAt: row.createdAt,
      });
    }
    if (newMessages.length > 0) {
      tx.insert(experienceCopilotMessages).values(newMessages).run();
    }

    const eventRows = tx
      .select()
      .from(agentThreadContextEvents)
      .where(eq(agentThreadContextEvents.threadId, sourceThreadId))
      .all();
    const newEvents: (typeof agentThreadContextEvents.$inferInsert)[] = [];
    for (const row of eventRows) {
      const decision = remap.eventPayload(row.kind as AgentThreadContextEventKind, row.payloadJson);
      if ('drop' in decision) continue;
      newEvents.push({
        id: deps.idGen.next('expcop_evt'),
        threadId: newId,
        seq: row.seq,
        kind: row.kind,
        payloadJson: decision.payloadJson,
        createdAt: row.createdAt,
      });
    }
    // The trailing event rides the SAME transaction with the next seq
    // (allocateSeq reads the just-inserted row's next_seq).
    const trailingSeq = deps.allocateSeq(tx, newId, now);
    newEvents.push({
      id: deps.idGen.next('expcop_evt'),
      threadId: newId,
      seq: trailingSeq,
      kind: remap.trailingEvent.kind,
      payloadJson: JSON.stringify(remap.trailingEvent.payload),
      createdAt: now,
    });
    if (newEvents.length > 0) {
      tx.insert(agentThreadContextEvents).values(newEvents).run();
    }
  });
  const row = await deps.db
    .select()
    .from(experienceCopilotThreads)
    .where(eq(experienceCopilotThreads.id, newId))
    .get();
  return row ? mapThread(row) : null;
}
