import { apiFetch } from "./client.js";

/** Mirrors the API contract (services/api contract/diagnostics-api.ts). */
export interface DiagnosticsManifestEntry {
  path: string;
  bytes: number;
}

export interface DiagnosticsManifest {
  entries: DiagnosticsManifestEntry[];
}

/** The full identity tuple of ONE stored generation attempt — every field is
 * re-verified against the stored trace server-side; a stale selection is
 * rejected instead of resolving to whatever now sits under the trace id. */
export interface DiagnosticsGenerationSelection {
  traceId: string;
  chatId: string;
  branchId: string;
  messageId: string;
  variantId: string | null;
}

/** One inspectable, already-redacted file of the selected generation. */
export interface DiagnosticsGenerationFile {
  path: string;
  bytes: number;
  text: string;
}

export interface DiagnosticsGenerationPreview {
  selection: DiagnosticsGenerationSelection;
  model: string;
  presetName: string;
  createdAt: string;
  entries: Array<{ path: string; bytes: number }>;
  /** Captured-but-absent fields (e.g. the response of a failed attempt). */
  missing: string[];
  files: DiagnosticsGenerationFile[];
}

/** The item list shown BEFORE the user confirms the download. */
export async function fetchDiagnosticsManifest(): Promise<DiagnosticsManifest> {
  const response = await apiFetch("/api/diagnostics");
  if (!response.ok) throw new Error(`diagnostics manifest: HTTP ${response.status}`);
  return (await response.json()) as DiagnosticsManifest;
}

/** Inspect the selected generation's redacted capture BEFORE confirming any
 * content-bearing download (SM-9a preview endpoint). */
export async function fetchDiagnosticsGenerationPreview(
  selection: DiagnosticsGenerationSelection,
): Promise<DiagnosticsGenerationPreview> {
  const response = await apiFetch("/api/diagnostics/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection }),
  });
  if (!response.ok) throw new Error(`diagnostics preview: HTTP ${response.status}`);
  return (await response.json()) as DiagnosticsGenerationPreview;
}

/** The diagnostics zip. Without `attach` it is the technical-only bundle
 * (never contains keys or chat content); with a confirmed `attach` it also
 * carries the selected generation's redacted request/response/metadata. */
export async function downloadDiagnosticsZip(
  attach?: { selection: DiagnosticsGenerationSelection; confirmed: boolean },
): Promise<Blob> {
  const init: RequestInit = { method: "POST" };
  if (attach) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ attach });
  }
  const response = await apiFetch("/api/diagnostics", init);
  if (!response.ok) throw new Error(`diagnostics zip: HTTP ${response.status}`);
  return response.blob();
}
