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

// ─── Streaming import (live progress bar) ─────────────────────────────────
// Mirrors ImportStreamEvent / ImportPhase from the backend scanner. The route
// emits one SSE message per event keyed by `type` (phase / progress / done /
// error); the frontend pairs each `current` against its own scanResult totals
// (the scan step always runs first, so the per-phase denominator is known).
export type ImportPhase = "characters" | "chats" | "lorebooks" | "presets" | "personas";
/** Non-terminal stream events delivered to the `onEvent` callback. The terminal
 *  `done`/`error` are NOT passed to the callback — they resolve or reject the
 *  returned promise instead. */
export type ImportProgressEvent =
  | { type: "phase"; phase: ImportPhase }
  | { type: "progress"; phase: ImportPhase; current: number };

/**
 * Import a SillyTavern directory via the streaming SSE route, invoking
 * `onEvent` for each phase/progress/done/error event as it arrives. Resolves
 * with the final StImportResult (from the `done` event), or rejects with the
 * server's error message (from the `error` event, or a non-2xx / network
 * failure). Uses raw fetch + a hand-rolled SSE frame parser (the Hono client
 * has no streaming helper), with the mobile bearer token added manually like
 * openNativeDialog. No client timeout — a huge import legitimately runs for
 * minutes and the stream itself signals completion.
 */
export async function importStDirectoryStream(
  path: string,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<StImportResult> {
  const token = getMobileToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${getGatewayBaseUrl()}/api/import/st-directory/stream`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Import failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: StImportResult | null = null;
  let serverError: string | null = null;

  // Minimal SSE parser: frames are separated by a blank line ("\n\n"). Within
  // a frame, `event:` sets the type and `data:` carries the JSON payload
  // (possibly across multiple `data:` lines, which we join with "\n").
  const handleFrame = (frame: string) => {
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!eventType || dataLines.length === 0) return;
    const data = dataLines.join("\n");
    try {
      // Includes terminal done/error which are handled below, not via onEvent.
      type WireEvent = ImportProgressEvent | { type: "done"; result: StImportResult } | { type: "error"; message: string };
      const parsed = JSON.parse(data) as WireEvent;
      if (parsed.type === "done") result = parsed.result;
      else if (parsed.type === "error") serverError = parsed.message;
      else onEvent(parsed);
    } catch {
      // Malformed frame — ignore; the terminal done/error still resolves.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      handleFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  // Flush any trailing frame without a terminating blank line.
  if (buffer.trim()) handleFrame(buffer);

  if (serverError) throw new Error(serverError);
  if (!result) throw new Error("Import stream ended without a result");
  return result;
}
