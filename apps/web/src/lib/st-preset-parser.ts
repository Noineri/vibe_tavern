export interface StPresetBlock {
  identifier: string;
  name: string;
  role: "system" | "user" | "assistant";
  content: string;
  injectionPosition: number; // 0=before, 1=in-chat, 2=after
  injectionDepth: number;
  enabled: boolean;
}

export interface ParsedStPreset {
  name: string;
  blocks: StPresetBlock[];
}

interface StPromptEntry {
  identifier: string;
  name?: string;
  role?: string;
  content?: string;
  injection_position?: number;
  injection_depth?: number;
  enabled?: boolean;
}

interface StPromptOrderEntry {
  enabled: boolean;
  order?: number;
  identifier: string;
}

interface StPresetJson {
  name?: string;
  prompts?: StPromptEntry[];
  prompt_order?: Array<Record<string, StPromptOrderEntry[]>>;
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

  // Resolve prompt_order variant 100000 (single-char)
  let orderMap: Map<string, boolean> | null = null;
  if (Array.isArray(data.prompt_order)) {
    const singleChar = data.prompt_order.find((entry) =>
      entry && typeof entry === "object" && "100000" in entry
    ) as Record<string, StPromptOrderEntry[]> | undefined;
    if (singleChar?.["100000"]) {
      orderMap = new Map();
      for (const item of singleChar["100000"]) {
        orderMap.set(item.identifier, item.enabled);
      }
    }
  }

  // Collect non-empty blocks
  const rawBlocks: StPromptEntry[] = data.prompts.filter(
    (p) => p.content?.trim() && p.identifier
  );

  // XML wrapper reconstruction: merge -open / -close pairs
  const merged = mergeXmlWrappers(rawBlocks, orderMap);

  return { name, blocks: merged };
}

function mergeXmlWrappers(
  entries: StPromptEntry[],
  orderMap: Map<string, boolean> | null
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
          role: (e.role as StPresetBlock["role"]) || "system",
          content,
          injectionPosition: e.injection_position ?? 1,
          injectionDepth: e.injection_depth ?? 4,
          enabled: getEnabled(e, orderMap),
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
      role: (e.role as StPresetBlock["role"]) || "system",
      content: e.content ?? "",
      injectionPosition: e.injection_position ?? 1,
      injectionDepth: e.injection_depth ?? 4,
      enabled: getEnabled(e, orderMap),
    });
  }

  return result;
}

function getEnabled(e: StPromptEntry, orderMap: Map<string, boolean> | null): boolean {
  if (orderMap?.has(e.identifier)) {
    return orderMap.get(e.identifier)!;
  }
  return e.enabled !== false;
}
