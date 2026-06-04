import { describe, expect, test } from "bun:test";
import {
  registerMessageSlot,
  resolveMessageSlots,
  type MessageSlotContext,
} from "./message-slot-registry.js";

function ctx(overrides: Partial<MessageSlotContext> = {}): MessageSlotContext {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    messageRole: "assistant",
    variantIndex: 0,
    isStreaming: false,
    extras: {},
    ...overrides,
  };
}

describe("message-slot-registry", () => {
  test("resolves visible slots by slot id, role, and order", () => {
    const cleanupA = registerMessageSlot({
      id: "test-after-content-late",
      slot: "after_content",
      order: 20,
      roles: ["assistant"],
      render: () => null,
    });
    const cleanupB = registerMessageSlot({
      id: "test-after-content-early",
      slot: "after_content",
      order: 10,
      roles: ["assistant"],
      render: () => null,
    });
    const cleanupHidden = registerMessageSlot({
      id: "test-after-content-hidden",
      slot: "after_content",
      visible: () => false,
      render: () => null,
    });
    const cleanupWrongRole = registerMessageSlot({
      id: "test-after-content-user-only",
      slot: "after_content",
      roles: ["user"],
      render: () => null,
    });

    try {
      const slots = resolveMessageSlots("after_content", ctx());
      expect(slots.map((slot) => slot.id)).toContain("test-after-content-early");
      expect(slots.map((slot) => slot.id)).toContain("test-after-content-late");
      expect(slots.findIndex((slot) => slot.id === "test-after-content-early"))
        .toBeLessThan(slots.findIndex((slot) => slot.id === "test-after-content-late"));
      expect(slots.map((slot) => slot.id)).not.toContain("test-after-content-hidden");
      expect(slots.map((slot) => slot.id)).not.toContain("test-after-content-user-only");
    } finally {
      cleanupA();
      cleanupB();
      cleanupHidden();
      cleanupWrongRole();
    }
  });

  test("produces zero slots when every registered descriptor is invisible", () => {
    const cleanup = registerMessageSlot({
      id: "test-before-content-invisible",
      slot: "before_content",
      visible: () => false,
      render: () => null,
    });

    try {
      const slots = resolveMessageSlots("before_content", ctx());
      expect(slots.some((slot) => slot.id === "test-before-content-invisible")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
