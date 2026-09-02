import { useCallback, useState } from "react";

import { diagnoseOutcome, type DiscoveredServer, type DiscoveryDiagnosticCode, type ProbeOutcome } from "@vibe-tavern/domain";
import { discoverLocalSttServers as apiDiscover } from "../../../../api/stt-api.js";

/** STT local-server discovery hook (STT_PLAN ST-8). Fork of the TTS
 *  use-tts-discovery.ts — same shape, same server-side routing rationale
 *  (local servers without CORS headers are unreachable from the browser). */
export interface SttDiscoveryDeps {
  discover: () => Promise<ProbeOutcome[]>;
}

let depsOverride: SttDiscoveryDeps | null = null;

export function __setSttDiscoveryDepsForTests(deps: SttDiscoveryDeps | null): void {
  depsOverride = deps;
}

function currentDiscover(): () => Promise<ProbeOutcome[]> {
  if (depsOverride !== null) return depsOverride.discover;
  return apiDiscover;
}

/** Type guard: a `found` probe carrying its server — narrows without casts. */
function foundWithServer(
  outcome: ProbeOutcome,
): outcome is ProbeOutcome & { server: DiscoveredServer } {
  return outcome.status === "found" && outcome.server !== undefined;
}

export function useSttDiscovery(): {
  scanning: boolean;
  servers: DiscoveredServer[];
  notFoundCodes: DiscoveryDiagnosticCode[] | null;
  error: string | null;
  discover(): Promise<void>;
} {
  const [scanning, setScanning] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [notFoundCodes, setNotFoundCodes] = useState<DiscoveryDiagnosticCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = useCallback(async (): Promise<void> => {
    setScanning(true);
    setError(null);
    try {
      const outcomes: ProbeOutcome[] = await currentDiscover()();
      const found = outcomes.filter(foundWithServer).map((outcome) => outcome.server);
      setServers(found);
      if (found.length > 0) {
        setNotFoundCodes(null);
      } else {
        const codes = outcomes.map((outcome) => diagnoseOutcome(outcome));
        setNotFoundCodes(codes);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setServers([]);
      setNotFoundCodes(null);
    } finally {
      setScanning(false);
    }
  }, []);

  return { scanning, servers, notFoundCodes, error, discover };
}
