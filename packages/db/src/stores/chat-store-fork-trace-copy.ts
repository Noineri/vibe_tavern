import { and, eq, inArray } from 'drizzle-orm';
import { promptTraces } from '../db-schema.js';
import type { DbTransaction } from '../db-connection.js';
import type { StoreIdGenerator } from '../persistence.js';

/**
 * Copy prompt_traces for a forked message range into the new branch
 * (extracted from ChatStore.forkBranch — chat-store.ts).
 *
 * Only traces whose messageId was just copied (position <= fork point) are
 * duplicated; traces for messages after the fork stay in the source branch.
 * messageId is remapped via `msgIdMap`; every other column (JSON blobs,
 * scalars, createdAt) is copied verbatim so the fork's trace history matches
 * the parent up to the cut. New ids + the new branchId are assigned to keep
 * rows independent. Fixes the defect where a forked branch started with zero
 * trace history.
 *
 * Must run INSIDE the fork's transaction callback: a failure rolls the whole
 * fork (messages + variants + traces) back together.
 */
export function copyForkPromptTraces(
  tx: DbTransaction,
  options: {
    idGen: StoreIdGenerator;
    chatId: string;
    newBranchId: string;
    sourceBranchId: string;
    /** oldMsgId → newMsgId, built by the message-copy loop. */
    msgIdMap: Map<string, string>;
    /** SC-23b: oldVariantId → newVariantId, built by the variant-copy loop.
     *  A source trace with no variant link (greeting/legacy/unresolved)
     *  copies as null — never the parent branch's variant row. */
    variantIdMap: Map<string, string>;
  },
): void {
  const { idGen, chatId, newBranchId, sourceBranchId, msgIdMap, variantIdMap } = options;
  if (msgIdMap.size === 0) return;

  const tracesToCopy = tx.select().from(promptTraces)
    .where(and(
      eq(promptTraces.branchId, sourceBranchId),
      inArray(promptTraces.messageId, [...msgIdMap.keys()]),
    ))
    .all();

  if (tracesToCopy.length === 0) return;

  const newTraces: Array<typeof promptTraces.$inferInsert> = [];
  for (const t of tracesToCopy) {
    const newMessageId = msgIdMap.get(t.messageId);
    // Defensive: the WHERE clause (messageId IN msgIdMap.keys()) guarantees
    // membership, but guard anyway rather than assert.
    if (!newMessageId) continue;
    newTraces.push({
      id: idGen.next('trace'),
      chatId,
      branchId: newBranchId,
      messageId: newMessageId,
      // SC-23b: remap through variantIdMap.
      variantId: t.variantId ? variantIdMap.get(t.variantId) ?? null : null,
      model: t.model,
      presetName: t.presetName,
      assembledLayersJson: t.assembledLayersJson,
      tokenAccountingJson: t.tokenAccountingJson,
      finalPayloadJson: t.finalPayloadJson,
      activatedLoreEntriesJson: t.activatedLoreEntriesJson,
      activatedLoreDetailJson: t.activatedLoreDetailJson,
      retrievedMemoriesJson: t.retrievedMemoriesJson,
      scriptInjectionsJson: t.scriptInjectionsJson,
      prefill: t.prefill,
      compactionSummary: t.compactionSummary,
      latencyMs: t.latencyMs,
      sentConfigJson: t.sentConfigJson,
      providerResponseJson: t.providerResponseJson,
      createdAt: t.createdAt,
    });
  }
  if (newTraces.length > 0) {
    tx.insert(promptTraces).values(newTraces).run();
  }
}
