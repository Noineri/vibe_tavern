import type Resources from "../../i18n/resources.js";

/** Typed i18n key for the STT local-server namespace — a typo'd/missing key
 *  is a compile error (same TFunc pattern as the TTS quickstarts). */
export type SttI18nKey = keyof Resources["en"];

/** The two OS families the no-Docker branch differentiates between. The
 *  Docker branch is OS-identical and ignores this. */
export type SttOsKind = "windows" | "unix";

/** One step of the setup reference: a heading, per-OS command lists (each
 *  command gets its own copy button), and an optional note. */
export interface SttHelpStep {
  /** i18n key of the step heading. */
  titleKey: SttI18nKey;
  commands: Record<SttOsKind, string[]>;
  /** Optional i18n note rendered under the commands. */
  noteKey?: SttI18nKey;
}

/** A local STT server's setup guide (STT_PLAN ST-8): choose → download
 *  (docker | clone) → install → run → endpoint. Facts verified against the
 *  upstream READMEs: fedirz/faster-whisper-server documents the docker image
 *  `fedirz/faster-whisper-server:latest-cpu` (port 8000) and a `uvx` one-shot
 *  that installs AND runs (uv is the documented bootstrap — the install and
 *  run steps carry the same uvx command rather than inventing a pip path);
 *  mudler/LocalAI documents the docker image `localai/localai` (container
 *  port 8080) as the primary install path — its manual build is heavy, so
 *  Docker is recommended. */
export interface SttServerSetupGuide {
  id: string;
  name: string;
  /** i18n key of the one-line "what this server is" description. */
  descriptionKey: SttI18nKey;
  port: number;
  endpoint: string;
  docker: SttHelpStep;
  clone: SttHelpStep;
  install: SttHelpStep;
  run: SttHelpStep;
}

export const STT_SERVER_GUIDES: SttServerSetupGuide[] = [
  {
    id: "faster-whisper-server",
    name: "Faster Whisper Server",
    descriptionKey: "stt_local_desc_faster_whisper",
    port: 8000,
    endpoint: "http://127.0.0.1:8000/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        windows: ["docker run -p 8000:8000 fedirz/faster-whisper-server:latest-cpu"],
        unix: ["docker run -p 8000:8000 fedirz/faster-whisper-server:latest-cpu"],
      },
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        windows: ["git clone https://github.com/fedirz/faster-whisper-server.git"],
        unix: ["git clone https://github.com/fedirz/faster-whisper-server.git"],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: {
        // The uvx command installs AND starts the server (uv is the upstream
        // bootstrap) — repeated in `run` for honesty, with a Windows note.
        unix: ["uvx --from git+https://github.com/fedirz/faster-whisper-server --python 3.12 uvicorn --factory faster_whisper_server.app_factory:create_app --host 127.0.0.1 --port 8000"],
        windows: [],
      },
      noteKey: "stt_local_install_note_faster_whisper",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["uvx --from git+https://github.com/fedirz/faster-whisper-server --python 3.12 uvicorn --factory faster_whisper_server.app_factory:create_app --host 127.0.0.1 --port 8000"],
        windows: [],
      },
      noteKey: "stt_local_run_note_faster_whisper",
    },
  },
  {
    id: "localai",
    name: "LocalAI",
    descriptionKey: "stt_local_desc_localai",
    port: 8000,
    endpoint: "http://127.0.0.1:8000/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        windows: ["docker run -p 8000:8080 localai/localai:latest"],
        unix: ["docker run -p 8000:8080 localai/localai:latest"],
      },
      noteKey: "stt_local_docker_note_localai",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        windows: ["git clone https://github.com/mudler/LocalAI.git"],
        unix: ["git clone https://github.com/mudler/LocalAI.git"],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: { windows: [], unix: [] },
      // A manual build is heavy and upstream points to Docker — no invented
      // pip path (honesty rule).
      noteKey: "stt_local_install_note_localai",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: { windows: [], unix: [] },
      noteKey: "stt_local_run_note_localai",
    },
  },
];
