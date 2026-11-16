import { test, expect } from "bun:test";
import {
  stBlockToCanvasEntry,
  synthesizeCanvasEntry,
  parseStPreset,
  serializeStPreset,
  type StPresetBlock,
  type StPromptOrderBlock,
} from "../src/presets/st-preset.js";
import { DEFAULT_PROMPT_ORDER, slotToStFields, type PromptOrderEntry, type PromptPresetDto } from "@vibe-tavern/domain";

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
  expect(entry.zone).toBe("after_chat");
  expect(entry.order).toBe(5);
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
    mergeConsecutiveRoles: false,
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
  const out = JSON.parse(json) as {
    prompts: Array<StPresetBlock & { injection_position?: number; injection_depth?: number }>;
  };
  const byId = new Map(out.prompts.map((p) => [p.identifier, p]));
  expect([...byId.keys()]).toEqual([
    "main",
    "jailbreak",
    "nsfw",
    "enhanceDefinitions",
    "authorsNote",
  ]);
  expect(byId.get("main")).toMatchObject({
    content: "You are a helpful assistant.",
    role: "system",
  });
  expect(byId.get("jailbreak")).toMatchObject({
    content: "Continue the story.",
    role: "system",
  });
  expect(byId.get("nsfw")).toMatchObject({
    content: "nsfw content",
    role: "system",
  });
  expect(byId.get("enhanceDefinitions")).toMatchObject({
    content: "enhance",
    role: "system",
  });
  expect(byId.get("authorsNote")).toMatchObject({
    content: "Focus on pacing.",
    role: "system",
    injection_position: 1,
    injection_depth: 4,
  });
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
  const out = JSON.parse(serializeStPreset(dto)) as {
    prompts: Array<{
      identifier: string;
      name: string;
      content: string;
      role: string;
      injection_position: number;
      injection_depth: number;
    }>;
  };
  const rule1 = out.prompts.find((p) => p.identifier === "rule1")!;
  expect(rule1).toMatchObject({
    name: "Rule One",
    content: "Be terse.",
    role: "system",
    injection_position: 1, // in_chat → absolute
    injection_depth: 2,
  });
  const rule2 = out.prompts.find((p) => p.identifier === "rule2")!;
  expect(rule2).toMatchObject({
    name: "Rule Two",
    content: "No emojis.",
    role: "user",
    injection_position: 0, // after_chat → relative
    injection_depth: 0,
  });
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
  const out = JSON.parse(serializeStPreset(dto)) as {
    prompt_order: Array<{ order: Array<{ identifier: string; enabled: boolean; order: number }> }>;
  };
  const expectedOrder = [
    "main",
    "charSystemPrompt",
    "worldInfoBefore",
    "personaDescription",
    "charDescription",
    "charPersonality",
    "scenario",
    "characterAvatar",
    "characterGallery",
    "personaAvatar",
    "chatSummary",
    "authorsNote",
    "chatDynamicPrompt",
    "charDepthPrompt",
    "enhanceDefinitions",
    "nsfw",
    "worldInfoAfter",
    "dialogueExamples",
    "chatHistory",
    "jailbreak",
    "charPostHistory",
    "assistantPrefill",
  ];
  expect(new Set(expectedOrder)).toEqual(new Set(Object.keys(DEFAULT_PROMPT_ORDER)));
  expect(out.prompt_order[0].order).toEqual(
    expectedOrder.map((identifier, order) => ({ identifier, enabled: true, order })),
  );
});

test("serializeStPreset — _vibe_tavern carries the full DTO minus id/timestamps", () => {
  const dto = makeDto();
  const { id, createdAt, updatedAt, ...expectedExt } = dto;
  void id;
  void createdAt;
  void updatedAt;
  const out = JSON.parse(serializeStPreset(dto)) as { _vibe_tavern: Record<string, unknown> };
  const ext = out._vibe_tavern;
  expect("id" in ext).toBe(false);
  expect("createdAt" in ext).toBe(false);
  expect("updatedAt" in ext).toBe(false);
  expect(ext).toEqual(expectedExt);
});

// ── Round-trip: VT → serialize → parse ──────────────────────────────────────

test("round-trip — VT→VT via _vibe_tavern is lossless for every DTO field", () => {
  const dto = makeDto({
    customInjections: [{ identifier: "r", name: "R", content: "c", role: "user" }],
    promptOrder: [makeOrderEntry({ identifier: "r", zone: "in_chat", depth: 5, order: 0, kind: "custom" })],
    advancedMode: true,
    mergeConsecutiveRoles: true,
    perSendPrefillEnabled: true,
    generationFormat: {
      mode: "manual",
      inputSequence: "<|user|>",
      outputSequence: "<|assistant|>",
    },
  });
  const { id, createdAt, updatedAt, ...expectedExt } = dto;
  void id;
  void createdAt;
  void updatedAt;
  const reparsed = parseStPreset(serializeStPreset(dto));
  expect(reparsed.name).toBe(dto.name);
  expect(reparsed.vibeTavern).toEqual(expectedExt);
});

test("round-trip — promptOrder entry role survives VT→serialize→parse", () => {
  // APC-2b. The entry-level `role` (distinct from a custom injection's content
  // role) must round-trip through the _vibe_tavern extension untouched. The
  // injection's own role is "system" while the entry carries "user" to prove the
  // two are independent fields that both survive.
  const dto = makeDto({
    customInjections: [{ identifier: "r", name: "R", content: "c", role: "system" }],
    promptOrder: [makeOrderEntry({ identifier: "r", zone: "in_chat", depth: 5, order: 0, kind: "custom", role: "user" })],
    advancedMode: true,
  });
  const reparsed = parseStPreset(serializeStPreset(dto));
  const entry = reparsed.vibeTavern!.promptOrder[0]!;
  expect(entry.role).toBe("user");
});

// ── APC-2d: ST block role ↔ canvas entry role (the ST projection path) ──────
// ST stores role on the content block (prompts[].role), not on prompt_order.
// The parser merges a non-default block role onto the matching built-in canvas
// entry; serialize writes a canvas entry's role back onto the ST block (was
// hardcoded "system"). The VT→VT extension path above is already lossless.
test("parseStPreset — built-in block role (user/assistant) merges onto the canvas entry", () => {
  const json = JSON.stringify({
    name: "X",
    prompts: [
      { identifier: "main", name: "Main", role: "user", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true },
      { identifier: "jailbreak", name: "JB", role: "assistant", content: "cont", injection_position: 1, injection_depth: 0, injection_order: 0, enabled: true },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: "main", enabled: true },
      { identifier: "jailbreak", enabled: true },
    ] }],
  });
  const parsed = parseStPreset(json);
  const mainEntry = parsed.promptOrder.find((e) => e.identifier === "main");
  const jbEntry = parsed.promptOrder.find((e) => e.identifier === "jailbreak");
  expect(mainEntry?.role).toBe("user");
  expect(jbEntry?.role).toBe("assistant");
  // and it flows through stBlockToCanvasEntry onto PromptOrderEntry
  const canvas = parsed.promptOrder.map(stBlockToCanvasEntry);
  expect(canvas.find((e) => e.identifier === "main")?.role).toBe("user");
  expect(canvas.find((e) => e.identifier === "jailbreak")?.role).toBe("assistant");
});

test("parseStPreset — default 'system' block role is NOT stored (canvas stays clean)", () => {
  const json = JSON.stringify({
    name: "X",
    prompts: [
      { identifier: "main", name: "Main", role: "system", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
  });
  const parsed = parseStPreset(json);
  expect(parsed.promptOrder[0]?.role).toBeUndefined();
});

test("serializeStPreset — canvas entry role writes onto the ST content block", () => {
  // Was hardcoded "system" for main/jailbreak/nsfw/enhance; authorsNote used the
  // flat authorsNoteRole. Now a canvas entry's role overrides on export.
  const dto = makeDto({
    promptOrder: [
      makeOrderEntry({ identifier: "main", role: "user" }),
      makeOrderEntry({ identifier: "jailbreak", role: "assistant" }),
      makeOrderEntry({ identifier: "authorsNote", role: "user" }),
    ],
  });
  const out = JSON.parse(serializeStPreset(dto)) as { prompts: Array<{ identifier: string; role: string }> };
  expect(out.prompts.find((p) => p.identifier === "main")?.role).toBe("user");
  expect(out.prompts.find((p) => p.identifier === "jailbreak")?.role).toBe("assistant");
  // canvas entry role wins over the flat authorsNoteRole ("system")
  expect(out.prompts.find((p) => p.identifier === "authorsNote")?.role).toBe("user");
});

test("round-trip — ST projection recovers named-slot content (lossy on VT-only fields)", () => {
  const dto = makeDto();
  const reparsed = parseStPreset(serializeStPreset(dto));
  const byId = new Map(reparsed.blocks.map((b) => [b.identifier, b.content]));
  expect(byId.get("main")).toBe("You are a helpful assistant.");
  expect(byId.get("jailbreak")).toBe("Continue the story.");
  expect(byId.get("nsfw")).toBe("nsfw content");
  expect(byId.get("enhanceDefinitions")).toBe("enhance");
  expect(byId.get("authorsNote")).toBe("Focus on pacing.");
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

// ── parseStPreset / serializeStPreset — embedded regex scripts (RX-16) ─────

const REGEX_MAIN_PROMPT = { identifier: "main", name: "Main", role: "system", content: "hi", injection_position: 0, injection_depth: 0, injection_order: 0, enabled: true };
const REGEX_ORDER = [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }];

test("parseStPreset — extracts extensions.regex_scripts with source states preserved", () => {
  const json = JSON.stringify({
    name: "With regex",
    prompts: [REGEX_MAIN_PROMPT],
    prompt_order: REGEX_ORDER,
    extensions: {
      regex_scripts: [
        { scriptName: "Embedded", findRegex: "/<x>.*?<\/x>/g", replaceString: "", disabled: false, placement: [1] },
        { scriptName: "Embedded off", findRegex: "/<y>.*?<\/y>/g", replaceString: "", disabled: true },
      ],
    },
  });
  const parsed = parseStPreset(json);
  expect(parsed.regexScripts).toHaveLength(2);
  expect(parsed.regexScripts[0].name).toBe("Embedded");
  // Source fidelity: each script's own disabled flag comes through verbatim.
  expect(parsed.regexScripts.map((d) => d.disabled)).toEqual([false, true]);
});

test("parseStPreset — top-level regex_scripts is the fallback key", () => {
  const json = JSON.stringify({
    name: "Top-level style",
    prompts: [REGEX_MAIN_PROMPT],
    prompt_order: REGEX_ORDER,
    regex_scripts: [{ scriptName: "Toplevel", findRegex: "/a/g", replaceString: "" }],
  });
  const parsed = parseStPreset(json);
  expect(parsed.regexScripts).toHaveLength(1);
  expect(parsed.regexScripts[0].name).toBe("Toplevel");
});

test("parseStPreset — extensions key wins over top-level when both present", () => {
  const json = JSON.stringify({
    name: "Both",
    prompts: [REGEX_MAIN_PROMPT],
    prompt_order: REGEX_ORDER,
    extensions: { regex_scripts: [{ scriptName: "Nested", findRegex: "/n/g" }] },
    regex_scripts: [{ scriptName: "Flat", findRegex: "/f/g" }],
  });
  expect(parseStPreset(json).regexScripts.map((d) => d.name)).toEqual(["Nested"]);
});

test("parseStPreset — no embedded regex → regexScripts defaults to []", () => {
  const parsed = parseStPreset(JSON.stringify({
    name: "Plain",
    prompts: [REGEX_MAIN_PROMPT],
    prompt_order: REGEX_ORDER,
  }));
  expect(parsed.regexScripts).toEqual([]);
});

test("parseStPreset — malformed regex_scripts degrades to [] without throwing", () => {
  const parsed = parseStPreset(JSON.stringify({
    name: "Broken",
    prompts: [REGEX_MAIN_PROMPT],
    prompt_order: REGEX_ORDER,
    extensions: { regex_scripts: "garbage" },
  }));
  expect(parsed.regexScripts).toEqual([]);
});

test("serializeStPreset — with regexScripts writes ST-readable extensions.regex_scripts", () => {
  const dto = makeDto();
  const rules = [
    {
      name: "Exported on",
      findRegex: "/e/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: true,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      isGlobal: false,
      sortOrder: 0,
      profileId: null,
    },
    {
      name: "Exported off",
      findRegex: "/f/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled: true,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: true,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      isGlobal: false,
      sortOrder: 1,
      profileId: null,
    },
  ];
  const out = JSON.parse(serializeStPreset(dto, rules));
  const scripts = out.extensions?.regex_scripts;
  expect(Array.isArray(scripts)).toBe(true);
  expect(scripts[0].scriptName).toBe("Exported on");
  expect(scripts[0].findRegex).toBe("/e/g");
  // Each rule's own disabled flag is written verbatim (mixed states survive).
  expect(scripts.map((s: { disabled: boolean }) => s.disabled)).toEqual([false, true]);
  // Rule-only fields must not leak into the ST shape.
  expect("sourceScript" in scripts[0]).toBe(false);
  expect("isGlobal" in scripts[0]).toBe(false);

  // Full round-trip: the written preset re-imports with its embedded regex
  // recovered (parser reads the same key the serializer writes) and each
  // rule's enabled/disabled state intact.
  const reparsed = parseStPreset(serializeStPreset(dto, rules));
  expect(reparsed.regexScripts).toHaveLength(2);
  expect(reparsed.regexScripts.map((d) => d.name)).toEqual(["Exported on", "Exported off"]);
  expect(reparsed.regexScripts.map((d) => d.disabled)).toEqual([false, true]);
});

test("serializeStPreset — without the regex param output has no extensions key (backward compat)", () => {
  const out = JSON.parse(serializeStPreset(makeDto()));
  expect(out.extensions).toBeUndefined();
  expect("extensions" in out).toBe(false);
});
