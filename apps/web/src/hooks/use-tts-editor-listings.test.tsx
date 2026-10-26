/** useTtsEditorListings pins (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11c):
 *  which modes and backends arm a listing at all. A listing that is armed shows
 *  as `loading` in the very commit that mounts the hook (the request itself
 *  leaves after the debounce), so "armed or not" is read synchronously - no
 *  waiting for a request that must NOT happen. The request shapes and the
 *  re-run rules are pinned through the editor in TtsProfileEditor.test.tsx. */
import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

// Safe mock.module pattern: real module first, spread, override ONLY the two
// listing calls (nothing here may reach the network).
const realTtsApi = await import("../api/tts-api.js");
const listTtsDraftVoicesMock = mock(async () => ({ voices: null, capabilities: { supportsCloning: false } }));
const listTtsDraftModelsMock = mock(async () => []);
mock.module("../api/tts-api.js", () => ({
  ...realTtsApi,
  listTtsDraftVoices: listTtsDraftVoicesMock,
  listTtsDraftModels: listTtsDraftModelsMock,
}));

const { renderHook } = await import("@testing-library/react");
const { TTS_BACKEND } = await import("@vibe-tavern/domain");
const { useTtsEditorListings } = await import("./use-tts-editor-listings.js");

type Form = NonNullable<Parameters<typeof useTtsEditorListings>[0]["form"]>;

function formFor(backend: Form["backend"]): Form {
  return {
    id: "p1",
    name: "Profile",
    backend,
    config: {},
    apiKey: "",
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "",
    narratorVoiceId: "",
    hasStoredApiKey: false,
  };
}

function armed(backend: Form["backend"], enabled: boolean) {
  const { result } = renderHook(() =>
    useTtsEditorListings({ form: formFor(backend), enabled, setForm: () => {} }),
  );
  return { voices: result.current.voicesLoading, models: result.current.modelsLoading };
}

describe("useTtsEditorListings - what arms a listing", () => {
  it("edit mode (not enabled) arms nothing for any remote backend, however it is configured", () => {
    for (const backend of [TTS_BACKEND.OpenAiCompatible, TTS_BACKEND.Gemini, TTS_BACKEND.Inworld, TTS_BACKEND.MiniMax, TTS_BACKEND.ElevenLabs]) {
      expect(armed(backend, false)).toEqual({ voices: false, models: false });
    }
  });

  it("view mode arms the voices of every remote backend and the models of every FETCH-mode model spec", () => {
    // Fetch-mode model specs: openai-compatible/local, Gemini, Inworld, MiniMax.
    for (const backend of [TTS_BACKEND.OpenAiCompatible, TTS_BACKEND.Gemini, TTS_BACKEND.Inworld, TTS_BACKEND.MiniMax]) {
      expect(armed(backend, true)).toEqual({ voices: true, models: true });
    }
    // Input-mode model fields (no models endpoint) and the cloud rosters: voices only.
    for (const backend of [TTS_BACKEND.ElevenLabs, TTS_BACKEND.Cartesia, TTS_BACKEND.Lmnt, TTS_BACKEND.Volcengine, TTS_BACKEND.Azure, TTS_BACKEND.Polly]) {
      expect(armed(backend, true)).toEqual({ voices: true, models: false });
    }
  });

  it("kokoro runs in the browser: it lists nothing, even in view mode", () => {
    expect(armed(TTS_BACKEND.Kokoro, true)).toEqual({ voices: false, models: false });
  });

  it("no form, no listing", () => {
    const { result } = renderHook(() => useTtsEditorListings({ form: null, enabled: true, setForm: () => {} }));
    expect(result.current.voicesLoading).toBe(false);
    expect(result.current.modelsLoading).toBe(false);
    expect(result.current.voices).toBeNull();
    expect(result.current.models).toBeNull();
    expect(result.current.cloneCaps).toBeNull();
  });
});
