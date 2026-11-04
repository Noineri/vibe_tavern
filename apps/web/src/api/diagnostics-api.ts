import { apiFetch } from "./client.js";

/** Mirrors the API contract (services/api contract/diagnostics-api.ts). */
export interface DiagnosticsManifestEntry {
  path: string;
  bytes: number;
}

export interface DiagnosticsManifest {
  entries: DiagnosticsManifestEntry[];
}

/** The item list shown BEFORE the user confirms the download. */
export async function fetchDiagnosticsManifest(): Promise<DiagnosticsManifest> {
  const response = await apiFetch("/api/diagnostics");
  if (!response.ok) throw new Error(`diagnostics manifest: HTTP ${response.status}`);
  return (await response.json()) as DiagnosticsManifest;
}

/** The technical-only zip itself (never contains keys or chat content). */
export async function downloadDiagnosticsZip(): Promise<Blob> {
  const response = await apiFetch("/api/diagnostics", { method: "POST" });
  if (!response.ok) throw new Error(`diagnostics zip: HTTP ${response.status}`);
  return response.blob();
}
