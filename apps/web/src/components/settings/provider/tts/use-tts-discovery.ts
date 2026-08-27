import { useCallback, useState } from "react";

import {
  diagnoseOutcome,
  discoverLocalTtsServers as realDiscover,
  type DiscoveredServer,
  type DiscoveryDiagnosticCode,
  type FetchLike,
  type ProbeOutcome,
} from "../../../../lib/tts/server-discovery.js";

export interface TtsDiscoveryDeps {
  discoverLocalTtsServers: typeof realDiscover;
}

let depsOverride: TtsDiscoveryDeps | null = null;

export function __setTtsDiscoveryDepsForTests(deps: TtsDiscoveryDeps | null): void {
  depsOverride = deps;
}

function currentDiscover(): typeof realDiscover {
  if (depsOverride !== null) return depsOverride.discoverLocalTtsServers;
  return realDiscover;
}

/** Type guard: a `found` probe carrying its server — narrows without casts. */
function foundWithServer(
  outcome: ProbeOutcome,
): outcome is ProbeOutcome & { server: DiscoveredServer } {
  return outcome.status === "found" && outcome.server !== undefined;
}

/** The browser fetch satisfies FetchLike structurally (string input is a
 *  RequestInfo; Response covers ok/status/json). Annotated assignment lets
 *  the compiler verify it — no casts. */
const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

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
      const outcomes: ProbeOutcome[] = await currentDiscover()(browserFetch);
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
