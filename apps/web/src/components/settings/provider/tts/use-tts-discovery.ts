import { useCallback, useState } from "react";

import { diagnoseOutcome, type DiscoveredServer, type DiscoveryDiagnosticCode, type ProbeOutcome } from "@vibe-tavern/domain";
import { discoverLocalTtsServers as apiDiscover } from "../../../../api/tts-api.js";

export interface TtsDiscoveryDeps {
  /** Discovery runs SERVER-SIDE (via the API route) — local servers without
   *  CORS headers (openai-edge-tts) are unreachable from the browser. */
  discover: () => Promise<ProbeOutcome[]>;
}

let depsOverride: TtsDiscoveryDeps | null = null;

export function __setTtsDiscoveryDepsForTests(deps: TtsDiscoveryDeps | null): void {
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

export function useTtsDiscovery(): {
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
