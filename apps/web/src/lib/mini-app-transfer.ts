/**
 * Mini-app transfer bundle: export/import of an interactive experience
 * (rules script + its bound visuals) as a single portable JSON file.
 *
 * A mini-app in the DB is a `scripts` row (scriptKind "interactive") plus the
 * visuals bound to it via the `script_visuals` junction (BE-5/BE-6). The
 * bundle captures exactly that pair — plus which visual was the primary
 * (`default_visual_id`) — while staying import-safe: no ids travel (fresh
 * ones are generated on import), no sourceHash (recomputed by the server),
 * no scope ownership (the importer picks the scope at import time).
 *
 * Design notes:
 * - Validation is a discriminated union, not thrown strings: the UI maps
 *   `reason` to an i18n key, keeping this module locale-free.
 * - Import order matters: the default visual is bound FIRST — the store's
 *   `bindVisual` promotes the first binding to `default_visual_id` when the
 *   script has none (see script-store.ts), so binding order alone restores
 *   the exported primary without a separate update call.
 * - Name collisions get a suffix ("(import)") rather than an error: import
 *   is idempotent-by-intent (re-importing duplicates, never overwrites).
 */

import type { ScriptRecord, ExperienceVisualRow } from "../api/types.js";

export const MINI_APP_BUNDLE_FORMAT = "vt-miniapp" as const;
export const MINI_APP_BUNDLE_VERSION = 1 as const;

export interface MiniAppBundle {
  format: typeof MINI_APP_BUNDLE_FORMAT;
  version: typeof MINI_APP_BUNDLE_VERSION;
  exportedAt: string;
  script: {
    name: string;
    description: string;
    code: string;
    enabled: boolean;
  };
  visuals: Array<{
    name: string;
    source: string;
    apiVersion: number;
    compatibleManifestIds: string[];
  }>;
  /** Index into `visuals` of the exported primary visual (null when the
   *  script had no default — e.g. an app with no bound visuals). */
  defaultVisualIndex: number | null;
}

/** Why a parse failed — the UI maps each to an i18n key. */
export type MiniAppParseFailureReason =
  | "bad-json"
  | "bad-format"
  | "bad-version"
  | "bad-shape";

export type MiniAppParseResult =
  | { ok: true; bundle: MiniAppBundle }
  | { ok: false; reason: MiniAppParseFailureReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a bundle from a saved script, its bound visuals, and the primary id. */
export function buildMiniAppBundle(
  script: Pick<ScriptRecord, "name" | "description" | "code" | "enabled" | "defaultVisualId">,
  visuals: ExperienceVisualRow[],
  now: () => string,
): MiniAppBundle {
  const defaultVisualIndex = script.defaultVisualId
    ? visuals.findIndex((v) => v.id === script.defaultVisualId)
    : -1;
  return {
    format: MINI_APP_BUNDLE_FORMAT,
    version: MINI_APP_BUNDLE_VERSION,
    exportedAt: now(),
    script: {
      name: script.name,
      description: script.description,
      code: script.code,
      enabled: script.enabled,
    },
    visuals: visuals.map((v) => ({
      name: v.name,
      source: v.source,
      apiVersion: v.apiVersion,
      compatibleManifestIds: [...v.compatibleManifestIds],
    })),
    defaultVisualIndex: defaultVisualIndex >= 0 ? defaultVisualIndex : null,
  };
}

/** Parse and validate bundle text. Strict on format/version identity, lenient
 *  on cosmetic fields (exportedAt) — never throws, always returns a union. */
export function parseMiniAppBundle(text: string): MiniAppParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  if (!isRecord(raw) || raw.format !== MINI_APP_BUNDLE_FORMAT) {
    return { ok: false, reason: "bad-format" };
  }
  if (raw.version !== MINI_APP_BUNDLE_VERSION) {
    return { ok: false, reason: "bad-version" };
  }
  const { script, visuals, defaultVisualIndex } = raw;
  if (
    !isRecord(script)
    || typeof script.name !== "string"
    || typeof script.description !== "string"
    || typeof script.code !== "string"
    || typeof script.enabled !== "boolean"
    || !Array.isArray(visuals)
    || visuals.some(
      (v) =>
        !isRecord(v)
        || typeof v.name !== "string"
        || typeof v.source !== "string"
        || typeof v.apiVersion !== "number"
        || !Array.isArray(v.compatibleManifestIds)
        || v.compatibleManifestIds.some((id) => typeof id !== "string"),
    )
    || !(
      defaultVisualIndex === null
      || (typeof defaultVisualIndex === "number"
        && Number.isInteger(defaultVisualIndex)
        && defaultVisualIndex >= 0
        && defaultVisualIndex < visuals.length)
    )
  ) {
    return { ok: false, reason: "bad-shape" };
  }
  const bundle: MiniAppBundle = {
    format: MINI_APP_BUNDLE_FORMAT,
    version: MINI_APP_BUNDLE_VERSION,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    script: {
      name: script.name,
      description: script.description,
      code: script.code,
      enabled: script.enabled,
    },
    visuals: visuals.map((v) => ({
      name: v.name,
      source: v.source,
      apiVersion: v.apiVersion,
      compatibleManifestIds: [...v.compatibleManifestIds] as string[],
    })),
    defaultVisualIndex: defaultVisualIndex as number | null,
  };
  return { ok: true, bundle };
}

/** Suggested download filename for a bundle (`<app name>.vtapp.json`). */
export function miniAppBundleFileName(scriptName: string): string {
  const safe = scriptName.trim().replace(/[\\/:*?"<>|]+/g, "_") || "mini-app";
  return `${safe}.vtapp.json`;
}

/** Injectable API surface for `importMiniAppBundle` (tests pass fakes; the
 *  editor passes the real api fns). Typed against the api signatures. */
export interface MiniAppImportDeps {
  listAllScripts: () => Promise<Pick<ScriptRecord, "name">[]>;
  createScript: (body: {
    name: string;
    description?: string;
    code?: string;
    scriptKind?: "interactive";
    scopeType: string;
    enabled?: boolean;
  }) => Promise<ScriptRecord>;
  createExperienceVisual: (body: {
    name: string;
    source: string;
    apiVersion: number;
    compatibleManifestIds?: string[];
    scopeType?: "global" | "character" | "persona" | "chat";
  }) => Promise<ExperienceVisualRow>;
  bindScriptVisual: (scriptId: string, visualId: string) => Promise<void>;
}

export interface MiniAppImportResult {
  script: ScriptRecord;
  visuals: ExperienceVisualRow[];
}

/** Import a parsed bundle: create the visuals, then the script (name-deduped
 *  against existing scripts), then bind — default visual first so the store's
 *  first-bind-promotes-to-primary rule restores the exported default.
 *
 *  `nameSuffix` (e.g. " (import)") is appended ONLY on a name collision. */
export async function importMiniAppBundle(
  bundle: MiniAppBundle,
  scope: { scopeType: "global" | "character" | "persona" | "chat" },
  nameSuffix: string,
  deps: MiniAppImportDeps,
): Promise<MiniAppImportResult> {
  const existing = await deps.listAllScripts();
  const collides = existing.some((s) => s.name === bundle.script.name);
  const scriptName = collides ? `${bundle.script.name}${nameSuffix}` : bundle.script.name;

  // Visuals first: the script binds to their fresh ids.
  const createdVisuals: ExperienceVisualRow[] = [];
  for (const visual of bundle.visuals) {
    createdVisuals.push(
      await deps.createExperienceVisual({
        name: visual.name,
        source: visual.source,
        apiVersion: visual.apiVersion,
        compatibleManifestIds: visual.compatibleManifestIds,
        scopeType: "global",
      }),
    );
  }

  const script = await deps.createScript({
    name: scriptName,
    description: bundle.script.description,
    code: bundle.script.code,
    scriptKind: "interactive",
    scopeType: scope.scopeType,
    enabled: bundle.script.enabled,
  });

  // Bind the exported primary FIRST (store promotes it to default), then the
  // rest in exported order.
  const order = createdVisuals.map((_, i) => i);
  if (bundle.defaultVisualIndex !== null) {
    order.splice(bundle.defaultVisualIndex, 1);
    order.unshift(bundle.defaultVisualIndex);
  }
  for (const idx of order) {
    await deps.bindScriptVisual(script.id, createdVisuals[idx].id);
  }

  return { script, visuals: createdVisuals };
}
