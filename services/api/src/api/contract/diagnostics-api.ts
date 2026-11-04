export interface DiagnosticsManifestEntry {
  /** Zip path, e.g. "vt-info.json" — the UI derives its i18n description from it. */
  path: string;
  /** Uncompressed content size in bytes. */
  bytes: number;
}

export interface DiagnosticsManifest {
  entries: DiagnosticsManifestEntry[];
}

/** SM-7: the technical-only diagnostics bundle (see domain/diagnostics). */
export interface DiagnosticsRuntimeApi {
  diagnosticsManifest: () => Promise<DiagnosticsManifest>;
  diagnosticsZip: () => Promise<Uint8Array>;
}
