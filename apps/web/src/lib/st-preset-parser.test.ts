import { test, expect } from "bun:test";
import {
  stBlockToCanvasEntry,
  synthesizeCanvasEntry,
  type StPresetBlock,
  type StPromptOrderBlock,
} from "./st-preset-parser.js";
import { slotToStFields } from "@vibe-tavern/domain";

// ── stBlockToCanvasEntry ───────────────────────────────────────────────────

test("stBlockToCanvasEntry — preserves zone/depth/order/kind when present", () => {
  const block: StPromptOrderBlock = {
    identifier: "worldInfoAfter",
    enabled: true,
    order: 80,
    kind: "built_in",
    zone: "after_chat",
    depth: undefined,
  };
  expect(stBlockToCanvasEntry(block)).toEqual({
    identifier: "worldInfoAfter",
    enabled: true,
    order: 80,
    kind: "built_in",
    zone: "after_chat",
    depth: null,
  });
});

test("stBlockToCanvasEntry — preserves in_chat + depth for absolute custom entries", () => {
  const block: StPromptOrderBlock = {
    identifier: "myrule",
    enabled: true,
    order: 5,
    kind: "custom",
    zone: "in_chat",
    depth: 3,
  };
  const entry = stBlockToCanvasEntry(block);
  expect(entry.zone).toBe("in_chat");
  expect(entry.depth).toBe(3);
  expect(entry.kind).toBe("custom");
});

test("stBlockToCanvasEntry — fills zone via inferSlot when missing", () => {
  const block: StPromptOrderBlock = {
    identifier: "mystery",
    enabled: true,
    order: 5,
    kind: "custom",
    // no zone, no depth
  };
  const entry = stBlockToCanvasEntry(block);
  expect(entry.zone).toMatch(/^(before_chat|after_chat|in_chat)$/);
  expect(entry.depth).toBeNull(); // no ST data → no depth
});

// ── synthesizeCanvasEntry ──────────────────────────────────────────────────

const block = (over: Partial<StPresetBlock>): StPresetBlock => ({
  identifier: "x",
  name: "X",
  role: "system",
  content: "c",
  injectionPosition: 1,
  injectionDepth: 0,
  injectionOrder: 100,
  enabled: true,
  ...over,
});

test("synthesizeCanvasEntry — absolute + depth>0 → in_chat", () => {
  const entry = synthesizeCanvasEntry(block({ injectionPosition: 1, injectionDepth: 4 }));
  expect(entry.zone).toBe("in_chat");
  expect(entry.depth).toBe(4);
  expect(entry.kind).toBe("custom");
});

test("synthesizeCanvasEntry — absolute + depth=0 → after_chat", () => {
  const entry = synthesizeCanvasEntry(block({ injectionPosition: 1, injectionDepth: 0 }));
  expect(entry.zone).toBe("after_chat");
  expect(entry.depth).toBeNull();
});

test("synthesizeCanvasEntry — relative + after_chat placement → after_chat", () => {
  const entry = synthesizeCanvasEntry(block({
    injectionPosition: 0,
    injectionDepth: 0,
    promptOrderPlacement: "after_chat",
    injectionOrder: 95,
  }));
  expect(entry.zone).toBe("after_chat");
  expect(entry.depth).toBeNull();
  expect(entry.order).toBe(95);
});

test("synthesizeCanvasEntry — relative + before_chat placement → before_chat", () => {
  const entry = synthesizeCanvasEntry(block({
    injectionPosition: 0,
    injectionDepth: 0,
    promptOrderPlacement: "before_chat",
  }));
  expect(entry.zone).toBe("before_chat");
});

// ── Round-trip: synthesizeCanvasEntry → slotToStFields is lossless ─────────

test("round-trip — in_chat block survives synthesize → slotToStFields", () => {
  const entry = synthesizeCanvasEntry(block({ injectionPosition: 1, injectionDepth: 7, injectionOrder: 42 }));
  const st = slotToStFields({ zone: entry.zone, depth: entry.depth, order: entry.order });
  expect(st.injection_position).toBe(1);
  expect(st.injection_depth).toBe(7);
  expect(st.injection_order).toBe(42);
});

test("round-trip — after_chat block survives synthesize → slotToStFields", () => {
  const entry = synthesizeCanvasEntry(block({
    injectionPosition: 0,
    promptOrderPlacement: "after_chat",
    injectionOrder: 99,
  }));
  const st = slotToStFields({ zone: entry.zone, depth: entry.depth, order: entry.order });
  expect(st.injection_position).toBe(0);
  expect(st.injection_depth).toBe(0);
  expect(st.injection_order).toBe(99);
});
