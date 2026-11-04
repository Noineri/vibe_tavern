import { zipSync } from "fflate";
import type { DiagnosticsManifest, DiagnosticsRuntimeApi } from "../contract/diagnostics-api.js";
import { buildDiagnosticsEntries, type DiagnosticsProviderProfile } from "../../domain/diagnostics/diagnostics-builder.js";
import type { StoreContainer } from "@vibe-tavern/db";
import { detectInstallKind, canSelfUpdate } from "../../domain/update/update-orchestrator.js";
import { getCurrentVersion } from "../../server/updater.js";
import { arch, release } from "node:os";

/** Same delegation boundary as the system adapter; no business logic here. */
export class DiagnosticsAdapter implements DiagnosticsRuntimeApi {
  constructor(
    private readonly deps: { stores: StoreContainer; dataDir: string },
  ) {}

  diagnosticsManifest = async (): Promise<DiagnosticsManifest> => {
    const entries = await buildDiagnosticsEntries(await this.input());
    return { entries: entries.map(({ path, bytes }) => ({ path, bytes })) };
  };

  diagnosticsZip = async (): Promise<Uint8Array> => {
    const entries = await buildDiagnosticsEntries(await this.input());
    const files: Record<string, Uint8Array> = {};
    for (const entry of entries) files[entry.path] = entry.content;
    return zipSync(files);
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
