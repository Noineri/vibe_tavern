import type { DiagnosticsGenerationSelection, GenerationDiagnosticsFile } from "../../domain/diagnostics/generation-diagnostics.js";

export interface DiagnosticsManifestEntry {
  /** Zip path, e.g. "vt-info.json" — the UI derives its i18n description from it. */
  path: string;
  /** Uncompressed content size in bytes. */
  bytes: number;
}

export interface DiagnosticsManifest {
  entries: DiagnosticsManifestEntry[];
}

/** The identity of ONE stored generation attempt (see generation-diagnostics). */
export type { DiagnosticsGenerationSelection };

/** One inspectable, ALREADY REDACTED file of the selected generation's
 * attachment — the preview shows these before any save confirmation. */
export interface DiagnosticsGenerationPreviewFile extends GenerationDiagnosticsFile {
  bytes: number;
}

/** SM-9a preview of what attaching the selected generation would add: the
 * actually available entries, the captured-but-absent fields, and the redacted
 * contents for local inspection. `missing` is reported honestly — a failed
 * attempt with no captured response shows `["providerResponse"]`, never a
 * silently substituted or invented capture. */
export interface DiagnosticsGenerationPreview {
  selection: DiagnosticsGenerationSelection;
  model: string;
  presetName: string;
  createdAt: string;
  entries: Array<{ path: string; bytes: number }>;
  missing: string[];
  files: DiagnosticsGenerationPreviewFile[];
}

/** SM-9a zip request: no `attach` = the SM-7 technical-only default; an
 * `attach` without `confirmed: true` is rejected — the content-bearing
 * archive is never built on an unconfirmed selection. */
export interface DiagnosticsZipInput {
  attach?: {
    selection: DiagnosticsGenerationSelection;
    confirmed: boolean;
  };
}

/** SM-7: the technical-only diagnostics bundle (see domain/diagnostics);
 * SM-9a adds the consent-scoped selected-generation attachment. */
export interface DiagnosticsRuntimeApi {
  diagnosticsManifest: () => Promise<DiagnosticsManifest>;
  diagnosticsGenerationPreview: (selection: DiagnosticsGenerationSelection) => Promise<DiagnosticsGenerationPreview>;
  diagnosticsZip: (input?: DiagnosticsZipInput) => Promise<Uint8Array>;
}
