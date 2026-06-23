/**
 * Vibe Tavern Format — `instructions.json` codec.
 *
 * `instructions.json` holds the FUNCTIONAL instruction fields of a character —
 * behavioral directives to the model that occupy a specific injection slot, as
 * opposed to the authored PROSE in `profile.md`. V3 snake_case field names;
 * `depth_prompt` is a nested object. Canonical deep-sorted JSON (same
 * convention as `extensions.json`); empty fields are omitted on write.
 *
 * Routing contract (key → Character field → canvas slot):
 *  - `system_prompt`              → `systemPrompt`              → `character_system_prompt`
 *  - `post_history_instructions`  → `postHistoryInstructions`   → `post_history_instructions`
 *  - `depth_prompt.prompt`        → `depthPrompt`               → `depth_prompt` (depth-injected)
 *  - `depth_prompt.depth`         → `depthPromptDepth`
 *  - `depth_prompt.role`          → `depthPromptRole`
 *
 * Round-trip invariants (pinned by `instructions.test.ts`):
 *  - `write → read → write` is byte-identical.
 *  - Empty/null fields are omitted on write; absent keys read back as null.
 *  - Malformed/missing JSON reads back as all-null fields (never throws).
 */

/** The functional instruction fields sourced from `instructions.json`. */
export interface VtfInstructions {
  /** `system_prompt`. */
  systemPrompt: string | null;
  /** `post_history_instructions`. */
  postHistoryInstructions: string | null;
  /** `depth_prompt.prompt`. */
  depthPrompt: string | null;
  /** `depth_prompt.depth`. */
  depthPromptDepth: number | null;
  /** `depth_prompt.role`. */
  depthPromptRole: string | null;
}

/** An empty instructions set (all fields null). */
export const EMPTY_INSTRUCTIONS: VtfInstructions = {
  systemPrompt: null,
  postHistoryInstructions: null,
  depthPrompt: null,
  depthPromptDepth: null,
  depthPromptRole: null,
};

/**
 * Serialize instruction fields to canonical `instructions.json` text.
 * Empty/null fields are omitted. Deep-sorted keys, 2-space indent, trailing
 * newline. An all-empty set canonicalizes to `{}\n`.
 */
export function writeInstructions(fields: VtfInstructions): string {
  const obj: Record<string, unknown> = {};
  if (nonEmpty(fields.systemPrompt)) obj.system_prompt = fields.systemPrompt;
  if (nonEmpty(fields.postHistoryInstructions)) obj.post_history_instructions = fields.postHistoryInstructions;
  const depthObj = buildDepthPrompt(fields);
  if (depthObj) obj.depth_prompt = depthObj;
  return canonicalJson(obj);
}

/**
 * Parse `instructions.json` text into instruction fields. Tolerant of missing
 * or malformed JSON (returns all-null fields, never throws).
 */
export function readInstructions(jsonText: string): VtfInstructions {
  const parsed = safeParseObject(jsonText);
  const depth = isRecord(parsed.depth_prompt) ? parsed.depth_prompt : {};
  return {
    systemPrompt: stringOr(parsed.system_prompt),
    postHistoryInstructions: stringOr(parsed.post_history_instructions),
    depthPrompt: stringOr(depth.prompt),
    depthPromptDepth: numberOr(depth.depth),
    depthPromptRole: stringOr(depth.role),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty trimmed string (drives field omission on write). */
function nonEmpty(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

/** Build the nested `depth_prompt` object, or null when every field is null. */
function buildDepthPrompt(fields: VtfInstructions): Record<string, unknown> | null {
  const obj: Record<string, unknown> = {};
  if (nonEmpty(fields.depthPrompt)) obj.prompt = fields.depthPrompt;
  if (fields.depthPromptDepth !== null) obj.depth = fields.depthPromptDepth;
  if (fields.depthPromptRole !== null) obj.role = fields.depthPromptRole;
  return Object.keys(obj).length > 0 ? obj : null;
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeParseObject(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Canonical JSON: deep-sorted keys, 2-space indent, no trailing spaces, single
 * trailing newline. Deterministic regardless of insertion order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}
