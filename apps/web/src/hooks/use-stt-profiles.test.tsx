import { describe, expect, it, afterEach, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  createAutoKeyProviderPool,
  createProfileCrudHarness,
  installProfileI18nSeam,
  mountProfileHook,
} from "../../test/profile-hook-harness.js";
import { wireSttProfile } from "../../test/wire-fixtures.js";

useDomEnv();

const realSttApi = await import("../api/stt-api.js");
const realProviderApi = await import("../api/provider-api.js");
const realTtsApi = await import("../api/tts-api.js");

installProfileI18nSeam();

type SttRecord = import("../api/stt-api.js").SttProfileRecord;
type CreateSttBody = Parameters<typeof realSttApi.createSttProfile>[0];
type UpdateSttBody = Parameters<typeof realSttApi.updateSttProfile>[1];

// The row fixture rides the shared wire factory (wireSttProfile — the ONE
// SttProfileRecord derivation); tests override what they pin.
const makeRecord = wireSttProfile;

const crud = createProfileCrudHarness<SttRecord, CreateSttBody, UpdateSttBody>({
  createRecord: (body, id) =>
    makeRecord({
      id,
      name: body.name,
      backend: body.backend,
      config: body.config ?? {},
    }),
  applyUpdate: (current, body) => ({ ...current, ...body }),
  withDefault: (record, isDefault) => ({ ...record, isDefault }),
  withSortOrder: (record, sortOrder) => ({ ...record, sortOrder }),
});
const { createMock, updateMock, setDefaultMock, reorderMock } = crud;

// P2: the hook fetches the provider + TTS wire lists once for the
// client-side auto-key hint. Safe pattern — real module first, spread,
// override only the functions the hook touches.
const providerPool = createAutoKeyProviderPool();
const { listProvidersMock } = providerPool;
let ttsStore: Array<{ backend: string; hasStoredApiKey: boolean; name: string }> = [];
const listTtsMock = mock(async () => [...ttsStore]);
mock.module("../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles: listProvidersMock,
}));
mock.module("../api/tts-api.js", () => ({
  ...realTtsApi,
  listAllTtsProfiles: listTtsMock,
}));

mock.module("../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: crud.listAllMock,
  createSttProfile: createMock,
  updateSttProfile: updateMock,
  deleteSttProfile: crud.deleteMock,
  setSttDefault: setDefaultMock,
  reorderSttProfiles: reorderMock,
}));

const { act, cleanup, waitFor } = await import("@testing-library/react");
const { useSttProfiles, toSttBackend } = await import("./use-stt-profiles.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  crud.reset();
  providerPool.reset();
  ttsStore = [];
  listTtsMock.mockClear();
});

describe("useSttProfiles — P2 draft auto-key hint", () => {
  it("filters name and backend without changing source order, then persists reordered records", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];
    const hookRef = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hookRef.current?.loading).toBe(false));
    await act(async () => hookRef.current?.setProfileSearch?.("gemini"));
    expect(hookRef.current?.filteredProfiles?.map((profile) => profile.id)).toEqual(["p2"]);
    expect(hookRef.current?.profiles.map((profile) => profile.id)).toEqual(["p1", "p2"]);
    await act(async () => hookRef.current?.reorder?.([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]));
    expect(reorderMock).toHaveBeenCalledWith([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]);
    expect(hookRef.current?.profiles.map((profile) => profile.id)).toEqual(["p2", "p1"]);
  });

  it("gemini draft: vendor match resolves the provider name pre-save (the owner repro)", async () => {
    providerPool.rows = [
      { endpoint: "https://openrouter.ai/api/v1", hasStoredApiKey: true, name: "OpenRouter" },
      { endpoint: "https://generativelanguage.googleapis.com", hasStoredApiKey: true, name: "Gemini" },
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    await waitFor(() => expect(listProvidersMock).toHaveBeenCalled());
    // Fresh create flow on the gemini backend — NO save anywhere — the hint
    // must resolve from the client-side vendor match (first keyful provider
    // on the Gemini API host; the active-flag never participates).
    act(() => hook.current!.startCreate());
    act(() => hook.current!.setForm({ backend: "gemini" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("Gemini"));
    // A server-decorated saved record still wins over the live computation.
    act(() => hook.current!.setForm({ autoKeyProviderName: "Decorated" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("Decorated"));
  });

  it("gemini draft: falls back to a stored-key gemini TTS profile when no provider matches", async () => {
    providerPool.rows = [{ endpoint: "https://generativelanguage.googleapis.com", hasStoredApiKey: false, name: "GeminiNoKey" }];
    ttsStore = [{ backend: "gemini", hasStoredApiKey: true, name: "My Google TTS" }];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    act(() => hook.current!.startCreate());
    act(() => hook.current!.setForm({ backend: "gemini" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("My Google TTS"));
  });

  it("openai-compat draft: endpoint match with normalization; no match → null; whisper → null", async () => {
    providerPool.rows = [
      { endpoint: "NanoGPT", hasStoredApiKey: false, name: "NoKey" },
      { endpoint: "https://nano-gpt.com/api/v1/", hasStoredApiKey: true, name: "NanoLLM" },
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    act(() => hook.current!.startCreate());
    act(() => hook.current!.setForm({ backend: "openai-compat" }));
    // Trim + scheme + trailing slashes + case all normalize (the server rule).
    act(() => hook.current!.setForm({ config: { endpoint: "https://NANO-GPT.com/api/v1//" } }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("NanoLLM"));
    // No match → null (no fake hint).
    act(() => hook.current!.setForm({ config: { endpoint: "https://nowhere.example/v1" } }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBeNull());
    // The browser tier never carries an auto-key hint.
    act(() => hook.current!.setForm({ backend: "whisper-browser" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBeNull());
  });

  it("native drafts (SPE-4..6): vendor host providers win, then same-vendor TTS; nvidia has no TTS arm", async () => {
    providerPool.rows = [
      { endpoint: "https://api.deepgram.com", hasStoredApiKey: true, name: "Deepgram LLM" },
      { endpoint: "https://integrate.api.nvidia.com/v1", hasStoredApiKey: true, name: "NVIDIA LLM" },
    ];
    ttsStore = [
      { backend: "deepgram", hasStoredApiKey: true, name: "My Deepgram TTS" },
      { backend: "elevenlabs", hasStoredApiKey: true, name: "My ElevenLabs TTS" },
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    act(() => hook.current!.startCreate());

    // deepgram: the provider on the vendor host wins over the TTS profile
    // (the server rule order).
    act(() => hook.current!.setForm({ backend: "deepgram" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("Deepgram LLM"));

    // elevenlabs: no provider on the host → the same-vendor TTS key hint.
    act(() => hook.current!.setForm({ backend: "elevenlabs" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("My ElevenLabs TTS"));

    // nvidia: provider on the vendor host; no TTS arm exists, a stray
    // TTS profile must never match.
    act(() => hook.current!.setForm({ backend: "nvidia" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("NVIDIA LLM"));
  });

  it("native draft without a host provider falls back to the same-vendor TTS key", async () => {
    providerPool.rows = [{ endpoint: "https://openrouter.ai/api/v1", hasStoredApiKey: true, name: "OR" }];
    ttsStore = [{ backend: "deepgram", hasStoredApiKey: true, name: "My Deepgram TTS" }];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    act(() => hook.current!.startCreate());
    act(() => hook.current!.setForm({ backend: "deepgram" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("My Deepgram TTS"));
  });
});

describe("useSttProfiles — CRUD", () => {
  it("loads profiles on mount and supports select + startCreate", async () => {
    crud.store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "openai-compat" }),
      makeRecord({ id: "p2", name: "Beta", backend: "whisper-browser" }),
    ];

    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(hook.current!.loading).toBe(false);
    expect(hook.current!.error).toBeNull();

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current!.editingId).toBe("p1"));
    expect(hook.current!.form?.name).toBe("Alpha");
    expect(hook.current!.form?.backend).toBe("openai-compat");
    expect(hook.current!.dirty).toBe(false);

    hook.current!.setForm({ name: "Alpha-2" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    expect(hook.current!.form?.name).toBe("Alpha-2");

    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    // Tier-0 default: in-browser whisper with the roster default model.
    expect(hook.current!.form?.backend).toBe("whisper-browser");
    expect(hook.current!.form?.config.model).toBe("onnx-community/whisper-base");
    expect(hook.current!.form?.name).toBe("stt_profile_default_name");
    expect(hook.current!.editingId).toBeNull();
  });

  it("save creates when form.id is null and updates when id exists; blank key is omitted", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];

    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    hook.current!.setForm({ name: "NewOne", config: { endpoint: "https://x/v1", model: "whisper-1" } });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(createMock).toHaveBeenCalled();
    const createArg = (createMock.mock.calls[0] as unknown[])[0] as {
      name: string;
      backend: string;
      apiKey?: string;
    };
    expect(createArg.name).toBe("NewOne");
    // Blank form key = no key sent (undefined, not an empty string).
    expect(createArg.apiKey).toBeUndefined();

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    hook.current!.setForm({ name: "Alpha-renamed" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() =>
      expect(hook.current?.profiles.find((p: SttRecord) => p.id === "p1")?.name).toBe("Alpha-renamed"),
    );
    expect(updateMock).toHaveBeenCalled();
  });

  it("save failure sets error", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];
    crud.failUpdate = true;

    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    hook.current!.setForm({ name: "BadName" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.error).toContain("save boom"));
    crud.failUpdate = false;
  });

  it("remove deletes the selected profile and clears selection", async () => {
    crud.store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" }),
      makeRecord({ id: "p2", name: "Beta", backend: "openai-compat" }),
    ];

    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    await hook.current!.remove();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    expect(hook.current!.form).toBeNull();
    expect(hook.current!.editingId).toBeNull();
  });

  it("setDefault calls the API and refreshes profiles", async () => {
    crud.store = [
      makeRecord({ id: "p1", isDefault: true }),
      makeRecord({ id: "p2", isDefault: false }),
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    await hook.current!.setDefault("p2");
    await waitFor(() => expect(setDefaultMock).toHaveBeenCalled());
    expect(setDefaultMock.mock.calls[0]?.[0]).toBe("p2");
    await waitFor(() =>
      expect(hook.current?.profiles.find((p: SttRecord) => p.id === "p2")?.isDefault).toBe(true),
    );
  });

  it("defaultProfileId tracks the persisted default: null when none, moves with setDefault", async () => {
    crud.store = [makeRecord({ id: "p1", isDefault: false }), makeRecord({ id: "p2", isDefault: false })];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    // No flagged row → null (the ImageGen effectiveActiveId `?? null` arm).
    expect(hook.current!.defaultProfileId).toBeNull();
    await hook.current!.setDefault("p2");
    await waitFor(() => expect(hook.current?.defaultProfileId).toBe("p2"));
    // Moving the pointer leaves exactly one flagged row — the target.
    await hook.current!.setDefault("p1");
    await waitFor(() => expect(hook.current?.defaultProfileId).toBe("p1"));
    expect(hook.current!.profiles.filter((p: SttRecord) => p.isDefault).map((p: SttRecord) => p.id)).toEqual(["p1"]);
    cleanup();
  });
});

describe("useSttProfiles — backend switch + key lifecycle", () => {
  it("switching backends resets config, apiKey and hasStoredApiKey", async () => {
    crud.store = [
      makeRecord({
        id: "p1",
        backend: "openai-compat",
        config: { endpoint: "https://api.example.com/v1", model: "whisper-1" },
        hasStoredApiKey: true,
      }),
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.backend).toBe("openai-compat"));
    expect(hook.current!.form?.hasStoredApiKey).toBe(true);
    expect(hook.current!.form?.config.endpoint).toBe("https://api.example.com/v1");

    // Backend switch → whisper-browser: config resets to the roster default,
    // a stored key never survives into the new backend.
    hook.current!.setForm({ backend: "whisper-browser" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("whisper-browser"));
    expect(hook.current!.form?.config).toEqual({ model: "onnx-community/whisper-base" });
    expect(hook.current!.form?.hasStoredApiKey).toBe(false);
    expect(hook.current!.form?.apiKey).toBe("");

    // Back to openai-compat: config wipes.
    hook.current!.setForm({ backend: "openai-compat" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("openai-compat"));
    expect(hook.current!.form?.config).toEqual({});
  });

  it("switching to a native backend prefills its doc-verified default model (SPE-4..6)", async () => {
    crud.store = [makeRecord({ id: "p1", backend: "openai-compat", config: { endpoint: "https://api.example.com/v1", model: "whisper-1" } })];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.backend).toBe("openai-compat"));

    // Same rule as gemini (ST-7): the level-2 picker must be non-empty
    // before the first save — the visible twin of the adapters' server-side
    // DEFAULT_*_STT_MODEL fallbacks.
    hook.current!.setForm({ backend: "deepgram" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("deepgram"));
    expect(hook.current!.form?.config).toEqual({ model: "nova-3" });
    hook.current!.setForm({ backend: "elevenlabs" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("elevenlabs"));
    expect(hook.current!.form?.config).toEqual({ model: "scribe_v2" });
    hook.current!.setForm({ backend: "nvidia" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("nvidia"));
    expect(hook.current!.form?.config).toEqual({ model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" });
  });

  it("select() mirrors autoKeyProviderName from the saved record", async () => {
    crud.store = [
      makeRecord({
        id: "p1",
        backend: "openai-compat",
        autoKeyProviderName: "OpenAI",
      }),
    ];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.autoKeyProviderName).toBe("OpenAI"));
  });
});

describe("useSttProfiles — headerMode machine", () => {
  it("select -> view; startEdit -> edit; save returns to view; cancelEdit restores", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "whisper-browser" })];
    const hook = await mountProfileHook(() => useSttProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    expect(hook.current!.headerMode).toBe("view");

    hook.current!.startEdit();
    await waitFor(() => expect(hook.current?.headerMode).toBe("edit"));
    hook.current!.setForm({ name: "Discard me" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    hook.current!.cancelEdit();
    await waitFor(() => expect(hook.current?.headerMode).toBe("view"));
    expect(hook.current!.form?.name).toBe("Alpha");
    expect(hook.current!.dirty).toBe(false);

    hook.current!.save();
    await waitFor(() => expect(hook.current?.headerMode).toBe("view"));
  });
});

describe("toSttBackend", () => {
  it("known slugs pass through; unknown degrade to whisper-browser", () => {
    expect(toSttBackend("openai-compat")).toBe("openai-compat");
    expect(toSttBackend("whisper-browser")).toBe("whisper-browser");
    expect(toSttBackend("future-backend")).toBe("whisper-browser");
  });
});
