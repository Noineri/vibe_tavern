import type {
  CustomInjection,
  PromptOrderEntry,
  PromptPresetDto,
  PromptSlot,
  PromptZone,
} from "@vibe-tavern/domain";
import { DEFAULT_PROMPT_ORDER, inferSlot, slotToStFields } from "@vibe-tavern/domain";

export interface StPresetBlock {
  identifier: string;
  name: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** SillyTavern INJECTION_POSITION: 0 = RELATIVE prompt-order block, 1 = ABSOLUTE depth injection. */
  injectionPosition: 0 | 1;
  injectionDepth: number;
  injectionOrder: number;
  enabled: boolean;
  promptOrderIndex?: number;
  promptOrderPlacement?: "before_chat" | "after_chat";
}

export interface StPromptOrderBlock {
  identifier: string;
  enabled: boolean;
  order?: number;
  kind: "built_in" | "custom";
  zone?: "before_chat" | "after_chat" | "in_chat";
  depth?: number;
}

export function stBlockToCanvasEntry(block: StPromptOrderBlock): PromptOrderEntry {
  if (block.zone) {
    return {
      identifier: block.identifier,
      enabled: block.enabled,
      order: block.order ?? 0,
      kind: block.kind,
      zone: block.zone,
      depth: block.depth ?? null,
    };
  }
  const slot = inferSlot({ order: block.order });
  return {
    identifier: block.identifier,
    enabled: block.enabled,
    order: slot.order,
    kind: block.kind,
    zone: slot.zone,
    depth: slot.depth,
  };
}

/**
 * Synthesize a canvas entry for a custom block that is ABSENT from ST
 * prompt_order. Uses the block's ST-compat fields (injectionPosition /
 * injectionDepth / injectionOrder / promptOrderPlacement) via inferSlot.
 */
export function synthesizeCanvasEntry(block: StPresetBlock): PromptOrderEntry {
  const slot = inferSlot({
    injectionPosition: block.injectionPosition,
    depth: block.injectionDepth,
    placement: block.promptOrderPlacement,
    order: block.injectionOrder,
  });
  return {
    identifier: block.identifier,
    enabled: block.enabled,
    order: slot.order,
    kind: "custom",
    zone: slot.zone,
    depth: slot.depth,
  };
}

export interface ParsedStPreset {
  name: string;
  blocks: StPresetBlock[];
  promptOrder: StPromptOrderBlock[];
  /** Present when the file was exported by Vibe Tavern (the `_vibe_tavern`
   *  extension key). Carries the full VT DTO for lossless VT→VT import. */
  vibeTavern?: VibeTavernPresetExtension;
}

interface StPromptEntry {
  identifier: string;
  name?: string;
  role?: string;
  content?: string;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  enabled?: boolean;
}

interface StPromptOrderEntry {
  enabled: boolean;
  order?: number;
  identifier: string;
}

interface StPromptOrderSet {
  character_id?: number | string;
  order?: StPromptOrderEntry[];
  [key: string]: unknown;
}

interface StOrderInfo {
  enabled: boolean;
  index: number;
  placement?: "before_chat" | "after_chat";
}

interface StPresetJson {
  name?: string;
  prompts?: StPromptEntry[];
  prompt_order?: StPromptOrderSet[];
  _vibe_tavern?: unknown;
}

export function parseStPreset(jsonText: string): ParsedStPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("Could not parse this file as a ST preset.");
  }

  const data = raw as StPresetJson;
  if (!data.prompts || !Array.isArray(data.prompts)) {
    throw new Error("No prompt blocks found in this file.");
  }

  const name = data.name || "Unnamed preset";

  // Build block metadata lookup before resolving order (needed for zone inference)
  const blockMeta = new Map<string, { injectionPosition: number; injectionDepth: number }>();
  for (const b of data.prompts) {
    if (b.identifier) blockMeta.set(b.identifier, {
      injectionPosition: b.injection_position ?? 1,
      injectionDepth: b.injection_depth ?? 0,
    });
  }

  const promptOrderResult = resolvePromptOrder(data.prompt_order, blockMeta);
  const orderMap = promptOrderResult?.map ?? null;

  // Collect non-empty blocks
  const rawBlocks: StPromptEntry[] = data.prompts.filter(
    (p) => p.content?.trim() && p.identifier
  );

  // XML wrapper reconstruction: merge -open / -close pairs
  const merged = mergeXmlWrappers(rawBlocks, orderMap);

  return {
    name,
    blocks: merged,
    promptOrder: promptOrderResult?.entries ?? [],
    vibeTavern: readVibeTavernExtension(data._vibe_tavern),
  };
}

/**
 * Defensively read the `_vibe_tavern` extension. Returns `undefined` when
 * absent or malformed (non-object, or missing the structural arrays). A valid
 * extension must at least carry `customInjections` and `promptOrder` arrays —
 * the fields the import side consumes wholesale. The remaining scalar fields
 * are read defensively by the import consumer (it falls back to ST-projected
 * values per-field when an expected key is absent).
 */
function readVibeTavernExtension(raw: unknown): VibeTavernPresetExtension | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.customInjections) || !Array.isArray(obj.promptOrder)) {
    return undefined;
  }
  return obj as unknown as VibeTavernPresetExtension;
}

function mergeXmlWrappers(
  entries: StPromptEntry[],
  orderMap: Map<string, StOrderInfo> | null
): StPresetBlock[] {
  const byId = new Map<string, StPromptEntry>();
  for (const e of entries) byId.set(e.identifier, e);

  const used = new Set<string>();
  const result: StPresetBlock[] = [];

  for (const e of entries) {
    if (used.has(e.identifier)) continue;

    // Check if this is an XML open tag that has a matching close
    if (e.identifier.endsWith("-open")) {
      const base = e.identifier.replace(/-open$/, "");
      const closeId = `${base}-close`;
      if (byId.has(closeId)) {
        // Merge: open content + close content → wrapped block
        const closeBlock = byId.get(closeId)!;
        const content = `${e.content ?? ""}\n{{original}}\n${closeBlock.content ?? ""}`.trim();
        const name = e.name?.replace(/^<(\w+)>.*/, "<$1>...</$1>") ?? closeBlock.name ?? base;

        used.add(closeId);
        used.add(e.identifier);
        result.push({
          identifier: base,
          name,
          role: normalizeRole(e.role),
          content,
          injectionPosition: normalizeInjectionPosition(e.injection_position),
          injectionDepth: e.injection_depth ?? 4,
          injectionOrder: e.injection_order ?? 100,
          enabled: getEnabled(e, orderMap),
          ...getOrderMeta(e.identifier, orderMap),
        });
        continue;
      }
      // No matching close — treat as standalone
    }

    if (e.identifier.endsWith("-close")) {
      // Close without open (shouldn't happen after merge, but handle)
      if (used.has(e.identifier)) continue;
      // Standalone close — just include
    }

    used.add(e.identifier);
    result.push({
      identifier: e.identifier,
      name: e.name || e.identifier,
      role: normalizeRole(e.role),
      content: e.content ?? "",
      injectionPosition: normalizeInjectionPosition(e.injection_position),
      injectionDepth: e.injection_depth ?? 4,
      injectionOrder: e.injection_order ?? 100,
      enabled: getEnabled(e, orderMap),
      ...getOrderMeta(e.identifier, orderMap),
    });
  }

  return result;
}

const BUILT_IN_PROMPT_IDENTIFIERS = new Set([
  "worldInfoBefore",
  "main",
  "worldInfoAfter",
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription",
  "chatHistory",
  "dialogueExamples",
  "jailbreak",
  "nsfw",
  "enhanceDefinitions",
  "authorsNote",
]);

function resolvePromptOrder(
  promptOrder: StPromptOrderSet[] | undefined,
  blockMeta: Map<string, { injectionPosition: number; injectionDepth: number }>,
): { map: Map<string, StOrderInfo>; entries: StPromptOrderBlock[] } | null {
  if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;

  const sets = promptOrder
    .map((entry) => ({ id: entry.character_id, order: extractOrderArray(entry) }))
    .filter((entry): entry is { id: number | string | undefined; order: StPromptOrderEntry[] } => Array.isArray(entry.order));

  if (sets.length === 0) return null;

  const preferred =
    sets.filter((entry) => String(entry.id) !== "100000").sort((a, b) => b.order.length - a.order.length)[0] ??
    sets.sort((a, b) => b.order.length - a.order.length)[0];

  const chatIndex = preferred.order.findIndex((item) => item.identifier === "chatHistory");
  const map = new Map<string, StOrderInfo>();
  const entries: StPromptOrderBlock[] = [];

  preferred.order.forEach((item, index) => {
    const placement: "before_chat" | "after_chat" | undefined =
      chatIndex >= 0 && item.identifier !== "chatHistory"
        ? (index < chatIndex ? "before_chat" : "after_chat")
        : undefined;

    map.set(item.identifier, {
      enabled: item.enabled,
      index,
      ...(placement ? { placement } : {}),
    });

    const isBuiltIn = BUILT_IN_PROMPT_IDENTIFIERS.has(item.identifier);

    // For custom entries, use block metadata to determine the real zone
    let zone: "before_chat" | "after_chat" | "in_chat" | undefined = placement;
    let depth: number | undefined;

    if (!isBuiltIn) {
      const meta = blockMeta.get(item.identifier) ?? blockMeta.get(item.identifier.replace(/-open$/, ""));
      if (meta && meta.injectionPosition === 1 && meta.injectionDepth > 0) {
        zone = "in_chat";
        depth = meta.injectionDepth;
      }
    }

    entries.push({
      identifier: item.identifier,
      enabled: item.enabled,
      order: item.order ?? index,
      kind: isBuiltIn ? "built_in" : "custom",
      zone,
      depth,
    });
  });

  return { map, entries };
}

function extractOrderArray(entry: StPromptOrderSet): StPromptOrderEntry[] | undefined {
  if (Array.isArray(entry.order)) return entry.order;
  for (const value of Object.values(entry)) {
    if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && "identifier" in item)) {
      return value as StPromptOrderEntry[];
    }
  }
  return undefined;
}

function normalizeRole(role: string | undefined): StPresetBlock["role"] {
  return role === "user" || role === "assistant" ? role : "system";
}

function normalizeInjectionPosition(position: number | undefined): 0 | 1 {
  return position === 0 ? 0 : 1;
}

function getEnabled(e: StPromptEntry, orderMap: Map<string, StOrderInfo> | null): boolean {
  if (orderMap?.has(e.identifier)) {
    return orderMap.get(e.identifier)!.enabled;
  }
  return e.enabled !== false;
}

function getOrderMeta(eIdentifier: string, orderMap: Map<string, StOrderInfo> | null): Pick<StPresetBlock, "promptOrderIndex" | "promptOrderPlacement"> {
  const meta = orderMap?.get(eIdentifier);
  return {
    ...(meta?.index != null ? { promptOrderIndex: meta.index } : {}),
    ...(meta?.placement ? { promptOrderPlacement: meta.placement } : {}),
  };
}

// ─── Export: VT PromptPresetDto → SillyTavern preset JSON ─────────────────────
// The inverse of `parseStPreset`. Emits the ST projection (prompts[] +
// prompt_order) that ST can import and VT can re-import, PLUS a `_vibe_tavern`
// extension key carrying the full VT DTO (minus the dead `bindModel` and
// VT-internal id/timestamps). ST ignores unknown top-level keys, so the
// extension makes VT→VT round-trip lossless without breaking ST interop.
//
// `parseStPreset` detects `_vibe_tavern` and surfaces it (see ParsedStPreset),
// letting the import side prefer it over the lossy ST projection.

/** The VT-only fields embedded under `_vibe_tavern` for lossless VT→VT export. */
export type VibeTavernPresetExtension = Omit<
  PromptPresetDto,
  "id" | "bindModel" | "createdAt" | "updatedAt"
>;

/** Sentinel `character_id` for the exported prompt_order set. Non-`100000` so
 *  `parseStPreset`'s preferred-set selection picks it up directly. */
const EXPORT_CHARACTER_ID = 100001;

const BUILT_IN_BLOCK_NAMES: Record<string, string> = {
  main: "Main Prompt",
  jailbreak: "Jailbreak",
  nsfw: "NSFW Prompt",
  enhanceDefinitions: "Enhance Definitions",
  authorsNote: "Author's Note",
};

interface StPromptEntryOut {
  identifier: string;
  name: string;
  role: "system" | "user" | "assistant";
  content: string;
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
  enabled: boolean;
}

interface StPromptOrderEntryOut {
  identifier: string;
  enabled: boolean;
  order: number;
}

export interface StPresetJsonOut {
  name: string;
  prompts: StPromptEntryOut[];
  prompt_order: Array<{ character_id: number | string; order: StPromptOrderEntryOut[] }>;
  _vibe_tavern: VibeTavernPresetExtension;
}

/**
 * Resolve a PromptSlot for a named/canvas identifier. Prefers the explicit
 * canvas entry; falls back to `DEFAULT_PROMPT_ORDER` so simple-mode presets
 * (whose `promptOrder` is empty — see preset-store emptyDraft) still serialize
 * a complete, valid ST prompt_order.
 */
function resolveSlot(identifier: string, canvas: Map<string, PromptOrderEntry>): PromptSlot {
  const entry = canvas.get(identifier);
  if (entry) return { zone: entry.zone, depth: entry.depth, order: entry.order };
  const defaultOrder = DEFAULT_PROMPT_ORDER[identifier];
  return inferSlot({ order: defaultOrder ?? 0, defaultOrder });
}

/** Authors-note slot: canvas entry wins, else derive from the DTO position fields. */
function resolveAuthorsNoteSlot(dto: PromptPresetDto, canvas: Map<string, PromptOrderEntry>): PromptSlot {
  const entry = canvas.get("authorsNote");
  if (entry) return { zone: entry.zone, depth: entry.depth, order: entry.order };
  if (dto.authorsNotePosition === "in_chat") {
    return { zone: "in_chat", depth: dto.authorsNoteDepth || 4, order: 0 };
  }
  if (dto.authorsNotePosition === "after_chat") {
    return { zone: "after_chat", depth: null, order: 0 };
  }
  return { zone: "before_chat", depth: null, order: DEFAULT_PROMPT_ORDER.authorsNote };
}

/**
 * Build the globally-ordered canvas for the ST `prompt_order` array. Layout:
 * before_chat (sorted) → after_chat (sorted) → in_chat (sorted). chatHistory
 * (order 100) naturally lands at the tail of before_chat, acting as the
 * before/after boundary the ST parser splits on. in_chat blocks are
 * depth-driven (absolute), so their array position is cosmetic.
 */
function globalCanvasOrder(canvas: readonly PromptOrderEntry[]): PromptOrderEntry[] {
  const byZone: Record<PromptZone, PromptOrderEntry[]> = {
    before_chat: [],
    in_chat: [],
    after_chat: [],
  };
  for (const e of canvas) {
    const bucket = byZone[e.zone];
    if (bucket) bucket.push(e);
  }
  for (const zone of ["before_chat", "in_chat", "after_chat"] as const) {
    byZone[zone].sort((a, b) => a.order - b.order);
  }
  return [...byZone.before_chat, ...byZone.after_chat, ...byZone.in_chat];
}

function buildContentBlock(
  identifier: string,
  content: string,
  role: "system" | "user" | "assistant",
  slot: PromptSlot,
  enabled: boolean,
): StPromptEntryOut {
  const st = slotToStFields(slot);
  return {
    identifier,
    name: BUILT_IN_BLOCK_NAMES[identifier] ?? identifier,
    role,
    content,
    injection_position: st.injection_position,
    injection_depth: st.injection_depth,
    injection_order: st.injection_order,
    enabled,
  };
}

/**
 * Serialize a VT prompt preset to a SillyTavern-format preset JSON string.
 *
 * The output is importable by ST directly and by VT (lossless via the
 * `_vibe_tavern` extension). Emits a complete `prompt_order` even when the
 * source preset's `advancedMode` is false (empty canvas) by falling back to
 * `DEFAULT_PROMPT_ORDER`.
 */
export function serializeStPreset(dto: PromptPresetDto): string {
  const canvasMap = new Map<string, PromptOrderEntry>();
  for (const entry of dto.promptOrder) canvasMap.set(entry.identifier, entry);

  // ── prompts[]: content-bearing blocks (named slots + custom injections) ──
  // Empty blocks are skipped — `parseStPreset` filters them anyway, and their
  // enabled state is conveyed via prompt_order, not prompts[].
  const prompts: StPromptEntryOut[] = [];
  if (dto.system.trim()) {
    prompts.push(buildContentBlock("main", dto.system, "system", resolveSlot("main", canvasMap), canvasMap.get("main")?.enabled ?? true));
  }
  if (dto.jailbreak.trim()) {
    prompts.push(buildContentBlock("jailbreak", dto.jailbreak, "system", resolveSlot("jailbreak", canvasMap), canvasMap.get("jailbreak")?.enabled ?? true));
  }
  if (dto.nsfw.trim()) {
    prompts.push(buildContentBlock("nsfw", dto.nsfw, "system", resolveSlot("nsfw", canvasMap), canvasMap.get("nsfw")?.enabled ?? true));
  }
  if (dto.enhanceDefinitions.trim()) {
    prompts.push(buildContentBlock("enhanceDefinitions", dto.enhanceDefinitions, "system", resolveSlot("enhanceDefinitions", canvasMap), canvasMap.get("enhanceDefinitions")?.enabled ?? true));
  }
  if (dto.authorsNote.trim()) {
    prompts.push(buildContentBlock("authorsNote", dto.authorsNote, dto.authorsNoteRole, resolveAuthorsNoteSlot(dto, canvasMap), canvasMap.get("authorsNote")?.enabled ?? true));
  }
  for (const inj of dto.customInjections) {
    if (!inj.content.trim()) continue;
    prompts.push(buildContentBlock(inj.identifier, inj.content, inj.role, resolveSlot(inj.identifier, canvasMap), canvasMap.get(inj.identifier)?.enabled ?? true));
    // Preserve the injection's display name over the generic fallback.
    prompts[prompts.length - 1].name = inj.name || inj.identifier;
  }

  // ── prompt_order: complete, globally-ordered canvas ───────────────────────
  // Simple mode (empty promptOrder) → synthesize the default canvas so export
  // always yields a complete prompt_order (mirrors how simple-mode assembly
  // ranks blocks via DEFAULT_PROMPT_ORDER).
  let canvas: PromptOrderEntry[] = dto.promptOrder;
  if (canvas.length === 0) {
    canvas = Object.entries(DEFAULT_PROMPT_ORDER).map(([identifier, order]) => {
      const slot = inferSlot({ order, defaultOrder: order });
      return {
        identifier,
        enabled: true,
        order,
        zone: slot.zone,
        depth: slot.depth,
        kind: "built_in" as const,
      };
    });
  }
  const ordered = globalCanvasOrder(canvas);
  const orderEntries: StPromptOrderEntryOut[] = ordered.map((entry, index) => ({
    identifier: entry.identifier,
    enabled: entry.enabled,
    order: index,
  }));

  // ── _vibe_tavern: full DTO (minus dead bindModel + VT-internal fields) ────
  const { id: _id, bindModel: _bindModel, createdAt: _ca, updatedAt: _ua, ...extension } = dto;
  void _id; void _bindModel; void _ca; void _ua;

  const out: StPresetJsonOut = {
    name: dto.name,
    prompts,
    prompt_order: [{ character_id: EXPORT_CHARACTER_ID, order: orderEntries }],
    _vibe_tavern: extension,
  };
  return JSON.stringify(out, null, 2);
}
