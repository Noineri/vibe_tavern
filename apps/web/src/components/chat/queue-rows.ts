import { useShallow } from "zustand/react/shallow";
import type { MessageVariant } from "@vibe-tavern/domain";
import {
  deriveGenerationBatchSummary,
  useGenerationQueueStore,
  type GenerationBatch,
  type GenerationBatchSummary,
  type GenerationRecord,
} from "../../stores/generation-queue-store.js";
import { deriveVariantPickerItems } from "./variants/variant-picker-items.js";
import type { VariantPickerItem } from "./variants/types.js";

const FOLD_THRESHOLD = 3;
const EMPTY_RECORDS: GenerationRecord[] = [];

export type FinishedQueueRow = {
  kind: "finished";
  item: VariantPickerItem;
  selected: boolean;
};

export type RecordQueueRow = {
  kind: "failed" | "running" | "pending";
  record: GenerationRecord;
};

export type QueueRow = FinishedQueueRow | RecordQueueRow;

export type QueueRowsResult = {
  folded: FinishedQueueRow[] | null;
  rows: QueueRow[];
  summary: GenerationBatchSummary;
};

export function deriveQueueRows(input: {
  variants: readonly MessageVariant[];
  selectedVariantIndex: number;
  batch: GenerationBatch | null;
  records: readonly GenerationRecord[];
}): QueueRowsResult {
  if (!input.batch) return emptyQueueRows();

  const targetRecords = input.records.filter((record) => record.messageId === input.batch?.messageId);
  const finished = deriveVariantPickerItems(input.variants).map((item, index) => ({
    kind: "finished" as const,
    item,
    selected: index === input.selectedVariantIndex,
  }));
  const preBatchIds = new Set(input.batch.variantIdsAtStart);
  const preBatchFinished = finished.filter((row) => preBatchIds.has(row.item.variantId));
  const folded = preBatchFinished.length > FOLD_THRESHOLD ? preBatchFinished : null;
  const foldedIds = new Set(folded?.map((row) => row.item.variantId));
  const failedByAnchor = new Map<number, RecordQueueRow[]>();
  for (const record of targetRecords) {
    if (record.status !== "failed") continue;
    const anchored = failedByAnchor.get(record.startVariantPosition) ?? [];
    anchored.push({ kind: "failed", record });
    failedByAnchor.set(record.startVariantPosition, anchored);
  }

  const rows: QueueRow[] = [];
  for (let position = 0; position <= finished.length; position += 1) {
    if (position > 0) {
      const row = finished[position - 1];
      if (!foldedIds.has(row.item.variantId)) rows.push(row);
    }
    const failures = failedByAnchor.get(position);
    if (failures) rows.push(...failures);
  }
  for (const [anchor, failures] of failedByAnchor) {
    if (anchor > finished.length) rows.push(...failures);
  }
  for (const record of targetRecords) {
    if (record.status === "running") rows.push({ kind: "running", record });
  }
  for (const record of targetRecords) {
    if (record.status === "pending") rows.push({ kind: "pending", record });
  }

  return { folded, rows, summary: deriveGenerationBatchSummary(input.variants.length, targetRecords) };
}

/** Store adapter for a message's queue timeline; the derivation above remains pure. */
export function useQueueRows(input: {
  chatId: string | null | undefined;
  variants: readonly MessageVariant[];
  selectedVariantIndex: number;
}): QueueRowsResult {
  const batch = useGenerationQueueStore((state) => (input.chatId ? state.batchesByChat[input.chatId] ?? null : null));
  const records = useGenerationQueueStore(
    useShallow((state) => (input.chatId ? state.recordsByChat[input.chatId] ?? EMPTY_RECORDS : EMPTY_RECORDS)),
  );
  return deriveQueueRows({ variants: input.variants, selectedVariantIndex: input.selectedVariantIndex, batch, records });
}

function emptyQueueRows(): QueueRowsResult {
  return {
    folded: null,
    rows: [],
    summary: { done: 0, failed: 0, running: 0, pending: 0, total: 0 },
  };
}
