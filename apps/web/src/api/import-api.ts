import type { ImportJsonResponse } from "./types.js";
import type { ChatId } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";

export async function importJson(input: {
  fileName: string;
  jsonText: string;
  chatId?: ChatId;
  skipExisting?: boolean;
  lean?: boolean;
}): Promise<ImportJsonResponse> {
  const response = await client.api.import.json.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  // Snapshot is absent on the lean mass-import path — only normalize when present.
  return data.snapshot ? { ...data, snapshot: normalizeSnapshot(data.snapshot) } : data;
}

export interface BatchImportItemResult {
  fileName: string;
  characterId?: string;
  activeChatId?: ChatId;
  error?: string;
}

/**
 * Mass-import batch: sends up to N parsed cards in one request (POST
 * /api/import/batch) instead of N roundtrips. Server processes per-item with
 * try/catch, so one bad card lands in results[].error rather than failing the
 * whole batch. Defaults to lean (no getSnapshot). See import-api batch client +
 * ImportModals Phase 1.
 */
export async function importJsonBatch(input: {
  items: Array<{ fileName: string; jsonText: string; chatId?: ChatId; skipExisting?: boolean }>;
  lean?: boolean;
}): Promise<{ results: BatchImportItemResult[] }> {
  const response = await client.api.import.batch.$post({ json: input });
  return unwrapRpc<{ results: BatchImportItemResult[] }>(response);
}

// ─── SillyTavern directory import (backend-driven; ST_NATIVE_DIALOG_IMPORT_PLAN) ──

/** Discriminated result of the native OS folder-picker dialog. */
export type NativeDialogResult =
  | { path: string }
  | { cancelled: true }
  | { available: false }
  | { error: string };

/** Mirrors `StScannedCharacter` from the backend scanner. */
export interface StScanCharacter {
  fileName: string;
  name: string;
  characterId: string | null;
  chatId: string | null;
  imported: boolean;
  warnings: string[];
}

/** Mirrors `StScannedChat` from the backend scanner. */
export interface StScanChat {
  fileName: string;
  characterName: string;
  messageCount: number;
  chatId: string | null;
  imported: boolean;
}

/** Mirrors `StScannedLorebook` from the backend scanner. */
export interface StScanLorebook {
  fileName: string;
  name: string;
  imported: boolean;
  warnings: string[];
}

/** Mirrors `StScannedPreset` from the backend scanner. */
export interface StScanPreset {
  fileName: string;
  name: string;
  imported: boolean;
}

/** Mirrors `StScannedPersona` from the backend scanner. */
export interface StScanPersona {
  /** Number of persona entries detected in settings.json. */
  count: number;
  imported: boolean;
}

/** Mirrors `StScanError` from the backend scanner. */
export interface StScanError {
  file: string;
  stage: "read" | "parse" | "import";
  message: string;
}

/** Mirrors `StDirectoryScanResult` (read-only preview). Kept in sync manually —
 *  the route returns `c.json(result)` without a declared output schema, so Hono's
 *  inferred type is generic and the frontend owns its own contract copy. */
export interface StScanResult {
  characters: StScanCharacter[];
  chats: StScanChat[];
  lorebooks: StScanLorebook[];
  presets: StScanPreset[];
  persona: StScanPersona | null;
  errors: StScanError[];
}

/** Mirrors `StDirectoryImportResult`. */
export interface StImportResult {
  characters: number;
  chats: number;
  lorebooks: number;
  presets: number;
  personas: number;
  errors: StScanError[];
  /** ID of the last imported character's chat — can be used to navigate UI. */
  lastActiveChatId: ChatId | null;
}

/**
 * Open the native OS folder picker. Uses raw fetch (not the Hono client) because
 * the `/api/fs/native-dialog` route has no typed response schema and we need a
 * 5-minute client-side timeout (the user may take minutes to pick a folder).
 * The auth token that `client` injects via its header factory is added manually
 * here so mobile/companion sessions carry the same Authorization header.
 */
export async function openNativeDialog(): Promise<NativeDialogResult> {
  const token = getMobileToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${getGatewayBaseUrl()}/api/fs/native-dialog`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  return (await response.json()) as NativeDialogResult;
}

/** Scan a SillyTavern directory on the backend (read-only preview). */
export async function scanStDirectory(path: string): Promise<StScanResult> {
  const response = await client.api.import["st-scan"].$post({ json: { path } });
  return unwrapRpc<StScanResult>(response);
}

/** Import a SillyTavern directory on the backend (writes all five surfaces). */
export async function importStDirectory(path: string): Promise<StImportResult> {
  const response = await client.api.import["st-directory"].$post({ json: { path } });
  return unwrapRpc<StImportResult>(response);
}
