/**
 * md_import response parsing — extracted from ai-assistant-stream.ts so the
 * streaming runtime stays under the file-size ratchet.
 *
 * Parses the model output (fenced/braced JSON, partial JSON, or labeled
 * markdown) into the normalized card-field shape, and merges it with the
 * sections of the source markdown the user supplied.
 */

const MD_IMPORT_STRING_FIELDS = ["name", "tagline", "description", "personality", "scenario", "firstMessage", "creatorNotes"] as const;

const MD_IMPORT_FIELD_ALIASES: Record<string, string> = {
  name: "name",
  title: "name",
  character_name: "name",
  card_name: "name",
  tagline: "tagline",
  subtitle: "tagline",
  hook: "tagline",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  firstmessage: "firstMessage",
  first_message: "firstMessage",
  first_message_greeting: "firstMessage",
  greeting: "firstMessage",
  intro: "firstMessage",
  examplemessages: "exampleMessages",
  example_messages: "exampleMessages",
  examples: "exampleMessages",
  mes_example: "exampleMessages",
  creatornotes: "creatorNotes",
  creator_notes: "creatorNotes",
  notes: "creatorNotes",
  author_notes: "creatorNotes",
  alternategreetings: "alternateGreetings",
  alternate_greetings: "alternateGreetings",
  alt_greetings: "alternateGreetings",
  alts: "alternateGreetings",
  additionalcharacters: "additionalCharacters",
  additional_characters: "additionalCharacters",
};

export function hasUsefulMdImportJson(obj: Record<string, unknown>): boolean {
  if (MD_IMPORT_STRING_FIELDS.some((key) => typeof obj[key] === "string" && obj[key].trim().length > 0)) return true;
  if (Array.isArray(obj.exampleMessages) && obj.exampleMessages.length > 0) return true;
  if (Array.isArray(obj.alternateGreetings) && obj.alternateGreetings.length > 0) return true;
  if (Array.isArray(obj.additionalCharacters) && obj.additionalCharacters.length > 0) return true;
  return false;
}

export function extractMdImportObjectFromText(text: string): Record<string, unknown> | null {
  const json = normalizeMdImportObject(extractJsonFromText(text) ?? extractPartialJsonObject(text));
  if (json && hasUsefulMdImportJson(json)) return json;

  const labels = normalizeMdImportObject(extractLabelFieldsFromText(text));
  if (labels && hasUsefulMdImportJson(labels)) return labels;

  return null;
}

export function mergeMdImportWithSourceSections(
  aiFields: Record<string, unknown> | null,
  sourceMarkdown: string,
): Record<string, unknown> | null {
  const sourceFields = extractMdImportSectionsFromSource(sourceMarkdown);
  if (!sourceFields) return aiFields;

  const merged: Record<string, unknown> = { ...(aiFields ?? {}) };
  for (const key of ["tagline", "description", "personality", "scenario", "firstMessage", "exampleMessages", "creatorNotes", "additionalCharacters"]) {
    if (sourceFields[key] != null) merged[key] = sourceFields[key];
  }
  return Object.keys(merged).length ? normalizeMdImportObject(merged) : null;
}

function extractMdImportSectionsFromSource(markdown: string): Record<string, unknown> | null {
  const sections = splitMarkdownSections(markdown);
  if (sections.length === 0) return null;

  const out: Record<string, unknown> = {};
  for (const section of sections) {
    const key = mapMarkdownHeadingToMdImportField(section.title);
    if (!key) continue;
    const content = section.content.trim();
    if (!content) continue;

    if (key === "exampleMessages") out.exampleMessages = splitExampleMessages(content);
    else out[key] = content;
  }

  if (typeof out.personality === "string") {
    const chars = extractAdditionalCharactersFromPersonality(out.personality);
    if (chars.length > 0) out.additionalCharacters = chars;
  }

  return Object.keys(out).length ? out : null;
}

function splitMarkdownSections(markdown: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string[] }> = [];
  let current: { title: string; content: string[] } | null = null;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), content: [] };
      continue;
    }
    if (current) current.content.push(line);
  }
  if (current) sections.push(current);

  return sections.map((section) => ({ title: section.title, content: section.content.join("\n").trim() }));
}

function mapMarkdownHeadingToMdImportField(title: string): string | null {
  const normalized = title
    .trim()
    .replace(/[`'\"]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();

  switch (normalized) {
    case "tagline":
    case "subtitle":
    case "hook":
      return "tagline";
    case "public_bio":
    case "bio":
      return "creatorNotes";
    case "description":
    case "public_description":
      return "description";
    case "personality":
    case "personalities":
    case "character_personality":
      return "personality";
    case "scenario":
    case "scenario_prompt":
    case "setting":
      return "scenario";
    case "first_message":
    case "firstmessage":
    case "greeting":
    case "initial_message":
      return "firstMessage";
    case "mes_example":
    case "example_messages":
    case "example_dialogue":
    case "examples":
      return "exampleMessages";
    case "creator_notes":
    case "creatornotes":
    case "author_notes":
    case "notes":
      return "creatorNotes";
    default:
      return null;
  }
}

function extractAdditionalCharactersFromPersonality(personality: string): Array<{ name: string; description?: string; personality?: string }> {
  const marker = /^\[Character:\s*([^\]]+)\]\s*$/gim;
  const matches = [...personality.matchAll(marker)];
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? personality.length : personality.length;
    const name = match[1].trim();
    const body = personality.slice(start, end).trim();
    const parts = splitBracketSubsections(body);
    const descriptionParts: string[] = [];
    const personalityParts: string[] = [];

    for (const part of parts) {
      const key = part.title.toLowerCase().replace(/\s+/g, "_");
      const rendered = `[${part.title}]\n${part.content}`.trim();
      if (["base", "appearance", "physiology", "anatomy", "backstory", "setting", "relationships"].includes(key)) {
        descriptionParts.push(rendered);
      } else {
        personalityParts.push(rendered);
      }
    }

    return {
      name,
      description: descriptionParts.join("\n\n") || body || undefined,
      personality: personalityParts.join("\n\n") || undefined,
    };
  }).filter((item) => item.name);
}

function splitBracketSubsections(text: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string[] }> = [];
  let current: { title: string; content: string[] } | null = null;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^\[([^\]]+)\]\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), content: [] };
      continue;
    }
    if (current) current.content.push(line);
    else if (line.trim()) {
      current = { title: "Description", content: [line] };
    }
  }
  if (current) sections.push(current);

  return sections
    .map((section) => ({ title: section.title, content: section.content.join("\n").trim() }))
    .filter((section) => section.content);
}

function normalizeMdImportObject(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = normalizeMdImportFieldKey(rawKey);
    if (!key) continue;

    if (MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number])) {
      if (typeof rawValue === "string" && rawValue.trim()) out[key] = rawValue.trim();
      continue;
    }

    if (key === "exampleMessages") {
      if (Array.isArray(rawValue)) {
        const examples = rawValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
        if (examples.length) out.exampleMessages = examples;
      } else if (typeof rawValue === "string" && rawValue.trim()) {
        out.exampleMessages = splitExampleMessages(rawValue);
      }
      continue;
    }

    if (key === "alternateGreetings") {
      if (Array.isArray(rawValue)) {
        const greetings = rawValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
        if (greetings.length) out.alternateGreetings = greetings;
      }
      continue;
    }

    if (key === "additionalCharacters" && Array.isArray(rawValue)) {
      const chars = rawValue
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          name: typeof item.name === "string" ? item.name.trim() : "",
          description: typeof item.description === "string" ? item.description.trim() : undefined,
          personality: typeof item.personality === "string" ? item.personality.trim() : undefined,
        }))
        .filter((item) => item.name);
      if (chars.length) out.additionalCharacters = chars;
    }
  }
  return Object.keys(out).length ? out : null;
}

function normalizeMdImportFieldKey(key: string): string | null {
  const normalized = key
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/[`'\"]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
  return MD_IMPORT_FIELD_ALIASES[normalized] ?? null;
}

/**
 * Extract a JSON object from raw model text.
 * Handles markdown fences, leading/trailing prose, and nested braces.
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try to find JSON inside markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const parsed = tryParseJson(fenceMatch[1]);
    if (parsed) return parsed;
  }

  // Find the outermost { ... } block
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return tryParseJson(text.slice(firstBrace, i + 1));
      }
    }
  }

  // Last resort: try to parse the whole text
  return tryParseJson(text);
}

function extractPartialJsonObject(text: string): Record<string, unknown> | null {
  const firstBrace = text.indexOf("{");
  const source = firstBrace >= 0 ? text.slice(firstBrace) : text;
  const out: Record<string, unknown> = {};

  const completeStringField = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of source.matchAll(completeStringField)) {
    const key = normalizeMdImportFieldKey(match[1]);
    if (key && MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number])) {
      out[key] = decodeJsonStringFragment(match[2]);
    }
  }

  const incompleteStringField = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([\s\S]*)$/;
  const incomplete = source.match(incompleteStringField);
  if (incomplete) {
    const key = normalizeMdImportFieldKey(incomplete[1]);
    if (key && MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number]) && out[key] == null) {
      out[key] = decodeJsonStringFragment(incomplete[2].replace(/[,\s]*$/, ""));
    }
  }

  const exampleArray = source.match(/"(?:exampleMessages|example_messages|examples|mes_example)"\s*:\s*\[([\s\S]*?)\]/i);
  if (exampleArray) {
    const examples = [...exampleArray[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => decodeJsonStringFragment(match[1]).trim())
      .filter(Boolean);
    if (examples.length) out.exampleMessages = examples;
  }

  return Object.keys(out).length ? out : null;
}

function extractLabelFieldsFromText(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let buffer: string[] = [];

  function flush(): void {
    if (!currentKey) return;
    const value = buffer.join("\n").trim();
    if (!value) return;
    if (currentKey === "exampleMessages") out.exampleMessages = splitExampleMessages(value);
    else out[currentKey] = value;
  }

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const colonMatch = line.match(/^#{0,6}\s*[-*•]?\s*\*?\*?([A-Za-z][A-Za-z0-9_\s-]{0,40})\*?\*?\s*:\s*(.*)$/);
    const standaloneKey = line.length <= 48 ? normalizeMdImportFieldKey(line) : null;
    const colonKey = colonMatch ? normalizeMdImportFieldKey(colonMatch[1]) : null;

    if (colonKey) {
      flush();
      currentKey = colonKey;
      buffer = colonMatch?.[2] ? [colonMatch[2]] : [];
      continue;
    }

    if (standaloneKey) {
      flush();
      currentKey = standaloneKey;
      buffer = [];
      continue;
    }

    if (currentKey) buffer.push(rawLine);
  }
  flush();

  return Object.keys(out).length ? out : null;
}

function splitExampleMessages(value: string): string[] {
  const parts = value
    .split(/\n\s*(?:<START>|---|={3,}|#{1,6}\s*Example\b|Example\s*\d+\s*:?)\s*\n/gi)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [value.trim()].filter(Boolean);
}

function decodeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* not valid JSON */ }
  return null;
}
