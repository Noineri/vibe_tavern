import { describe, expect, test } from "bun:test";
import { brandId, type MessageId, type MessageVariant, type MessageVariantId } from "@vibe-tavern/domain";
import type { GenerationBatch, GenerationRecord } from "../../stores/generation-queue-store.js";
import { deriveQueueRows, type RecordQueueRow } from "./queue-rows.js";

const MESSAGE_ID = "message-1";

function variant(id: string, index: number, options?: { selected?: boolean; modelId?: string | null; presetName?: string | null }): MessageVariant {
  return {
    id: brandId<MessageVariantId>(id),
    messageId: brandId<MessageId>(MESSAGE_ID),
    variantIndex: index,
    content: `content-${id}`,
    isSelected: options?.selected ?? false,
    finishReason: "stop",
    modelId: options?.modelId ?? null,
    presetName: options?.presetName ?? null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

function record(id: string, status: GenerationRecord["status"], startVariantPosition: number): GenerationRecord {
  return {
    id,
    messageId: MESSAGE_ID,
    startVariantPosition,
    origin: "queue",
    status,
    model: "provider/queued-model",
    presetName: "Queued preset",
    presetId: null,
  };
}

function batch(variantIdsAtStart: string[]): GenerationBatch {
  return { messageId: MESSAGE_ID, variantIdsAtStart };
}

describe("deriveQueueRows", () => {
  test("owner scenario 1 places finished A before running B and pending C", () => {
    const result = deriveQueueRows({
      variants: [variant("a", 0)],
      selectedVariantIndex: 0,
      batch: batch(["a"]),
      records: [record("b", "running", 1), record("c", "pending", 1)],
    });

    expect(result.folded).toBeNull();
    expect(result.rows.map((row) => row.kind)).toEqual(["finished", "running", "pending"]);
    expect(result.summary).toEqual({ done: 1, failed: 0, running: 1, pending: 1, total: 3 });
  });

  test("owner scenario 2 places finished A/B/C before running D and pending E", () => {
    const result = deriveQueueRows({
      variants: [variant("a", 0), variant("b", 1), variant("c", 2)],
      selectedVariantIndex: 1,
      batch: batch(["a", "b", "c"]),
      records: [record("d", "running", 3), record("e", "pending", 3)],
    });

    expect(result.rows.map((row) => row.kind)).toEqual(["finished", "finished", "finished", "running", "pending"]);
    expect(result.summary).toEqual({ done: 3, failed: 0, running: 1, pending: 1, total: 5 });
  });

  test("folds four pre-batch variants but leaves three and later finished variants in rows", () => {
    const three = deriveQueueRows({
      variants: [variant("a", 0), variant("b", 1), variant("c", 2)],
      selectedVariantIndex: 0,
      batch: batch(["a", "b", "c"]),
      records: [],
    });
    expect(three.folded).toBeNull();
    expect(three.rows.map((row) => row.kind)).toEqual(["finished", "finished", "finished"]);

    const four = deriveQueueRows({
      variants: [variant("a", 0), variant("b", 1), variant("c", 2), variant("d", 3), variant("later", 4)],
      selectedVariantIndex: 4,
      batch: batch(["a", "b", "c", "d"]),
      records: [],
    });
    expect(four.folded?.map((row) => row.item.variantId)).toEqual([
      brandId<MessageVariantId>("a"), brandId<MessageVariantId>("b"), brandId<MessageVariantId>("c"), brandId<MessageVariantId>("d"),
    ]);
    expect(four.rows).toHaveLength(1);
    expect(four.rows[0]).toMatchObject({ kind: "finished", item: { variantId: brandId<MessageVariantId>("later") } });
  });

  test("places stable same-anchor failures between finished variants", () => {
    const firstFailure = record("failed-1", "failed", 1);
    const secondFailure = record("failed-2", "failed", 1);
    const result = deriveQueueRows({
      variants: [variant("a", 0), variant("b", 1)],
      selectedVariantIndex: 0,
      batch: batch(["a"]),
      records: [firstFailure, secondFailure],
    });

    expect(result.rows.map((row) => row.kind)).toEqual(["finished", "failed", "failed", "finished"]);
    expect(result.rows.filter((row): row is RecordQueueRow => row.kind === "failed").map((row) => row.record.id)).toEqual(["failed-1", "failed-2"]);
  });

  test("uses selected array position and shared picker metadata for finished rows", () => {
    const result = deriveQueueRows({
      variants: [
        variant("a", 8, { modelId: "provider/first-model", presetName: "First preset" }),
        variant("b", 3, { selected: true, modelId: "provider/second-model", presetName: null }),
      ],
      selectedVariantIndex: 1,
      batch: batch(["a", "b"]),
      records: [],
    });
    const finished = result.rows.filter((row) => row.kind === "finished");

    expect(finished.map((row) => row.selected)).toEqual([false, true]);
    expect(finished.map((row) => row.item)).toEqual([
      { variantId: brandId<MessageVariantId>("a"), displayIndex: 9, modelLabel: "first-model", presetName: "First preset" },
      { variantId: brandId<MessageVariantId>("b"), displayIndex: 4, modelLabel: "second-model", presetName: null },
    ]);
  });

  test("excludes an arrived partial variant while its record remains running", () => {
    const variants = [variant("a", 0), variant("partial-b", 1)];
    const runningRecord = record("running-b", "running", 1);
    const whileRunning = deriveQueueRows({
      variants,
      selectedVariantIndex: 1,
      batch: batch(["a"]),
      records: [runningRecord],
    });

    expect(whileRunning.rows.map((row) => row.kind)).toEqual(["finished", "running"]);
    expect(whileRunning.rows[0]).toMatchObject({ kind: "finished", item: { variantId: brandId<MessageVariantId>("a") } });
    expect(whileRunning.rows[1]).toMatchObject({ kind: "running", record: { id: "running-b", startVariantPosition: 1 } });
    expect(whileRunning.summary).toEqual({ done: 1, failed: 0, running: 1, pending: 0, total: 2 });

    const afterRunningRecordRemoval = deriveQueueRows({
      variants,
      selectedVariantIndex: 1,
      batch: batch(["a"]),
      records: [],
    });

    expect(afterRunningRecordRemoval.rows.map((row) => row.kind)).toEqual(["finished", "finished"]);
    expect(afterRunningRecordRemoval.rows[1]).toMatchObject({ kind: "finished", item: { variantId: brandId<MessageVariantId>("partial-b") } });
    expect(afterRunningRecordRemoval.summary).toEqual({ done: 2, failed: 0, running: 0, pending: 0, total: 2 });
  });
});
