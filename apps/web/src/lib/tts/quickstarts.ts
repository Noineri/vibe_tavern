import type { DiscoveryDiagnosticCode } from "./server-discovery.js";

export interface LocalTtsQuickstart {
  id: string;
  name: string;
  command: string;
  port: number;
  endpoint: string;
}

export const LOCAL_TTS_QUICKSTARTS: LocalTtsQuickstart[] = [
  {
    id: "kokoro-fastapi",
    name: "Kokoro FastAPI",
    command: "docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest",
    port: 8880,
    endpoint: "http://127.0.0.1:8880/v1",
  },
  {
    id: "openai-edge-tts",
    name: "OpenAI Edge TTS",
    command: "docker run -d -p 5050:5050 -e PORT=5050 travisvn/openai-edge-tts:latest",
    port: 5050,
    endpoint: "http://127.0.0.1:5050/v1",
  },
];

const SEVERITY_ORDER: DiscoveryDiagnosticCode[] = [
  "timeout",
  "http-other",
  "auth-or-http",
  "wrong-shape",
  "server-not-running",
];

const SEVERITY_INDEX: Record<string, number> = Object.fromEntries(
  SEVERITY_ORDER.map((code, index) => [code, index]),
);

export function worstDiagnostic(codes: DiscoveryDiagnosticCode[]): DiscoveryDiagnosticCode | null {
  if (codes.length === 0) return null;
  let best: DiscoveryDiagnosticCode | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const code of codes) {
    // "found" is not a diagnostic severity — skip it.
    if (code === "found") continue;
    const rank = SEVERITY_INDEX[code];
    if (rank === undefined) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = code;
    }
  }
  // If only "found" codes were present, treat as null (no diagnostic needed).
  if (best !== null) return best;
  // All entries were "found" or unknown — nothing to diagnose.
  return null;
}

export function diagnosticI18nKey(code: DiscoveryDiagnosticCode): string {
  switch (code) {
    case "server-not-running":
      return "tts_discover_diag_server_not_running";
    case "wrong-shape":
      return "tts_discover_diag_wrong_shape";
    case "auth-or-http":
      return "tts_discover_diag_auth_or_http";
    case "http-other":
      return "tts_discover_diag_http_other";
    case "timeout":
      return "tts_discover_diag_timeout";
    case "found":
      return "tts_discover_found";
    default:
      return "tts_discover_diag_http_other";
  }
}
