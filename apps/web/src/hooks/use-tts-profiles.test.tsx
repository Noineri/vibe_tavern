import { describe, expect, it, afterEach, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  createAutoKeyProviderPool,
  createProfileCrudHarness,
  installProfileI18nSeam,
  mountProfileHook,
} from "../../test/profile-hook-harness.js";
import { wireTtsProfile } from "../../test/wire-fixtures.js";

useDomEnv();

const realTtsApi = await import("../api/tts-api.js");
const realProviderApi = await import("../api/provider-api.js");
// Voice-map cache seam: the hook must invalidate the chat-side snapshot
// after every successful mutation (live incident 2026-09-05 — default
// switch narrated with the OLD profile until a link mutation refreshed).
// Safe mock.module pattern: real module first, spread, override one fn.
const realVoiceMapData = await import("../lib/tts/voice-map-data.js");
const refreshVoiceMapMock = mock(async () => {});
mock.module("../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  refreshVoiceMapData: refreshVoiceMapMock,
}));

installProfileI18nSeam();

type TtsRecord = import("../api/tts-api.js").TtsProfileRecord;
type CreateTtsBody = Parameters<typeof realTtsApi.createTtsProfile>[0];
type UpdateTtsBody = Parameters<typeof realTtsApi.updateTtsProfile>[1];

// The row fixture rides the shared wire factory (wireTtsProfile — the ONE
// TtsProfileRecord derivation); tests override what they pin.
const makeRecord = wireTtsProfile;

const crud = createProfileCrudHarness<TtsRecord, CreateTtsBody, UpdateTtsBody>({
  createRecord: (body, id) =>
    makeRecord({
      id,
      name: body.name,
      backend: body.backend,
      config: body.config ?? {},
      voiceId: body.voiceId ?? "",
      narratorVoiceId: body.narratorVoiceId ?? null,
    }),
  applyUpdate: (current, body) => ({ ...current, ...body }),
  withDefault: (record, isDefault) => ({ ...record, isDefault }),
  withSortOrder: (record, sortOrder) => ({ ...record, sortOrder }),
});
const { createMock, updateMock, deleteMock, setDefaultMock, reorderMock } = crud;

mock.module("../api/tts-api.js", () => ({
  ...realTtsApi,
  listAllTtsProfiles: crud.listAllMock,
  createTtsProfile: createMock,
  updateTtsProfile: updateMock,
  deleteTtsProfile: deleteMock,
  setTtsDefault: setDefaultMock,
  reorderTtsProfiles: reorderMock,
}));

// D21: the hook fetches the provider wire list once for the client-side
// auto-key hint. Same safe pattern as above — real module first, spread,
// override only the one function the hook touches.
const providerPool = createAutoKeyProviderPool();
const { listProvidersMock } = providerPool;
mock.module("../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles: listProvidersMock,
}));

const { act, cleanup, waitFor } = await import("@testing-library/react");
const { useTtsProfiles } = await import("./use-tts-profiles.js");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  crud.reset();
  providerPool.reset();
  refreshVoiceMapMock.mockClear();
});

describe("useTtsProfiles", () => {
  it("filters name and backend without changing source order, then persists reordered records", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];
    const hookRef = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hookRef.current?.loading).toBe(false));
    await act(async () => hookRef.current?.setProfileSearch?.("gemini"));
    expect(hookRef.current?.filteredProfiles?.map((profile) => profile.id)).toEqual(["p2"]);
    expect(hookRef.current?.profiles.map((profile) => profile.id)).toEqual(["p1", "p2"]);
    await act(async () => hookRef.current?.reorder?.([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]));
    expect(reorderMock).toHaveBeenCalledWith([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]);
    expect(hookRef.current?.profiles.map((profile) => profile.id)).toEqual(["p2", "p1"]);
  });

  it("D21 draft auto-key hint: a draft endpoint matching a keyful provider resolves the name client-side", async () => {
    providerPool.rows = [
      { endpoint: "NanoGPT", hasStoredApiKey: false, name: "NoKey" },
      { endpoint: "https://nano-gpt.com/api/v1/", hasStoredApiKey: true, name: "NanoLLM" },
      { endpoint: "https://openrouter.ai/api/v1", hasStoredApiKey: true, name: "OpenRouter" },
    ];
    crud.store = [];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    await waitFor(() => expect(listProvidersMock).toHaveBeenCalled());
    // Draft: create flow + openai-compat backend + matching endpoint (trim,
    // scheme, trailing slash and case all normalize) → FIRST keyful match.
    act(() => hook.current!.startCreate());
    // Two separate patches: a backend switch wipes config by design
    // (stale keys must not leak into the new backend's config).
    act(() => hook.current!.setForm({ backend: "openai-compatible" }));
    act(() => hook.current!.setForm({ config: { endpoint: "https://NANO-GPT.com/api/v1//" } }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("NanoLLM"));
    // A decorated saved record still wins over the live computation.
    act(() => hook.current!.setForm({ autoKeyProviderName: "Decorated" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("Decorated"));
    // No match → null (no fake hint).
    act(() => hook.current!.setForm({ autoKeyProviderName: null, config: { endpoint: "https://nowhere.example/v1" } }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBeNull());
  });

  it("loads profiles on mount and supports select + startCreate", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];

    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(hook.current!.loading).toBe(false);
    expect(hook.current!.error).toBeNull();

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current!.editingId).toBe("p1"));
    expect(hook.current!.form?.name).toBe("Alpha");
    expect(hook.current!.form?.backend).toBe("kokoro");
    expect(hook.current!.dirty).toBe(false);

    hook.current!.setForm({ name: "Alpha-2" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    expect(hook.current!.form?.name).toBe("Alpha-2");

    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    expect(hook.current!.form?.backend).toBe("kokoro");
    // D20: prefilled localized default name. This probe renders without an
    // i18n provider, so the context default `t` is the raw-key identity.
    expect(hook.current!.form?.name).toBe("tts_profile_default_name");
    expect(hook.current!.editingId).toBeNull();
  });

  it("save creates a new profile when form.id is null and updates when id exists", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" })];

    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    hook.current!.setForm({ name: "NewOne", backend: "gemini" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(createMock).toHaveBeenCalled();
    const createArg = (createMock.mock.calls[0] as unknown[])[0] as { name: string; backend: string };
    expect(createArg.name).toBe("NewOne");
    expect(createArg.backend).toBe("gemini");

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    hook.current!.setForm({ name: "Alpha-renamed" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.profiles.find((p: TtsRecord) => p.id === "p1")?.name).toBe("Alpha-renamed"));
    expect(updateMock).toHaveBeenCalled();
  });

  it("save failure sets error", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" })];
    crud.failUpdate = true;

    const hook = await mountProfileHook(() => useTtsProfiles());
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
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" }), makeRecord({ id: "p2", name: "Beta", backend: "gemini" })];

    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    await hook.current!.remove();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    expect(hook.current!.form).toBeNull();
    expect(hook.current!.editingId).toBeNull();
  });

  it("backend switch resets config and voiceId (kokoro defaults af_heart)", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro", config: { speed: 1.5 }, voiceId: "af_heart" })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.backend).toBe("kokoro"));
    expect(hook.current!.form?.config).toEqual({ speed: 1.5 });
    expect(hook.current!.form?.voiceId).toBe("af_heart");
    hook.current!.setForm({ backend: "gemini" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("gemini"));
    expect(hook.current!.form?.config).toEqual({});
    expect(hook.current!.form?.voiceId).toBe("");
    hook.current!.setForm({ backend: "kokoro" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("kokoro"));
    expect(hook.current!.form?.config).toEqual({});
    expect(hook.current!.form?.voiceId).toBe("af_heart");
  });

  it("narratorVoiceId round-trips through select/startCreate/backend-switch/save", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro", narratorVoiceId: "af_bella" })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.narratorVoiceId).toBe("af_bella"));
    // Backend switch resets narratorVoiceId
    hook.current!.setForm({ backend: "gemini" });
    await waitFor(() => expect(hook.current?.form?.narratorVoiceId).toBe(""));
    // Set narrator and save — payload maps "" -> null and value -> string
    hook.current!.setForm({ narratorVoiceId: "Kore" });
    await waitFor(() => expect(hook.current?.form?.narratorVoiceId).toBe("Kore"));
    hook.current!.setForm({ name: "Alpha2" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const updateArg = (updateMock.mock.calls[updateMock.mock.calls.length - 1] as unknown[])[1] as { narratorVoiceId: string | null };
    expect(updateArg.narratorVoiceId).toBe("Kore");
    // Empty narrator maps to null
    hook.current!.setForm({ narratorVoiceId: "" });
    await waitFor(() => expect(hook.current?.form?.narratorVoiceId).toBe(""));
    hook.current!.setForm({ name: "Alpha3" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(updateMock.mock.calls.length).toBe(2));
    const secondArg = (updateMock.mock.calls[1] as unknown[])[1] as { narratorVoiceId: string | null };
    expect(secondArg.narratorVoiceId).toBeNull();
    // startCreate defaults narratorVoiceId to ""
    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    expect(hook.current!.form?.narratorVoiceId).toBe("");
    cleanup();
  });

  it("save passes config and voiceId through create and update", async () => {
    crud.store = [];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    // Set config + voiceId on the new form
    hook.current!.setForm({ config: { endpoint: "https://x", speed: 1.2 }, voiceId: "test-voice" });
    await waitFor(() => expect(hook.current?.form?.voiceId).toBe("test-voice"));
    hook.current!.setForm({ name: "NewOne" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    const created = crud.store[0]!;
    expect(created.config).toEqual({ endpoint: "https://x", speed: 1.2 });
    expect(created.voiceId).toBe("test-voice");
    // Update path
    hook.current!.select(created.id);
    await waitFor(() => expect(hook.current?.form?.id).toBe(created.id));
    hook.current!.setForm({ config: { apiKey: "k123" }, voiceId: "new-voice" });
    await waitFor(() => expect(hook.current?.form?.voiceId).toBe("new-voice"));
    hook.current!.setForm({ name: "Renamed" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(crud.store.find((p) => p.id === created.id)?.voiceId).toBe("new-voice"));
    expect(crud.store.find((p) => p.id === created.id)?.config).toEqual({ apiKey: "k123" });
  });

  it("startCreate defaults to kokoro + af_heart", async () => {
    crud.store = [];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));
    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    expect(hook.current!.form?.backend).toBe("kokoro");
    expect(hook.current!.form?.voiceId).toBe("af_heart");
    expect(hook.current!.form?.config).toEqual({});
  });
});

// ─── F5/F2b: the form mirrors the record's hasStoredApiKey and drops it on
// a backend switch — the UI must never believe a stored key survives a
// backend change (server-side merge has the same guard, pinned in
// services/api/test/tts-routes.test.ts). ─────────────────────────────────

describe("useTtsProfiles — hasStoredApiKey lifecycle (F2b)", () => {
  it("select() mirrors the record's hasStoredApiKey into the form", async () => {
    crud.store = [
      makeRecord({
        id: "p1",
        backend: "openai-compatible",
        config: { endpoint: "https://api.example.com/v1" },
        hasStoredApiKey: true,
      }),
      makeRecord({ id: "p2", backend: "gemini", config: {}, hasStoredApiKey: false }),
    ];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current!.editingId).toBe("p1"));
    expect(hook.current!.form?.hasStoredApiKey).toBe(true);

    hook.current!.select("p2");
    await waitFor(() => expect(hook.current!.form?.backend).toBe("gemini"));
    expect(hook.current!.form?.hasStoredApiKey).toBe(false);
    cleanup();
  });

  it("switching the backend resets hasStoredApiKey to false", async () => {
    crud.store = [
      makeRecord({
        id: "p1",
        backend: "openai-compatible",
        config: { endpoint: "https://api.example.com/v1", apiKey: "" },
        hasStoredApiKey: true,
      }),
    ];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current!.form?.hasStoredApiKey).toBe(true));

    hook.current!.setForm({ backend: "gemini", config: {}, voiceId: "" });
    await waitFor(() => expect(hook.current!.form?.backend).toBe("gemini"));
    expect(hook.current!.form?.hasStoredApiKey).toBe(false);
    cleanup();
  });
});

describe("useTtsProfiles — TE2-10 editor screen machine (headerMode, LLM mechanism)", () => {
  it("select() -> view; setForm keeps view; save() from edit -> view; startCreate/startEdit -> edit; cancelEdit -> view", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "kokoro" })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    // No form yet — the modal shows the empty placeholder, not the editor.
    expect(hook.current!.form).toBeNull();
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    // Selecting a SAVED profile opens in view mode (the base card), not the form.
    expect(hook.current!.headerMode).toBe("view");
    expect(hook.current!.dirty).toBe(false);
    // Config-section edits (voice, tuning) mark dirty but do NOT open the
    // connection form screen — LLM mechanism: the edit screen is a separate
    // menu entered only via Edit settings / New.
    hook.current!.setForm({ name: "Alpha-2" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    expect(hook.current!.headerMode).toBe("view");
    // The connection screen opens from Edit settings.
    hook.current!.startEdit();
    await waitFor(() => expect(hook.current?.headerMode).toBe("edit"));
    // Save returns to the view card.
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.headerMode).toBe("view"));
    expect(hook.current!.dirty).toBe(false);
    // New profile opens straight in edit mode.
    hook.current!.startCreate();
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    expect(hook.current!.headerMode).toBe("edit");
    // Canceling a NEW profile drops the draft entirely (form null — the
    // modal placeholder), view mode.
    hook.current!.cancelEdit();
    await waitFor(() => expect(hook.current?.form).toBeNull());
    expect(hook.current!.headerMode).toBe("view");
    // Canceling an EDIT of a saved profile restores the saved values.
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    hook.current!.startEdit();
    await waitFor(() => expect(hook.current?.headerMode).toBe("edit"));
    hook.current!.setForm({ name: "Discard me" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    hook.current!.cancelEdit();
    await waitFor(() => expect(hook.current?.headerMode).toBe("view"));
    expect(hook.current!.form?.name).toBe("Alpha-2");
    expect(hook.current!.dirty).toBe(false);
    cleanup();
  });

  it("setDefault() calls the API and refreshes profiles", async () => {
    crud.store = [makeRecord({ id: "p1", isDefault: true }), makeRecord({ id: "p2", isDefault: false })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(crud.store.find((p) => p.id === "p1")?.isDefault).toBe(true);
    expect(crud.store.find((p) => p.id === "p2")?.isDefault).toBe(false);
    await hook.current!.setDefault("p2");
    await waitFor(() => expect(setDefaultMock).toHaveBeenCalled());
    expect(setDefaultMock.mock.calls[0]?.[0]).toBe("p2");
    await waitFor(() => expect(hook.current?.profiles.find((p: TtsRecord) => p.id === "p2")?.isDefault).toBe(true));
    expect(hook.current!.profiles.find((p: TtsRecord) => p.id === "p1")?.isDefault).toBe(false);
    // The chat-side voice-map snapshot was invalidated (the actual bug).
    expect(refreshVoiceMapMock).toHaveBeenCalled();
    cleanup();
  });

  it("defaultProfileId tracks the persisted default: null when none, moves with setDefault", async () => {
    crud.store = [makeRecord({ id: "p1", isDefault: false }), makeRecord({ id: "p2", isDefault: false })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    // No flagged row → null (the ImageGen effectiveActiveId `?? null` arm).
    expect(hook.current!.defaultProfileId).toBeNull();
    await hook.current!.setDefault("p2");
    await waitFor(() => expect(hook.current?.defaultProfileId).toBe("p2"));
    // Moving the pointer leaves exactly one flagged row — the target.
    await hook.current!.setDefault("p1");
    await waitFor(() => expect(hook.current?.defaultProfileId).toBe("p1"));
    expect(hook.current!.profiles.filter((p: TtsRecord) => p.isDefault).map((p: TtsRecord) => p.id)).toEqual(["p1"]);
    cleanup();
  });

  it("profile mutations (save/remove) invalidate the chat-side voice-map cache", async () => {
    crud.store = [makeRecord({ id: "p1", isDefault: true, name: "Old" })];
    const hook = await mountProfileHook(() => useTtsProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    expect(refreshVoiceMapMock).not.toHaveBeenCalled();

    // Save (rename) → cache invalidated. Each step wrapped in act: the
    // hook's callbacks close over state from the LAST render, so the form
    // updates must flush before save() is invoked.
    await act(async () => {
      hook.current!.select("p1");
    });
    await act(async () => {
      hook.current!.setForm({ name: "New" });
    });
    await act(async () => {
      await hook.current!.save();
    });
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(refreshVoiceMapMock).toHaveBeenCalledTimes(1);

    // Remove → cache invalidated again.
    await act(async () => {
      await hook.current!.remove();
    });
    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(refreshVoiceMapMock).toHaveBeenCalledTimes(2);
    cleanup();
  });
});

