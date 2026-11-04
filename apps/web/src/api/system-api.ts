import { apiFetch } from "./client.js";

/** Mirrors the API contract `OpenDataDirResult` (services/api contract/system-api.ts). */
export type OpenDataDirResult = { opened: true } | { available: false } | { error: string };

/**
 * Ask the server to open its data directory in the OS file manager.
 * Desktop-only by contract; the About section hides the button on phones and
 * the adapter answers `{ available: false }` for the APK regardless.
 */
export async function openDataDir(): Promise<OpenDataDirResult> {
  const response = await apiFetch("/api/fs/open-data-dir", { method: "POST" });
  if (!response.ok) throw new Error(`fs/open-data-dir: HTTP ${response.status}`);
  return (await response.json()) as OpenDataDirResult;
}
