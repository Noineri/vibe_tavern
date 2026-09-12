import type Resources from "../../i18n/resources.js";

/** Typed i18n key for the STT local-server namespace — a typo'd/missing key
 *  is a compile error (same TFunc pattern as the TTS quickstarts). */
export type SttI18nKey = keyof Resources["en"];

/** The two OS families the no-Docker branch differentiates between. The
 *  Docker branch is OS-identical and ignores this. */
export type SttOsKind = "windows" | "unix";

/** Which wire a server speaks — decides which preset row can talk to it.
 *  - "openai": OpenAI-compatible `/v1/audio/transcriptions` (the generic
 *    Local preset on the openai-compat transport).
 *  - "whisper-cpp": the whisper.cpp server protocol (`POST {base}/inference`
 *    + `GET {base}/health`) — the dedicated whisper.cpp preset (SPE-9). */
export type SttGuideWire = "openai" | "whisper-cpp";

/** One step of the setup reference: a heading, per-OS command lists (each
 *  command gets its own copy button), and an optional note. */
export interface SttHelpStep {
  /** i18n key of the step heading. */
  titleKey: SttI18nKey;
  commands: Record<SttOsKind, string[]>;
  /** Optional i18n note rendered under the commands. */
  noteKey?: SttI18nKey;
}

/** A local STT server's setup guide (STT_PLAN ST-8, SPE-10): choose →
 *  download (docker | clone) → install → run → endpoint. All facts verified
 *  against the upstream docs on 2026-09-10 (sources noted per guide):
 *  - Speaches — speaches.ai/installation (repo renamed from
 *    fedirz/faster-whisper-server; image ghcr.io/speaches-ai/speaches,
 *    port 8000, uv bootstrap, no uvx one-shot anymore).
 *  - whisper.cpp — ggml-org/whisper.cpp README @ master (cmake build,
 *    models/download-ggml-model.sh + .cmd, whisper-server, docker images
 *    ghcr.io/ggml-org/whisper.cpp).
 *  - Whisperfile — huggingface.co/Mozilla/whisperfile card + llamafile docs
 *    (single-file binary, Windows rename-to-.exe quirk, bare run starts the
 *    HTTP server on 8080; server API is the whisper.cpp wire — /inference
 *    + /health, docs.mozilla.ai/llamafile/whisperfile/server).
 *  - LocalAI — mudler/LocalAI README @ master (docker localai/localai,
 *    container port 8080) + localai.io/features/audio-to-text (whisper
 *    ggml + YAML config path).
 *  - vLLM — docs/serving/online_serving/speech_to_text.md @ main
 *    (pip install vllm[audio]; vllm serve openai/whisper-large-v3-turbo —
 *    from the official example's documented start command) +
 *    docs/deployment/docker.md (vllm/vllm-openai image shape).
 *  - NVIDIA Riva NIM — docs.nvidia.com/nim speech getting-started (NGC_API_KEY
 *    docker login, nvcr.io/nim/nvidia/riva-asr, NIM_HTTP_API_PORT=9000) +
 *    the SPE-R pass facts pinned in STT_PROVIDER_EXPANSION_REPORT. */
export interface SttServerSetupGuide {
  id: string;
  name: string;
  /** i18n key of the one-line "what this server is" description. */
  descriptionKey: SttI18nKey;
  /** The wire this server speaks — see SttGuideWire. */
  wire: SttGuideWire;
  port: number;
  /** Endpoint to paste into the matching preset's endpoint field. For
   *  "openai"-wire guides this INCLUDES `/v1` (the openai-compat config
   *  stores the base including /v1); for "whisper-cpp"-wire guides it is
   *  the bare base (the whisper.cpp adapter appends /inference itself). */
  endpoint: string;
  docker: SttHelpStep;
  clone: SttHelpStep;
  install: SttHelpStep;
  run: SttHelpStep;
}

export const STT_SERVER_GUIDES: SttServerSetupGuide[] = [
  {
    id: "speaches",
    name: "Speaches",
    descriptionKey: "stt_local_desc_speaches",
    wire: "openai",
    port: 8000,
    endpoint: "http://127.0.0.1:8000/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        windows: [
          "docker run --rm --detach --publish 8000:8000 --name speaches --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu",
        ],
        unix: [
          "docker run --rm --detach --publish 8000:8000 --name speaches --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu",
        ],
      },
      noteKey: "stt_local_docker_note_speaches",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        windows: ["git clone https://github.com/speaches-ai/speaches.git", "cd speaches"],
        unix: ["git clone https://github.com/speaches-ai/speaches.git", "cd speaches"],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: {
        unix: ["uv python install", "uv venv", "source .venv/bin/activate", "uv sync"],
        windows: ["uv python install", "uv venv", ".venv\\Scripts\\activate", "uv sync"],
      },
      noteKey: "stt_local_install_note_speaches",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["uvicorn --factory --host 0.0.0.0 speaches.main:create_app"],
        windows: ["uvicorn --factory --host 0.0.0.0 speaches.main:create_app"],
      },
      noteKey: "stt_local_run_note_speaches",
    },
  },
  {
    id: "whisper-cpp",
    name: "whisper.cpp",
    descriptionKey: "stt_local_desc_whisper_cpp",
    wire: "whisper-cpp",
    port: 8080,
    endpoint: "http://127.0.0.1:8080",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        unix: [
          'docker run -it --rm -v "$PWD/models:/models" ghcr.io/ggml-org/whisper.cpp:main "./models/download-ggml-model.sh base /models"',
          'docker run -it --rm -p 8080:8080 -v "$PWD/models:/models" ghcr.io/ggml-org/whisper.cpp:main "whisper-server --host 127.0.0.1 -m /models/ggml-base.bin"',
        ],
        windows: [
          'docker run -it --rm -v "%cd%\\models:/models" ghcr.io/ggml-org/whisper.cpp:main "./models/download-ggml-model.sh base /models"',
          'docker run -it --rm -p 8080:8080 -v "%cd%\\models:/models" ghcr.io/ggml-org/whisper.cpp:main "whisper-server --host 127.0.0.1 -m /models/ggml-base.bin"',
        ],
      },
      noteKey: "stt_local_docker_note_whisper_cpp",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        windows: ["git clone https://github.com/ggml-org/whisper.cpp.git", "cd whisper.cpp"],
        unix: ["git clone https://github.com/ggml-org/whisper.cpp.git", "cd whisper.cpp"],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: {
        unix: ["sh ./models/download-ggml-model.sh base", "cmake -B build", "cmake --build build -j --config Release"],
        windows: [".\\models\\download-ggml-model.cmd base", "cmake -B build", "cmake --build build -j --config Release"],
      },
      noteKey: "stt_local_install_note_whisper_cpp",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["./build/bin/whisper-server --host 127.0.0.1 --port 8080 -m models/ggml-base.bin"],
        windows: [".\\build\\bin\\Release\\whisper-server.exe --host 127.0.0.1 --port 8080 -m models\\ggml-base.bin"],
      },
      noteKey: "stt_local_run_note_whisper_cpp",
    },
  },
  {
    id: "whisperfile",
    name: "Whisperfile",
    descriptionKey: "stt_local_desc_whisperfile",
    wire: "whisper-cpp",
    port: 8080,
    endpoint: "http://127.0.0.1:8080",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: { windows: [], unix: [] },
      // The whole point of whisperfile: one executable file, no container.
      noteKey: "stt_local_docker_note_whisperfile",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        unix: [
          "curl -L -o whisper-small.llamafile https://huggingface.co/Mozilla/whisperfile/resolve/main/whisper-small.llamafile",
        ],
        windows: [
          "curl.exe -L -o whisper-small.llamafile https://huggingface.co/Mozilla/whisperfile/resolve/main/whisper-small.llamafile",
        ],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: {
        unix: ["chmod +x whisper-small.llamafile"],
        windows: ["rename whisper-small.llamafile whisper-small.llamafile.exe"],
      },
      noteKey: "stt_local_install_note_whisperfile",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["./whisper-small.llamafile"],
        windows: [".\\whisper-small.llamafile.exe"],
      },
      noteKey: "stt_local_run_note_whisperfile",
    },
  },
  {
    id: "localai",
    name: "LocalAI",
    descriptionKey: "stt_local_desc_localai",
    wire: "openai",
    port: 8080,
    endpoint: "http://127.0.0.1:8080/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        windows: ["docker run -ti --name local-ai -p 8080:8080 localai/localai:latest"],
        unix: ["docker run -ti --name local-ai -p 8080:8080 localai/localai:latest"],
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
      commands: {
        unix: [
          "curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
          "docker cp ggml-base.bin local-ai:/models/",
          "docker exec local-ai sh -c \"printf 'name: whisper-1\\nbackend: whisper\\nparameters:\\n  model: ggml-base.bin\\n' > /models/whisper-1.yaml\"",
        ],
        windows: [
          "curl.exe -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
          "docker cp ggml-base.bin local-ai:/models/",
          "docker exec local-ai sh -c \"printf 'name: whisper-1\\nbackend: whisper\\nparameters:\\n  model: ggml-base.bin\\n' > /models/whisper-1.yaml\"",
        ],
      },
      noteKey: "stt_local_install_note_localai",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["curl http://127.0.0.1:8080/v1/models"],
        windows: ["curl.exe http://127.0.0.1:8080/v1/models"],
      },
      noteKey: "stt_local_run_note_localai",
    },
  },
  {
    id: "vllm",
    name: "vLLM",
    descriptionKey: "stt_local_desc_vllm",
    wire: "openai",
    port: 8000,
    endpoint: "http://127.0.0.1:8000/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        unix: [
          'docker run --runtime nvidia --gpus all --ipc=host -p 8000:8000 -v "$PWD/.cache/huggingface:/root/.cache/huggingface" vllm/vllm-openai:latest openai/whisper-large-v3-turbo',
        ],
        windows: [
          'docker run --runtime nvidia --gpus all --ipc=host -p 8000:8000 -v "%cd%\\.cache\\huggingface:/root/.cache/huggingface" vllm/vllm-openai:latest openai/whisper-large-v3-turbo',
        ],
      },
      noteKey: "stt_local_docker_note_vllm",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: {
        windows: ["git clone https://github.com/vllm-project/vllm.git"],
        unix: ["git clone https://github.com/vllm-project/vllm.git"],
      },
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: {
        unix: ["pip install vllm[audio]"],
        windows: ["pip install vllm[audio]"],
      },
      noteKey: "stt_local_install_note_vllm",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: ["vllm serve openai/whisper-large-v3-turbo"],
        windows: ["vllm serve openai/whisper-large-v3-turbo"],
      },
      noteKey: "stt_local_run_note_vllm",
    },
  },
  {
    id: "riva-nim",
    name: "NVIDIA Riva NIM",
    descriptionKey: "stt_local_desc_riva",
    wire: "openai",
    port: 9000,
    endpoint: "http://127.0.0.1:9000/v1",
    docker: {
      titleKey: "stt_local_step_docker",
      commands: {
        unix: [
          'export NGC_API_KEY=nvapi-ВАШ_КЛЮЧ',
          'echo "$NGC_API_KEY" | docker login nvcr.io --username \'$oauthtoken\' --password-stdin',
          "docker pull nvcr.io/nim/nvidia/riva-asr:latest",
        ],
        windows: [
          '$env:NGC_API_KEY = "nvapi-ВАШ_КЛЮЧ"',
          'echo $env:NGC_API_KEY | docker login nvcr.io --username \'$oauthtoken\' --password-stdin',
          "docker pull nvcr.io/nim/nvidia/riva-asr:latest",
        ],
      },
      noteKey: "stt_local_docker_note_riva",
    },
    clone: {
      titleKey: "stt_local_step_clone",
      commands: { windows: [], unix: [] },
      // Riva ships as an NGC container — there is no source-clone install
      // path; the docker step above IS the download.
      noteKey: "stt_local_clone_note_riva",
    },
    install: {
      titleKey: "stt_local_step_install",
      commands: { windows: [], unix: [] },
      noteKey: "stt_local_install_note_riva",
    },
    run: {
      titleKey: "stt_local_step_run",
      commands: {
        unix: [
          'docker run -it --rm --name riva-asr --runtime=nvidia --gpus \'"device=0"\' --shm-size=8GB -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -p 9000:9000 -e NIM_TAGS_SELECTOR="name=whisper-large-v3,mode=all" nvcr.io/nim/nvidia/riva-asr:latest',
        ],
        windows: [
          'docker run -it --rm --name riva-asr --runtime=nvidia --gpus "device=0" --shm-size=8GB -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -p 9000:9000 -e NIM_TAGS_SELECTOR="name=whisper-large-v3,mode=all" nvcr.io/nim/nvidia/riva-asr:latest',
        ],
      },
      noteKey: "stt_local_run_note_riva",
    },
  },
];
