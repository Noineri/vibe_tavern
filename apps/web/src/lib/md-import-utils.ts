/**
 * Pure helpers for the AI-assistant modal's "import markdown" flow: the parsed
 * field schema, human-readable field labels, value describing, and the merge
 * semantics that append/concatenate parsed fields onto a partial character draft.
 *
 * Extracted from AiAssistantModal.tsx — see AI_ASSISTANT_GOD_OBJECT_AUDIT.md,
 * finding 2. Pure logic with no JSX dependency; matches the lib/st-persona-parser
 * precedent for parsers/helpers that live outside component files.
 */

export interface MdImportResult {
  name?: string;
  tagline?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
  exampleMessages?: string[];
  creatorNotes?: string;
}

export const MD_IMPORT_FIELD_OPTIONS: Array<{ id: keyof MdImportResult; label: string }> = [
  { id: "name", label: "Name" },
  { id: "tagline", label: "Tagline" },
  { id: "description", label: "Description" },
  { id: "personality", label: "Personality" },
  { id: "scenario", label: "Scenario" },
  { id: "firstMessage", label: "First Message" },
  { id: "alternateGreetings", label: "Alternate Greetings" },
  { id: "exampleMessages", label: "Example Messages" },
  { id: "creatorNotes", label: "Creator Notes" },
];

export function getMdImportFieldLabel(field: keyof MdImportResult): string {
  return MD_IMPORT_FIELD_OPTIONS.find((option) => option.id === field)?.label ?? field;
}

export function describeMdImportValue(value: unknown, _key?: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((item) => typeof item === "string")) {
      const items = value as string[];
      if (items.length === 1) return items[0];
      return items.map((item, i) => `── #${i + 1} ──\n${item}`).join("\n\n");
    }
    return JSON.stringify(value, null, 2);
  }
  return typeof value === "string" ? value : String(value ?? "");
}

export function mergeMdImportFields(
  target: Partial<MdImportResult>,
  key: keyof MdImportResult,
  value: unknown,
): Partial<MdImportResult> {
  if (value == null || value === "") return target;
  if (key === "exampleMessages" && Array.isArray(value)) {
    const incoming = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (incoming.length === 0) return target;
    const existing = Array.isArray(target.exampleMessages) ? target.exampleMessages : [];
    return { ...target, exampleMessages: [...existing, ...incoming] };
  }
  if (key === "alternateGreetings" && Array.isArray(value)) {
    const incoming = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (incoming.length === 0) return target;
    const existing = Array.isArray(target.alternateGreetings) ? target.alternateGreetings : [];
    return { ...target, alternateGreetings: [...existing, ...incoming] };
  }
  if (typeof value === "string" && typeof target[key] === "string" && target[key]) {
    return { ...target, [key]: `${target[key]}

${value}` };
  }
  if (Array.isArray(value)) {
    const text = describeMdImportValue(value).trim();
    if (!text) return target;
    if (typeof target[key] === "string" && target[key]) {
      return { ...target, [key]: `${target[key]}

${text}` };
    }
    return { ...target, [key]: text as never };
  }
  return { ...target, [key]: value as never };
}
