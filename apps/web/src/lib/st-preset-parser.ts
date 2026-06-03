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
}

export interface ParsedStPreset {
  name: string;
  blocks: StPresetBlock[];
  promptOrder: StPromptOrderBlock[];
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
}

export function parseStPreset(jsonText: string): ParsedStPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("Could not parse this file as an ST preset.");
  }

  const data = raw as StPresetJson;
  if (!data.prompts || !Array.isArray(data.prompts)) {
    throw new Error("No prompt blocks found in this file.");
  }

  const name = data.name || "Unnamed preset";

  const promptOrder = resolvePromptOrder(data.prompt_order);
  const orderMap = promptOrder?.map ?? null;

  // Collect non-empty blocks
  const rawBlocks: StPromptEntry[] = data.prompts.filter(
    (p) => p.content?.trim() && p.identifier
  );

  // XML wrapper reconstruction: merge -open / -close pairs
  const merged = mergeXmlWrappers(rawBlocks, orderMap);

  return { name, blocks: merged, promptOrder: promptOrder?.entries ?? [] };
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

function resolvePromptOrder(promptOrder: StPromptOrderSet[] | undefined): { map: Map<string, StOrderInfo>; entries: StPromptOrderBlock[] } | null {
  if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;

  const sets = promptOrder
    .map((entry) => ({ id: entry.character_id, order: extractOrderArray(entry) }))
    .filter((entry): entry is { id: number | string | undefined; order: StPromptOrderEntry[] } => Array.isArray(entry.order));

  if (sets.length === 0) return null;

  // ST commonly stores a generic 100000 order and a character-specific 100001 order.
  // The character-specific order contains custom prompt blocks, so prefer the largest
  // non-100000 order when present; otherwise use the largest available order.
  const preferred =
    sets.filter((entry) => String(entry.id) !== "100000").sort((a, b) => b.order.length - a.order.length)[0] ??
    sets.sort((a, b) => b.order.length - a.order.length)[0];

  const chatIndex = preferred.order.findIndex((item) => item.identifier === "chatHistory");
  const map = new Map<string, StOrderInfo>();
  const entries: StPromptOrderBlock[] = [];
  preferred.order.forEach((item, index) => {
    map.set(item.identifier, {
      enabled: item.enabled,
      index,
      ...(chatIndex >= 0 && item.identifier !== "chatHistory"
        ? { placement: index < chatIndex ? "before_chat" : "after_chat" }
        : {}),
    });
    entries.push({
      identifier: item.identifier,
      enabled: item.enabled,
      order: item.order ?? index,
      kind: BUILT_IN_PROMPT_IDENTIFIERS.has(item.identifier) ? "built_in" : "custom",
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
