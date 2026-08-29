import type { DiscoveryDiagnosticCode } from "@vibe-tavern/domain";
import type Resources from "../../i18n/resources.js";

/** Typed i18n key — a typo'd/missing key is a compile error (TFunc pattern). */
export type TtsI18nKey = keyof Resources["en"];

/** The two OS families the no-Docker branch differentiates between
 *  (TE2-17). The Docker branch is OS-identical and ignores this. */
export type TtsOsKind = "windows" | "unix";

/** Detect the OS family for the help's default OS toggle position from a
 *  user-agent string (TE2-17: browser platform auto-detect, manual switch
 *  always available in the UI). Anything unrecognizable falls back to unix —
 *  the commands are the more portable spelling of the two. */
export function detectTtsOsKind(userAgent: string): TtsOsKind {
  return /win/i.test(userAgent) ? "windows" : "unix";
}

/** One step of the setup reference: a heading, per-OS command lists (each
 *  command gets its own copy button — never a glued compound), and an
 *  optional note. Steps whose commands are OS-identical repeat the same
 *  list for both keys (pinned by tests). */
export interface TtsHelpStep {
  /** i18n key of the step heading. */
  titleKey: TtsI18nKey;
  commands: Record<TtsOsKind, string[]>;
  /** Optional i18n note rendered under the commands. */
  noteKey?: TtsI18nKey;
}

/** A server's full setup guide (TE2-17): choose → download (docker | clone)
 *  → install → run → endpoint. Facts verified against the upstream repos:
 *  remsky/Kokoro-FastAPI ships `start-cpu.sh` AND `start-cpu.ps1` in the repo
 *  root (the start scripts bootstrap their own dependencies — install is a
 *  note, not commands); travisvn/openai-edge-tts README documents venv
 *  activation per OS (`venv\Scripts\activate` vs `source venv/bin/activate`)
 *  and `python app/server.py` to run. */
export interface TtsServerSetupGuide {
  id: string;
  name: string;
  /** i18n key of the one-line "what this server is" description (step 1). */
  descriptionKey: TtsI18nKey;
  port: number;
  endpoint: string;
  docker: TtsHelpStep;
  clone: TtsHelpStep;
  install: TtsHelpStep;
  run: TtsHelpStep;
}

export const TTS_SERVER_SETUP_GUIDES: TtsServerSetupGuide[] = [
  {
    id: "kokoro-fastapi",
    name: "Kokoro FastAPI",
    descriptionKey: "tts_help_choose_kokoro",
    port: 8880,
    endpoint: "http://127.0.0.1:8880/v1",
    docker: {
      titleKey: "tts_help_download_docker",
      commands: {
        windows: ["docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest"],
        unix: ["docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest"],
      },
      noteKey: "tts_help_docker_same_note",
    },
    clone: {
      titleKey: "tts_help_download_nodocker",
      commands: {
        windows: ["git clone https://github.com/remsky/Kokoro-FastAPI.git"],
        unix: ["git clone https://github.com/remsky/Kokoro-FastAPI.git"],
      },
    },
    install: {
      titleKey: "tts_help_step_install",
      commands: { windows: [], unix: [] },
      // Upstream start scripts self-bootstrap via uv — an install command
      // list would be invented, which the honesty rule forbids.
      noteKey: "tts_help_install_note_kokoro",
    },
    run: {
      titleKey: "tts_help_step_run",
      commands: {
        windows: [".\\start-cpu.ps1"],
        unix: ["./start-cpu.sh"],
      },
      noteKey: "tts_help_cwd_note",
    },
  },
  {
    id: "openai-edge-tts",
    name: "OpenAI Edge TTS",
    descriptionKey: "tts_help_choose_edge",
    port: 5050,
    endpoint: "http://127.0.0.1:5050/v1",
    docker: {
      titleKey: "tts_help_download_docker",
      commands: {
        windows: ["docker run -d -p 5050:5050 -e PORT=5050 travisvn/openai-edge-tts:latest"],
        unix: ["docker run -d -p 5050:5050 -e PORT=5050 travisvn/openai-edge-tts:latest"],
      },
      noteKey: "tts_help_docker_same_note",
    },
    clone: {
      titleKey: "tts_help_download_nodocker",
      commands: {
        windows: ["git clone https://github.com/travisvn/openai-edge-tts.git"],
        unix: ["git clone https://github.com/travisvn/openai-edge-tts.git"],
      },
    },
    install: {
      titleKey: "tts_help_step_install",
      commands: {
        windows: ["python -m venv venv", "venv\\Scripts\\activate", "pip install -r requirements.txt"],
        unix: ["python -m venv venv", "source venv/bin/activate", "pip install -r requirements.txt"],
      },
      noteKey: "tts_help_cwd_note",
    },
    run: {
      titleKey: "tts_help_step_run",
      commands: {
        windows: ["python app/server.py"],
        unix: ["python app/server.py"],
      },
    },
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
