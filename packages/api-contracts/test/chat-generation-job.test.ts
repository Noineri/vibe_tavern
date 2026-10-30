import { expect, test } from "bun:test";
import { CHAT_GENERATION_JOB_STATUSES } from "@vibe-tavern/domain";
import { chatGenerationJobSchema } from "../src/index.js";

const job = { id: "job", chatId: "chat", messageId: "assistant", model: "model", promptPresetId: null, status: "pending" as const, enqueuedAt: 1793314453694 };

test("pending jobs preserve null current-preset semantics and omitted results", () => {
  expect(chatGenerationJobSchema.parse(job)).toEqual(job);
  expect(chatGenerationJobSchema.parse(job)).not.toHaveProperty("variantIndex");
  expect(chatGenerationJobSchema.parse(job)).not.toHaveProperty("error");
});

test("every durable status uses the shared domain vocabulary", () => {
  for (const status of CHAT_GENERATION_JOB_STATUSES) expect(chatGenerationJobSchema.parse({ ...job, status }).status).toBe(status);
  expect(chatGenerationJobSchema.safeParse({ ...job, status: "interrupted" }).success).toBe(false);
});

test("completed and failed results round-trip without requiring a client timeline record", () => {
  const complete = { ...job, promptPresetId: "preset", status: "done" as const, variantIndex: 0 };
  const failed = { ...job, status: "failed" as const, error: "Provider failed", recordId: "timeline-record" };
  expect(chatGenerationJobSchema.parse(complete)).toEqual(complete);
  expect(chatGenerationJobSchema.parse(failed)).toEqual(failed);
});

test("invalid identities, result indexes and enqueue timestamps are rejected", () => {
  for (const field of ["id", "chatId", "messageId", "model", "promptPresetId"] as const)
    expect(chatGenerationJobSchema.safeParse({ ...job, [field]: "" }).success).toBe(false);
  for (const variantIndex of [-1, 0.5, null]) expect(chatGenerationJobSchema.safeParse({ ...job, variantIndex }).success).toBe(false);
  for (const enqueuedAt of [-1, 0.5, "2026-10-30T00:00:00Z", Infinity]) expect(chatGenerationJobSchema.safeParse({ ...job, enqueuedAt }).success).toBe(false);
  expect(chatGenerationJobSchema.safeParse({ ...job, promptPresetId: undefined }).success).toBe(false);
});
