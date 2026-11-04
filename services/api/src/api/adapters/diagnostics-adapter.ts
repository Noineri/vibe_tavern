import { zipSync } from "fflate";
import type {
  DiagnosticsGenerationPreview,
  DiagnosticsGenerationSelection,
  DiagnosticsManifest,
  DiagnosticsRuntimeApi,
  DiagnosticsZipInput,
} from "../contract/diagnostics-api.js";
import {
  buildDiagnosticsEntries,
  type DiagnosticsEntry,
  type DiagnosticsProviderProfile,
} from "../../domain/diagnostics/diagnostics-builder.js";
import {
  buildGenerationDiagnostics,
  matchesGenerationSelection,
  type GenerationDiagnosticsTrace,
} from "../../domain/diagnostics/generation-diagnostics.js";
import { conflict, notFound, validation } from "../../shared/errors.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { detectInstallKind, canSelfUpdate } from "../../domain/update/update-orchestrator.js";
import { getCurrentVersion } from "../../server/updater.js";
import { arch, release } from "node:os";

const encoder = new TextEncoder();

/** Same delegation boundary as the system adapter; the consent/ownership
 * gates live here so every route through this API gets them. */
export class DiagnosticsAdapter implements DiagnosticsRuntimeApi {
  constructor(
    private readonly deps: { stores: StoreContainer; dataDir: string },
  ) {}

  diagnosticsManifest = async (): Promise<DiagnosticsManifest> => {
    const entries = await buildDiagnosticsEntries(await this.input());
    return { entries: entries.map(({ path, bytes }) => ({ path, bytes })) };
  };

  /**
   * SM-9a: inspect ONE selected generation's redacted capture BEFORE any save
   * confirmation — the local preview is what the user consents against. A
   * missing/deleted trace or an identity that no longer matches the stored
   * row is an explicit error; nothing falls back to the latest generation or
   * the active chat.
   */
  diagnosticsGenerationPreview = async (selection: DiagnosticsGenerationSelection): Promise<DiagnosticsGenerationPreview> => {
    const trace = await this.resolveSelectedTrace(selection);
    const { files, missing } = buildGenerationDiagnostics(trace, await this.knownSecrets());
    return {
      selection,
      model: trace.model,
      presetName: trace.presetName,
      createdAt: trace.createdAt,
      entries: files.map((file) => ({ path: file.path, bytes: encoder.encode(file.text).byteLength })),
      missing,
      files: files.map((file) => ({ ...file, bytes: encoder.encode(file.text).byteLength })),
    };
  };

  diagnosticsZip = async (input?: DiagnosticsZipInput): Promise<Uint8Array> => {
    const attach = input?.attach;
    if (!attach) return this.zipTechnical();
    if (attach.confirmed !== true) {
      // The content-bearing archive is only ever built on an explicit
      // confirmed selection — the default archive is NOT widened to console
      // the caller's mistake.
      throw validation("Attaching generation content requires explicit confirmation.");
    }
    const trace = await this.resolveSelectedTrace(attach.selection);
    const { files } = buildGenerationDiagnostics(trace, await this.knownSecrets());
    const entries = await buildDiagnosticsEntries({ ...(await this.input()), generationFiles: files });
    return zipEntries(entries);
  };

  private zipTechnical = async (): Promise<Uint8Array> => zipEntries(await buildDiagnosticsEntries(await this.input()));

  /** Resolve the selected stored generation BY ID and verify the full
   * identity tuple — chat/branch/message/variant must all match the stored
   * row, so a stale or tampered selection is rejected instead of quietly
   * exporting a different attempt. */
  private resolveSelectedTrace = async (selection: DiagnosticsGenerationSelection): Promise<GenerationDiagnosticsTrace> => {
    const trace = await this.deps.stores.traces.getTrace(selection.traceId);
    if (!trace) {
      throw notFound("PromptTrace", `Trace '${selection.traceId}' was not found — it may have been deleted or never captured.`);
    }
    if (!matchesGenerationSelection(trace, selection)) {
      throw conflict("The selected generation identity does not match the stored trace.");
    }
    return trace;
  };

  /** Configured credentials that could be ECHOED inside a captured
   * request/response/error; generation-diagnostics redacts them as literals
   * wherever they appear. Proxy usernames stay out: they are short and
   * prose-like, and userinfo in URLs is already structurally dropped. */
  private knownSecrets = async (): Promise<string[]> => {
    const secrets: string[] = [];
    for (const profile of await this.deps.stores.providers.listAll()) {
      if (profile.apiKey) secrets.push(profile.apiKey);
    }
    for (const proxy of await this.deps.stores.proxies.listAll()) {
      if (proxy.password) secrets.push(proxy.password);
    }
    return secrets;
  };

  private input = async () => {
    // ONLY the technical triple ever leaves the profile store — names and
    // keys stay behind; the route test pins this against seeded secrets.
    const profiles: DiagnosticsProviderProfile[] = (await this.deps.stores.providers.listAll()).map((profile) => ({
      providerPreset: profile.providerPreset,
      endpoint: profile.endpoint,
      isActive: profile.isActive,
    }));
    return {
      dataDir: this.deps.dataDir,
      db: this.deps.stores.db,
      version: getCurrentVersion(),
      installKind: detectInstallKind(),
      canSelfUpdate: canSelfUpdate(),
      platform: process.platform,
      arch: arch(),
      osRelease: release(),
      providerProfiles: profiles,
    };
  };
}

function zipEntries(entries: readonly DiagnosticsEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.path] = entry.content;
  return zipSync(files);
}
