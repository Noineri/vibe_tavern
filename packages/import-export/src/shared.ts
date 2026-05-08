import { createHash } from "node:crypto";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip prototype-pollution keys from an arbitrary record.
 * Recursively cleans nested objects. Returns a new plain object.
 */
export function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const v = value[key];
    if (isRecord(v)) {
      result[key] = sanitizeRecord(v);
    } else if (Array.isArray(v)) {
      result[key] = v.map((item) => isRecord(item) ? sanitizeRecord(item) : item);
    } else {
      result[key] = v;
    }
  }
  return result;
}

/**
 * Safely parse JSON, rejecting prototype-pollution keys at every depth.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (typeof key === "string" && DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return value;
  });
}

export function parseJsonInput(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input === "string") {
    const parsed = JSON.parse(input) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Expected a top-level JSON object.");
    }

    return parsed;
  }

  return input;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asOptionalString(value: unknown): string | null {
  const normalized = asString(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? fallback : new Date(timestamp).toISOString();
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "imported-character";
}

export function makeDeterministicId(namespace: string, seed: string): string {
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `${namespace}_${digest}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
