import { createHash } from "node:crypto";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
