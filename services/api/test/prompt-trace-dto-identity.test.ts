import { describe, expect, test } from "bun:test";
import type { PromptTrace } from "@vibe-tavern/db";
import { mapPromptTraceRecord } from "../src/runtime/session/session-runtime-dto.js";

// L1: pure wire mapper, no paths, global mutations, mocks, waits or database.
// The stored identity is the boundary: never infer a swipe from current UI state.
describe("prompt trace wire identity", () => {
  for (const variantId of ["variant-a", null]) {
    test(`preserves the stored generation tuple with variant ${variantId}`, () => {
      const trace: PromptTrace = {
        id: "trace-a", chatId: "chat-a", branchId: "branch-a", messageId: "message-a", variantId,
        model: "model-a", presetName: "preset-a", assembledLayers: [], tokenAccounting: {},
        finalPayload: { messages: [] }, activatedLoreEntries: [], activatedLoreDetail: [],
        retrievedMemories: [], scriptInjections: [], latencyMs: 1, createdAt: "2026-11-04T00:00:00Z",
      };
      const dto = mapPromptTraceRecord(trace);
      expect({ traceId: dto.id, chatId: dto.chatId, branchId: dto.branchId, messageId: dto.messageId, variantId: dto.variantId })
        .toEqual({ traceId: trace.id, chatId: trace.chatId, branchId: trace.branchId, messageId: trace.messageId, variantId });
      expect(dto.finalPayload).toEqual(trace.finalPayload);
    });
  }
});
