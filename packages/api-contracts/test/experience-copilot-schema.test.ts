import { describe, test, expect } from "bun:test";
import {
  experienceCopilotTargetSchema,
  experienceCopilotToolOutputSchema,
  experienceCopilotStepSchema,
  experienceCopilotStreamRequestSchema,
  experienceCopilotThreadSchema,
  experienceCopilotMessageSchema,
  experienceCopilotBoundVisualSchema,
} from "../src/schemas/experience-copilot-schema.js";

// ─── ER-4 / ER-6 regression pin (existing schemas unchanged) ──────────────────

describe("experienceCopilotTargetSchema (ER-4, unchanged)", () => {
  test("accepts the two named buffers", () => {
    expect(experienceCopilotTargetSchema.parse("rules")).toBe("rules");
    expect(experienceCopilotTargetSchema.parse("visual")).toBe("visual");
  });
  test("rejects an unknown buffer", () => {
    expect(() => experienceCopilotTargetSchema.parse("greeting")).toThrow();
  });
});

describe("experienceCopilotToolOutputSchema (ER-4, unchanged)", () => {
  test("accepts a full proposal triple", () => {
    const payload = { target: "rules" as const, proposed: "new text", summary: "rewrote" };
    expect(experienceCopilotToolOutputSchema.parse(payload)).toEqual(payload);
  });
  test("rejects a missing field", () => {
    expect(() =>
      experienceCopilotToolOutputSchema.parse({ target: "rules", proposed: "x" }),
    ).toThrow();
  });
});

describe("experienceCopilotStepSchema (ER-5, unchanged)", () => {
  test("accepts the three authoring steps", () => {
    expect(experienceCopilotStepSchema.parse("rules")).toBe("rules");
    expect(experienceCopilotStepSchema.parse("visual")).toBe("visual");
    expect(experienceCopilotStepSchema.parse("test")).toBe("test");
  });
});

describe("experienceCopilotStreamRequestSchema (ER-6, unchanged)", () => {
  test("accepts a minimal request body", () => {
    const payload = { content: "hi", providerProfileId: "p1" };
    expect(experienceCopilotStreamRequestSchema.parse(payload)).toEqual({
      content: "hi",
      providerProfileId: "p1",
    });
  });
});

// ─── ER-7: new thread / message / bound-visual schemas ─────────────────────────

describe("experienceCopilotThreadSchema (ER-7)", () => {
  test("accepts a valid active thread (archivedAt null)", () => {
    const payload = {
      id: "thread_001",
      scriptId: "script_abc",
      draftSessionId: null,
      title: "My experience",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("accepts a valid archived thread (archivedAt ISO)", () => {
    const payload = {
      id: "thread_002",
      scriptId: null,
      draftSessionId: "sess_xyz",
      title: "Old draft",
      archivedAt: "2026-01-03T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    expect(experienceCopilotThreadSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a thread missing the id field", () => {
    expect(() =>
      experienceCopilotThreadSchema.parse({
        scriptId: null,
        draftSessionId: null,
        title: "No id",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  test("rejects a thread with a non-null number for a nullable field", () => {
    expect(() =>
      experienceCopilotThreadSchema.parse({
        id: "thread_003",
        scriptId: 123,
        draftSessionId: null,
        title: "Bad scriptId",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("experienceCopilotMessageSchema (ER-7)", () => {
  test("accepts a valid assistant message (tool fields null)", () => {
    const payload = {
      id: "msg_001",
      threadId: "thread_001",
      role: "assistant",
      content: "Hello!",
      toolCallsJson: null,
      toolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(experienceCopilotMessageSchema.parse(payload)).toEqual(payload);
  });

  test("accepts a valid tool-call message (tool fields present)", () => {
    const payload = {
      id: "msg_002",
      threadId: "thread_001",
      role: "assistant",
      content: "",
      toolCallsJson: '[{"id":"call_1","name":"write_buffer"}]',
      toolCallId: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    expect(experienceCopilotMessageSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a message with createdAt as a number", () => {
    expect(() =>
      experienceCopilotMessageSchema.parse({
        id: "msg_003",
        threadId: "thread_001",
        role: "user",
        content: "hi",
        toolCallsJson: null,
        toolCallId: null,
        createdAt: 1735689600000,
      }),
    ).toThrow();
  });

  test("rejects a message missing the threadId field", () => {
    expect(() =>
      experienceCopilotMessageSchema.parse({
        id: "msg_004",
        role: "user",
        content: "hi",
        toolCallsJson: null,
        toolCallId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("experienceCopilotBoundVisualSchema (ER-7)", () => {
  test("accepts a valid bound-visual descriptor", () => {
    const payload = { id: "vis_001", name: "Battle HUD", kind: "visual" };
    expect(experienceCopilotBoundVisualSchema.parse(payload)).toEqual(payload);
  });

  test("rejects a bound visual missing the kind field", () => {
    expect(() =>
      experienceCopilotBoundVisualSchema.parse({ id: "vis_002", name: "Panel" }),
    ).toThrow();
  });

  test("rejects a bound visual with a non-string name", () => {
    expect(() =>
      experienceCopilotBoundVisualSchema.parse({ id: "vis_003", name: 42, kind: "visual" }),
    ).toThrow();
  });
});
