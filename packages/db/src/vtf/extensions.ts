/**
 * Vibe Tavern Format — `extensions.json` codec.
 *
 * `extensions.json` is the lossless home for every character field that does
 * NOT have a dedicated `profile.md` section or frontmatter key: ST/V3
 * `talkativeness`, `fav`, `world`, a nested `depth_prompt` duplicate, the V2
 * `character_book` lorebook blob, and any future/unknown keys a card may carry.
 *
 * Two keys are special-cased because they ALSO live in `profile.md` frontmatter:
 * `creator` and `character_version`. On write they are STRIPPED from the JSON
 * (their source of truth is the frontmatter); on read they are re-merged from
 * the parsed frontmatter so the in-memory `Character.extensions` looks whole
 * again. Round-tripping either way is lossless.
 *
 * Canonical emission: deep-sorted keys, 2-space indent, trailing newline — so
 * `write → read → write` is byte-identical regardless of the input key order.
 */

// ───────────────────────────────────────────────────────────────────────────
// Inlined prototype-pollution-safe record helpers (db layer cannot import
// from the import-export package; these are the pure helpers we need).
// ───────────────────────────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip prototype-pollution keys recursively (mirrors import-export/shared.ts). */
function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const v = value[key];
    if (isRecord(v)) {
      result[key] = sanitizeRecord(v);
    } else if (Array.isArray(v)) {
      result[key] = v.map((item) => (isRecord(item) ? sanitizeRecord(item) : item));
    } else {
      result[key] = v;
    }
  }
  return result;
}

/** Keys that live in `profile.md` frontmatter, not in `extensions.json`. */
export const FRONTMATTER_OWNED_KEYS = ["creator", "character_version"] as const;
const FRONTMATTER_OWNED_SET = new Set<string>(FRONTMATTER_OWNED_KEYS);

/** Frontmatter values read back into `extensions` on load. */
export interface ExtensionsFrontmatter {
  creator: string | null;
  characterVersion: string | null;
}

/**
 * Serialize an extensions blob to canonical `extensions.json` text.
 *
 * Strips {@link FRONTMATTER_OWNED_KEYS} (their source of truth is the
 * frontmatter). Deep-sorts keys for byte-stable output. Returns the canonical
 * text with a trailing newline; an empty blob canonicalizes to `{}\n`.
 */
export function writeExtensions(extensions: Record<string, unknown>): string {
  const stripped = stripFrontmatterOwned(sanitizeRecord(extensions));
  return canonicalJson(stripped);
}

/**
 * Parse `extensions.json` text and re-merge the frontmatter-owned keys from
 * their canonical source. Unknown JSON shapes are tolerated (an empty/non-object
 * file yields an empty record, never throws).
 */
export function readExtensions(
  jsonText: string,
  frontmatter: ExtensionsFrontmatter,
): Record<string, unknown> {
  const parsed = safeParseObject(jsonText);
  const merged = sanitizeRecord(parsed);
  if (frontmatter.creator !== null) merged.creator = frontmatter.creator;
  if (frontmatter.characterVersion !== null) merged.character_version = frontmatter.characterVersion;
  return merged;
}

/** True if a key is owned by the frontmatter (and therefore stripped on write). */
export function isFrontmatterOwned(key: string): boolean {
  return FRONTMATTER_OWNED_SET.has(key);
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

function stripFrontmatterOwned(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (FRONTMATTER_OWNED_SET.has(key)) continue;
    result[key] = record[key];
  }
  return result;
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
