import { describe, expect, test } from "vitest";
import {
  registerMessageMeta,
  resolveMessageMeta,
  getMessageMetas,
  type MessageMetaContext,
} from "./message-meta-registry.js";

function ctx(overrides: Partial<MessageMetaContext> = {}): MessageMetaContext {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    messageRole: "assistant",
    variant: {
      id: "var-1" as never,
      messageId: "msg-1" as never,
      variantIndex: 0,
      content: "",
      isSelected: true,
      finishReason: null,
      modelId: "anthropic/claude-sonnet-4",
      presetName: "Default",
      coauthorModuleId: null,
      coauthorSkillId: null,
      createdAt: "2026-07-08T00:00:00.000Z" as never,
    },
    variantIndex: 0,
    isStreaming: false,
    isCoauthorTurn: false,
    presetName: null,
    tokenCount: 0,
    createdAt: "2026-07-08T00:00:00.000Z",
    diceRolls: [],
    ...overrides,
  };
}

describe("message-meta-registry", () => {
  test("resolves visible badges by role and order", () => {
    const cleanupA = registerMessageMeta({
      id: "test-meta-late",
      order: 20,
      roles: ["assistant"],
      render: () => null,
    });
    const cleanupB = registerMessageMeta({
      id: "test-meta-early",
      order: 10,
      roles: ["assistant"],
      render: () => null,
    });
    const cleanupHidden = registerMessageMeta({
      id: "test-meta-hidden",
      visible: () => false,
      render: () => null,
    });
    const cleanupWrongRole = registerMessageMeta({
      id: "test-meta-user-only",
      roles: ["user"],
      render: () => null,
    });

    try {
      const metas = resolveMessageMeta(ctx());
      expect(metas.map((m) => m.id)).toContain("test-meta-early");
      expect(metas.map((m) => m.id)).toContain("test-meta-late");
      // order ascending: early before late
      expect(metas.findIndex((m) => m.id === "test-meta-early"))
        .toBeLessThan(metas.findIndex((m) => m.id === "test-meta-late"));
      // hidden + wrong-role filtered out
      expect(metas.map((m) => m.id)).not.toContain("test-meta-hidden");
      expect(metas.map((m) => m.id)).not.toContain("test-meta-user-only");
    } finally {
      cleanupA();
      cleanupB();
      cleanupHidden();
      cleanupWrongRole();
    }
  });

  test("visible predicate can read ctx.variant (variant-scoped provenance)", () => {
    let seenModelId: string | null | undefined = undefined;
    const cleanup = registerMessageMeta({
      id: "test-meta-provenance-probe",
      roles: ["assistant"],
      visible: (c) => !!c.variant?.modelId,
      render: (c) => {
        seenModelId = c.variant?.modelId;
        return null;
      },
    });

    try {
      // variant present with modelId → visible, render sees the modelId
      let metas = resolveMessageMeta(ctx());
      expect(metas.map((m) => m.id)).toContain("test-meta-provenance-probe");
      // trigger render by re-resolving (render is called by the shell, not resolve)
      metas.find((m) => m.id === "test-meta-provenance-probe")!.render(ctx());
      expect(seenModelId).toBe("anthropic/claude-sonnet-4");

      // variant without modelId → filtered out
      metas = resolveMessageMeta(ctx({
        variant: { ...ctx().variant!, modelId: null },
      }));
      expect(metas.map((m) => m.id)).not.toContain("test-meta-provenance-probe");

      // no variant at all → filtered out
      metas = resolveMessageMeta(ctx({ variant: null }));
      expect(metas.map((m) => m.id)).not.toContain("test-meta-provenance-probe");
    } finally {
      cleanup();
    }
  });

  test("produces zero badges when every registered descriptor is invisible", () => {
    const cleanup = registerMessageMeta({
      id: "test-meta-invisible",
      visible: () => false,
      render: () => null,
    });

    try {
      const metas = resolveMessageMeta(ctx());
      expect(metas.some((m) => m.id === "test-meta-invisible")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("registering the same id replaces (last-write-wins, idempotent re-register)", () => {
    const cleanupA = registerMessageMeta({
      id: "test-meta-duplicate",
      order: 99,
      render: () => "A",
    });
    const cleanupB = registerMessageMeta({
      id: "test-meta-duplicate",
      order: 1,
      render: () => "B",
    });

    try {
      const metas = getMessageMetas();
      const matching = metas.filter((m) => m.id === "test-meta-duplicate");
      expect(matching).toHaveLength(1); // replaced, not duplicated
      // re-register preserved (cleanupA's descriptor was replaced in-place)
      expect(matching[0].order).toBe(1);
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  test("unsubscribe removes the badge", () => {
    const cleanup = registerMessageMeta({
      id: "test-meta-transient",
      render: () => null,
    });
    cleanup();
    const metas = resolveMessageMeta(ctx());
    expect(metas.map((m) => m.id)).not.toContain("test-meta-transient");
  });
});
