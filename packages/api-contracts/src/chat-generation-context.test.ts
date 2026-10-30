import { expect, test } from "bun:test";
import { chatGenerationContextSchema, type ChatGenerationOperation } from "./chat-generation-context.js";

const identity = { runId: "run", chatId: "chat", branchId: "branch" };

test("all operations preserve the exact run/branch/target identity", () => {
  const operations: ChatGenerationOperation[] = [{ operation: "send", messageId: null }, { operation: "generate", messageId: null },
    { operation: "regenerate", messageId: "assistant" }, { operation: "continue", messageId: "assistant" }];
  for (const operation of operations) {
    const context = { ...identity, ...operation };
    expect(chatGenerationContextSchema.parse(context)).toEqual(context);
  }
});

test("existing-message operations require a target; fresh replies cannot masquerade as variants", () => {
  for (const operation of ["send", "generate", "regenerate", "continue"]) {
    const messageId = operation === "send" || operation === "generate" ? "assistant" : null;
    expect(chatGenerationContextSchema.safeParse({ ...identity, operation, messageId }).success).toBe(false);
  }
  for (const field of ["runId", "chatId", "branchId"] as const) {
    expect(chatGenerationContextSchema.safeParse({ ...identity, [field]: "", operation: "generate", messageId: null }).success).toBe(false);
  }
  expect(chatGenerationContextSchema.safeParse({ ...identity, operation: "unknown", messageId: null }).success).toBe(false);
});
