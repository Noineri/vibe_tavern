import { test, expect } from "bun:test";
import {
  stBlockToCanvasEntry,
  synthesizeCanvasEntry,
  parseStPreset,
  serializeStPreset,
  type StPresetBlock,
  type StPromptOrderBlock,
} from "./st-preset-parser.js";
import { slotToStFields, type PromptOrderEntry, type PromptPresetDto } from "@vibe-tavern/domain";

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

// ── serializeStPreset ───────────────────────────────────────────────────────

function makeOrderEntry(over: Partial<PromptOrderEntry> & Pick<PromptOrderEntry, "identifier">): PromptOrderEntry {
  return {
    enabled: true,
    order: 0,
    zone: "before_chat",
    depth: null,
    kind: "built_in",
    ...over,
  };
}

function makeDto(over: Partial<PromptPresetDto> = {}): PromptPresetDto {
  return {
    id: "preset-1",
    name: "My Preset",
    system: "You are a helpful assistant.",
    jailbreak: "Continue the story.",
    prefill: "{",
    authorsNote: "Focus on pacing.",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    summary: "sum",
    tools: "tls",
    nsfw: "nsfw content",
    enhanceDefinitions: "enhance",
    scriptAiSystemPrompt: "script sys",
    aiAssistantPrompts: '{"greeting":"hi"}',
    customInjections: [],
    promptOrder: [],
    advancedMode: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

test("serializeStPreset — emits name, prompts, prompt_order, and _vibe_tavern", () => {
  const json = serializeStPreset(makeDto());
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed.name).toBe("My Preset");
  expect(Array.isArray(parsed.prompts)).toBe(true);
  expect(Array.isArray(parsed.prompt_order)).toBe(true);
  expect(parsed._vibe_tavern).toBeDefined();
});

test("serializeStPreset — named slots map to the correct ST blocks", () => {
  const json = serializeStPreset(makeDto());
  const out = JSON.parse(json) as { prompts: StPresetBlock[] };
  const ids = out.prompts.map((p) => p.identifier);
  expect(ids).toContain("main");
  expect(ids).toContain("jailbreak");
  expect(ids).toContain("nsfw");
  expect(ids).toContain("enhanceDefinitions");
  expect(ids).toContain("authorsNote");
  const main = out.prompts.find((p) => p.identifier === "main")!;
  expect(main.content).toBe("You are a helpful assistant.");
  expect(main.role).toBe("system");
});

test("serializeStPreset — authorsNote role + in_chat depth are emitted", () => {
  const dto = makeDto({ authorsNoteRole: "user", authorsNoteDepth: 3 });
  const out = JSON.parse(serializeStPreset(dto)) as { prompts: Array<{ identifier: string; role: string; injection_position: number; injection_depth: number }> };
  const note = out.prompts.find((p) => p.identifier === "authorsNote")!;
  expect(note.role).toBe("user");
  // Simple-mode fallback derives in_chat depth from authorsNoteDepth.
  expect(note.injection_position).toBe(1);
  expect(note.injection_depth).toBe(3);
});

test("serializeStPreset — empty named slots are omitted from prompts", () => {
  const dto = makeDto({ system: "   ", nsfw: "" });
  const out = JSON.parse(serializeStPreset(dto)) as { prompts: StPresetBlock[] };
  const ids = out.prompts.map((p) => p.identifier);
  expect(ids).not.toContain("main");
  expect(ids).not.toContain("nsfw");
  expect(ids).toContain("jailbreak");
});

test("serializeStPreset — custom injections become content blocks", () => {
  const dto = makeDto({
    customInjections: [
      { identifier: "rule1", name: "Rule One", content: "Be terse.", role: "system" },
      { identifier: "rule2", name: "Rule Two", content: "No emojis.", role: "user" },
    ],
    promptOrder: [
      makeOrderEntry({ identifier: "rule1", zone: "in_chat", depth: 2, order: 0, kind: "custom" }),
      makeOrderEntry({ identifier: "rule2", zone: "after_chat", depth: null, order: 0, kind: "custom" }),
    ],
    advancedMode: true,
  });
    const out = JSON.parse(serializeStPreset(dto)) as { prompts: Array<{ identifier: string; name: string; injection_position: number; injection_depth: number }> };
  const rule1 = out.prompts.find((p) => p.identifier === "rule1")!;
  expect(rule1.name).toBe("Rule One");
  expect(rule1.injection_position).toBe(1); // in_chat → absolute
  expect(rule1.injection_depth).toBe(2);
  const rule2 = out.prompts.find((p) => p.identifier === "rule2")!;
  expect(rule2.injection_position).toBe(0); // after_chat → relative
});

test("serializeStPreset — prompt_order global layout: before_chat precedes after_chat", () => {
  const dto = makeDto({
    promptOrder: [
      makeOrderEntry({ identifier: "main", zone: "before_chat", order: 0, kind: "built_in" }),
      makeOrderEntry({ identifier: "jailbreak", zone: "after_chat", order: 0, kind: "built_in" }),
      makeOrderEntry({ identifier: "chatHistory", zone: "before_chat", order: 1, kind: "built_in" }),
    ],
    advancedMode: true,
  });
  const out = JSON.parse(serializeStPreset(dto)) as { prompt_order: Array<{ order: Array<{ identifier: string; order: number }> }> };
  const order = out.prompt_order[0].order;
  const ids = order.map((o) => o.identifier);
  expect(ids).toEqual(["main", "chatHistory", "jailbreak"]);
  // `order` field is the global array index.
  expect(order.map((o) => o.order)).toEqual([0, 1, 2]);
});

test("serializeStPreset — simple mode (empty promptOrder) synthesizes a complete default canvas", () => {
  const dto = makeDto({ promptOrder: [], advancedMode: false });
  const out = JSON.parse(serializeStPreset(dto)) as { prompt_order: Array<{ order: Array<{ identifier: string }> }> };
  const ids = new Set(out.prompt_order[0].order.map((o) => o.identifier));
  // Core ST built-in markers must be present so ST accepts the preset.
  for (const marker of ["main", "chatHistory", "jailbreak", "worldInfoBefore", "worldInfoAfter"]) {
    expect(ids.has(marker)).toBe(true);
  }
});

test("serializeStPreset — _vibe_tavern carries the full DTO minus id/timestamps", () => {
  const dto = makeDto();
  const out = JSON.parse(serializeStPreset(dto)) as { _vibe_tavern: Record<string, unknown> };
  const ext = out._vibe_tavern;
  expect(ext.id).toBeUndefined();
  expect(ext.createdAt).toBeUndefined();
  expect(ext.updatedAt).toBeUndefined();
  // VT-only fields survive (these have no ST projection).
  expect(ext.aiAssistantPrompts).toBe('{"greeting":"hi"}');
  expect(ext.scriptAiSystemPrompt).toBe("script sys");
  expect(ext.tools).toBe("tls");
  expect(ext.summary).toBe("sum");
  expect(ext.system).toBe("You are a helpful assistant.");
});

// ── Round-trip: VT → serialize → parse ──────────────────────────────────────

test("round-trip — VT→VT via _vibe_tavern is lossless for every DTO field", () => {
  const dto = makeDto({
    customInjections: [{ identifier: "r", name: "R", content: "c", role: "user" }],
    promptOrder: [makeOrderEntry({ identifier: "r", zone: "in_chat", depth: 5, order: 0, kind: "custom" })],
    advancedMode: true,
  });
  const reparsed = parseStPreset(serializeStPreset(dto));
  expect(reparsed.vibeTavern).toBeDefined();
  const ext = reparsed.vibeTavern!;
  // Every field that survives in the extension is recovered exactly.
  expect(ext.system).toBe(dto.system);
  expect(ext.jailbreak).toBe(dto.jailbreak);
  expect(ext.prefill).toBe(dto.prefill);
  expect(ext.authorsNote).toBe(dto.authorsNote);
  expect(ext.authorsNoteDepth).toBe(dto.authorsNoteDepth);
  expect(ext.authorsNotePosition).toBe(dto.authorsNotePosition);
  expect(ext.authorsNoteRole).toBe(dto.authorsNoteRole);
  expect(ext.summary).toBe(dto.summary);
  expect(ext.tools).toBe(dto.tools);
  expect(ext.nsfw).toBe(dto.nsfw);
  expect(ext.enhanceDefinitions).toBe(dto.enhanceDefinitions);
  expect(ext.scriptAiSystemPrompt).toBe(dto.scriptAiSystemPrompt);
  expect(ext.aiAssistantPrompts).toBe(dto.aiAssistantPrompts);
  expect(ext.advancedMode).toBe(dto.advancedMode);
  expect(ext.customInjections).toEqual(dto.customInjections);
  expect(ext.promptOrder).toEqual(dto.promptOrder);
});

test("round-trip — ST projection recovers named-slot content (lossy on VT-only fields)", () => {
  const dto = makeDto();
  const reparsed = parseStPreset(serializeStPreset(dto));
  const main = reparsed.blocks.find((b) => b.identifier === "main");
  expect(main?.content).toBe("You are a helpful assistant.");
  const jb = reparsed.blocks.find((b) => b.identifier === "jailbreak");
  expect(jb?.content).toBe("Continue the story.");
});

test("round-trip — custom injection in_chat zone survives the ST projection", () => {
  // Custom (non-builtin) entries get their zone overridden from block metadata
  // by the parser, so in_chat depth round-trips for customs (unlike built-ins).
  const dto = makeDto({
    customInjections: [{ identifier: "myrule", name: "My Rule", content: "stay in character", role: "system" }],
    promptOrder: [makeOrderEntry({ identifier: "myrule", zone: "in_chat", depth: 4, order: 0, kind: "custom" })],
    advancedMode: true,
  });
  const reparsed = parseStPreset(serializeStPreset(dto));
  const entry = reparsed.promptOrder.find((e) => e.identifier === "myrule");
  expect(entry?.zone).toBe("in_chat");
  expect(entry?.depth).toBe(4);
});

// ── parseStPreset — _vibe_tavern detection ─────────────────────────────────

test("parseStPreset — surfaces _vibe_tavern when present", () => {
  const json = JSON.stringify({
    name: "X",
    prompts: [{ identifier: "main", name: "Main", role: "system", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
    _vibe_tavern: {
      name: "X", system: "hi", jailbreak: "", prefill: "",
      authorsNote: "", authorsNoteDepth: 4, authorsNotePosition: "in_chat", authorsNoteRole: "system",
      summary: "", tools: "", nsfw: "", enhanceDefinitions: "",
      scriptAiSystemPrompt: "", aiAssistantPrompts: "",
      customInjections: [], promptOrder: [], advancedMode: false,
    },
  });
  const parsed = parseStPreset(json);
  expect(parsed.vibeTavern).toBeDefined();
  expect(parsed.vibeTavern?.system).toBe("hi");
});

test("parseStPreset — vibeTavern is undefined for a plain ST preset", () => {
  const json = JSON.stringify({
    name: "Plain",
    prompts: [{ identifier: "main", name: "Main", role: "system", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
  });
  expect(parseStPreset(json).vibeTavern).toBeUndefined();
});

test("parseStPreset — ignores a malformed _vibe_tavern (non-array promptOrder)", () => {
  const json = JSON.stringify({
    name: "X",
    prompts: [{ identifier: "main", name: "Main", role: "system", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true }],
    _vibe_tavern: { customInjections: [], promptOrder: "not-an-array" },
  });
  expect(parseStPreset(json).vibeTavern).toBeUndefined();
});
