import { test, expect } from "bun:test";
import { normalizePresetCanvas } from "../src/prompt-canvas.js";
import type { CustomInjection, PromptOrderEntry } from "../src/api-types.js";

const inj = (over: Partial<CustomInjection> = {}): CustomInjection => ({
  identifier: "db_open",
  name: "DB open",
  content: "<database>",
  role: "system",
  ...over,
});

const entry = (over: Partial<PromptOrderEntry>): PromptOrderEntry => ({
  identifier: over.identifier!,
  enabled: over.enabled ?? true,
  order: over.order ?? 0,
  zone: over.zone ?? "before_chat",
  depth: over.depth ?? null,
  kind: over.kind ?? "built_in",
});

test("I2 — strips positional + ST-compat fields from customInjections", () => {
  const legacy = [{
    identifier: "x", name: "X", content: "c", role: "system",
    depth: 4, enabled: true, slot: { zone: "in_chat", depth: 2, order: 3 },
    injectionPosition: 1 as const, injectionOrder: 99, promptOrderIndex: 5,
    promptOrderPlacement: "after_chat" as const,
  }];
  const { customInjections } = normalizePresetCanvas(legacy, []);
  expect(customInjections).toEqual([{
    identifier: "x", name: "X", content: "c", role: "system",
  }]);
});

test("I4 — every custom injection ↔ exactly one kind:custom canvas entry", () => {
  const { customInjections, promptOrder } = normalizePresetCanvas(
    [inj({ identifier: "a" }), inj({ identifier: "b" })],
    [],
  );
  const customEntries = promptOrder.filter((e) => e.kind === "custom");
  expect(customEntries).toHaveLength(2);
  expect(customEntries.map((e) => e.identifier).sort()).toEqual(["a", "b"]);
  expect(customInjections.map((i) => i.identifier).sort()).toEqual(["a", "b"]);
});

test("I4 — drops orphan kind:custom canvas entries (no matching injection)", () => {
  const { promptOrder } = normalizePresetCanvas(
    [inj({ identifier: "a" })],
    [entry({ identifier: "ghost", kind: "custom", zone: "after_chat" })],
  );
  expect(promptOrder.find((e) => e.identifier === "ghost")).toBeUndefined();
});

test("I4 — keeps orphan kind:built_in entries (markers have no injection)", () => {
  const { promptOrder } = normalizePresetCanvas(
    [inj({ identifier: "a" })],
    [entry({ identifier: "worldInfoAfter", kind: "built_in", zone: "after_chat" })],
  );
  expect(promptOrder.find((e) => e.identifier === "worldInfoAfter")).toBeDefined();
});

test("I5 — synthesizes identifier for injections missing one", () => {
  const { customInjections, promptOrder } = normalizePresetCanvas(
    [{ name: "anon", content: "c", role: "user" }],
    [],
  );
  expect(customInjections[0].identifier).toMatch(/^custom_autoid_\d+$/);
  expect(promptOrder.find((e) => e.identifier === customInjections[0].identifier)).toBeDefined();
});

test("slot wins — legacy slot overrides any pre-existing canvas entry", () => {
  const { promptOrder } = normalizePresetCanvas(
    [inj({ identifier: "a" })],
    [],
    // legacy slot on the injection itself
  );
  // (re-test with slot on injection)
  const legacy = [{
    identifier: "a", name: "A", content: "c", role: "system",
    slot: { zone: "in_chat", depth: 3, order: 7 }, enabled: true,
  }];
  const { promptOrder: po2 } = normalizePresetCanvas(legacy, [
    entry({ identifier: "a", zone: "after_chat", order: 0, kind: "custom" }),
  ]);
  const a = po2.find((e) => e.identifier === "a")!;
  expect(a.zone).toBe("in_chat");
  expect(a.depth).toBe(3);
});

test("I6 — order is dense ascending 0,1,2,… within each zone", () => {
  const { promptOrder } = normalizePresetCanvas(
    [inj({ identifier: "a" }), inj({ identifier: "b" }), inj({ identifier: "c" })],
    [
      entry({ identifier: "a", zone: "before_chat", order: 50, kind: "custom" }),
      entry({ identifier: "b", zone: "after_chat", order: 50, kind: "custom" }),
      entry({ identifier: "c", zone: "after_chat", order: 10, kind: "custom" }),
    ],
  );
  const before = promptOrder.filter((e) => e.zone === "before_chat").map((e) => e.order);
  const after = promptOrder.filter((e) => e.zone === "after_chat").map((e) => e.order);
  expect(before).toEqual([0]);
  expect(after).toEqual([0, 1]); // dense, stable (c=10 < b=50 → c=0, b=1)
});

test("D1 — in_chat depth floored at 1; after_chat pinned to 0; before_chat null", () => {
  const { promptOrder } = normalizePresetCanvas(
    [],
    [
      entry({ identifier: "a", zone: "in_chat", depth: 0, kind: "custom" }),
      entry({ identifier: "b", zone: "after_chat", depth: null, kind: "built_in" }),
      entry({ identifier: "c", zone: "before_chat", depth: 5, kind: "built_in" }),
    ],
  );
  // need injections for the in_chat custom entry to survive — redo with injection
  const { promptOrder: po } = normalizePresetCanvas(
    [{ identifier: "a", name: "A", content: "c", role: "system" }],
    [
      entry({ identifier: "a", zone: "in_chat", depth: 0, kind: "custom" }),
      entry({ identifier: "b", zone: "after_chat", depth: null, kind: "built_in" }),
      entry({ identifier: "c", zone: "before_chat", depth: 5, kind: "built_in" }),
    ],
  );
  const a = po.find((e) => e.identifier === "a")!;
  const b = po.find((e) => e.identifier === "b")!;
  const c = po.find((e) => e.identifier === "c")!;
  expect(a.depth).toBe(1); // floored from 0
  expect(b.depth).toBe(0); // pinned
  expect(c.depth).toBeNull(); // before_chat always null
});

test("THE BUG — </database> (after_chat) sorts after worldInfoAfter + dialogueExamples", () => {
  const { promptOrder } = normalizePresetCanvas(
    [{ identifier: "db_close", name: "DB close", content: "</database>", role: "user" }],
    [
      entry({ identifier: "worldInfoAfter", kind: "built_in", zone: "after_chat", order: 80 }),
      entry({ identifier: "dialogueExamples", kind: "built_in", zone: "after_chat", order: 90 }),
      entry({ identifier: "db_close", kind: "custom", zone: "after_chat", order: 95 }),
    ],
  );
  const after = promptOrder.filter((e) => e.zone === "after_chat");
  const closeOrder = after.find((e) => e.identifier === "db_close")!.order;
  const worldOrder = after.find((e) => e.identifier === "worldInfoAfter")!.order;
  const examplesOrder = after.find((e) => e.identifier === "dialogueExamples")!.order;
  expect(closeOrder).toBeGreaterThan(worldOrder);
  expect(closeOrder).toBeGreaterThan(examplesOrder);
  // dense ascending overall
  expect(after.map((e) => e.order)).toEqual([0, 1, 2]);
});

test("I11 — idempotent (re-normalizing a normalized canvas yields the same canvas)", () => {
  const first = normalizePresetCanvas(
    [inj({ identifier: "a" }), inj({ identifier: "b" })],
    [
      entry({ identifier: "a", zone: "before_chat", order: 0, kind: "custom" }),
      entry({ identifier: "b", zone: "after_chat", order: 0, kind: "custom" }),
    ],
  );
  const second = normalizePresetCanvas(first.customInjections, first.promptOrder);
  expect(second).toEqual(first);
});
