import { describe, expect, it, afterEach, mock } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  createAutoKeyProviderPool,
  createProfileCrudHarness,
  mountProfileHook,
} from "../../test/profile-hook-harness.js";
import { wireImageGenProfile } from "../../test/wire-fixtures.js";

useDomEnv();

// Safe pattern — real module first, spread, override only the functions the
// hook touches.
const realImageGenApi = await import("../api/image-gen-api.js");
// IG-21: the auto-key hint mirror's input seam — the provider list mock.
const realProviderApi = await import("../api/provider-api.js");

type ImageGenRecord = import("../api/image-gen-api.js").ImageGenProfileRecord;
type CreateImageGenBody = Parameters<typeof realImageGenApi.createImageGenProfile>[0];
type UpdateImageGenBody = Parameters<typeof realImageGenApi.updateImageGenProfile>[1];
type ImageGenModelEntry = import("../api/image-gen-api.js").ImageGenModelEntry;
type ImageGenSampler = import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue;
type ImageGenFavorite = import("@vibe-tavern/api-contracts").ImageGenModelFavoriteValue;

// The row fixture rides the shared wire factory (wireImageGenProfile — the
// ONE ImageGenProfileRecord derivation); tests override what they pin.
const makeRecord = wireImageGenProfile;

const crud = createProfileCrudHarness<ImageGenRecord, CreateImageGenBody, UpdateImageGenBody>({
  createRecord: (body, id) =>
    makeRecord({
      id,
      name: body.name,
      backend: body.backend,
      presetId: body.presetId,
      endpoint: body.endpoint,
      hasStoredApiKey: body.apiKey !== undefined && body.apiKey !== "",
      ...(body.capabilities ? { capabilities: body.capabilities } : {}),
    }),
  applyUpdate: (current, body) => {
    const { apiKey: _apiKey, presetId, modelId, llmProviderProfileId, llmModelId, ...rest } = body;
    return {
      ...current,
      ...rest,
      presetId: presetId === undefined ? current.presetId : (presetId ?? undefined),
      modelId: modelId === undefined ? current.modelId : (modelId ?? undefined),
      llmProviderProfileId:
        llmProviderProfileId === undefined
          ? current.llmProviderProfileId
          : (llmProviderProfileId ?? undefined),
      llmModelId: llmModelId === undefined ? current.llmModelId : (llmModelId ?? undefined),
    };
  },
  withDefault: (record, isDefault) => ({ ...record, isDefault }),
  withSortOrder: (record, sortOrder) => ({ ...record, sortOrder }),
});
const { createMock, updateMock, setDefaultMock, reorderMock } = crud;

const modelsMock = mock(async (id: string): Promise<{ data: ImageGenModelEntry[]; snapshotAt: string | null } | null> => {
  if (id === "missing") return null;
  return {
    data: [
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", isFree: false },
      { id: "openai/gpt-image-2", label: "GPT Image 2", isFree: true },
    ],
    snapshotAt: null,
  };
});
const samplersMock = mock(async (id: string): Promise<ImageGenSampler[] | null> => {
  if (id === "missing") return null;
  return [{ name: "Euler a", aliases: ["k_euler_a"] }, { name: "DPM++ 2M" }];
});
const schedulersMock = mock(async (id: string): Promise<Array<{ name: string; label?: string }> | null> => {
  if (id === "missing") return null;
  return [{ name: "karras", label: "Karras" }, { name: "sgm_uniform" }];
});
// T3 hint parity: the DiT sidecar list seam (the pane's failure flag).
const sidecarsMock = mock(
  async (id: string): Promise<{ data: { encoders: string[]; vaes: string[] }; snapshotAt: string | null } | null> => {
    if (id === "missing") return null;
    return {
      data: { encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vaes: ["qwen_image_vae.safetensors"] },
      snapshotAt: null,
    };
  },
);
// IG-12b: select() quietly loads the profile's star-favorites — mocked
// empty so the REAL fetch never runs in happy-dom (its network-block error
// used to be masked by fetchSamplers' old setError(null) wipe, which
// IG-CF12a removed; the pane-test harness already mocks this seam).
const favoritesMock = mock(async (_id: string): Promise<ImageGenFavorite[]> => []);
const draftModelsMock = mock(
  async (body: { backend: string; config: Record<string, unknown>; profileId?: string }): Promise<ImageGenModelEntry[]> => {
    if (body.config.endpoint === "https://boom.example") throw new Error("draft boom");
    return [{ id: "draft-model", label: "Draft Model" }];
  },
);
// IG-21 auto-key mirror pool: one keyful provider on the OpenRouter vendor
// host, one keyful on an exact OpenAI endpoint, one keyless on the vendor
// host (the cascade never takes a keyless provider's "key").
const providerPool = createAutoKeyProviderPool([
  { endpoint: "https://openrouter.ai/api/v1", hasStoredApiKey: true, name: "OR main" },
  { endpoint: "https://api.openai.com/v1", hasStoredApiKey: true, name: "OAi main" },
  { endpoint: "https://nano-gpt.com/api/v1", hasStoredApiKey: true, name: "Nano main" },
  { endpoint: "https://openrouter.ai/api/v2", hasStoredApiKey: false, name: "Keyless OR" },
]);

mock.module("../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: crud.listAllMock,
  reorderImageGenProfiles: reorderMock,
  setImageGenDefault: setDefaultMock,
  createImageGenProfile: createMock,
  updateImageGenProfile: updateMock,
  deleteImageGenProfile: crud.deleteMock,
  listImageGenModels: modelsMock,
  listImageGenSamplers: samplersMock,
  listImageGenSchedulers: schedulersMock,
  listImageGenDitSidecars: sidecarsMock,
  listImageGenModelFavorites: favoritesMock,
  draftListImageGenModels: draftModelsMock,
}));

mock.module("../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles: providerPool.listProvidersMock,
}));

const { act, cleanup, waitFor } = await import("@testing-library/react");
const { useImageProfiles } = await import("./use-image-profiles.js");
const { toImageGenBackend } = await import("../components/settings/provider/imagegen/imagegen-form-helpers.js");
const { IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_BACKENDS } = await import("@vibe-tavern/domain");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  crud.reset();
  providerPool.reset();
  modelsMock.mockClear();
  samplersMock.mockClear();
  favoritesMock.mockClear();
  draftModelsMock.mockClear();
});

describe("useImageProfiles — CRUD", () => {
  it("filters by name or the visible preset label and persists complete reorder updates", async () => {
    crud.store = [
      makeRecord({ id: "p1", name: "Forge local", backend: "a1111", presetId: "a1111", sortOrder: 0 }),
      makeRecord({ id: "p2", name: "Cloud art", backend: "openrouter", presetId: "openrouter", sortOrder: 1 }),
    ];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles).toHaveLength(2));

    act(() => hook.current!.setProfileSearch!("OpenRouter"));
    expect(hook.current!.filteredProfiles!.map((profile) => profile.id)).toEqual(["p2"]);
    act(() => hook.current!.setProfileSearch!("forge"));
    expect(hook.current!.filteredProfiles!.map((profile) => profile.id)).toEqual(["p1"]);

    await hook.current!.reorder!([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]);
    expect(reorderMock).toHaveBeenCalledWith([{ id: "p2", sortOrder: 0 }, { id: "p1", sortOrder: 1 }]);
    await waitFor(() => expect(hook.current!.profiles.map((profile) => profile.id)).toEqual(["p2", "p1"]));
  });

  it("loads profiles on mount; select hydrates the form from the record", async () => {
    crud.store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "openrouter", endpoint: "https://openrouter.ai/api/v1" }),
      makeRecord({ id: "p2", name: "Beta", backend: "a1111", hasStoredApiKey: true, modelId: "sd_xl" }),
    ];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(hook.current!.loading).toBe(false);
    expect(hook.current!.error).toBeNull();

    hook.current!.select("p2");
    await waitFor(() => expect(hook.current!.editingId).toBe("p2"));
    expect(hook.current!.form?.name).toBe("Beta");
    expect(hook.current!.form?.backend).toBe("a1111");
    expect(hook.current!.form?.modelId).toBe("sd_xl");
    expect(hook.current!.form?.hasStoredApiKey).toBe(true);
    expect(hook.current!.form?.apiKey).toBe("");
    expect(hook.current!.form?.capabilities).toEqual(wireImageGenProfile().capabilities);
    expect(hook.current!.dirty).toBe(false);

    hook.current!.setForm({ name: "Beta-2" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    expect(hook.current!.form?.name).toBe("Beta-2");
  });

  it("startCreate seeds the caller's name/backend with the static capability snapshot", async () => {
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.loading).toBe(false));

    hook.current!.startCreate("New profile", "a1111");
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    expect(hook.current!.form?.name).toBe("New profile");
    expect(hook.current!.form?.backend).toBe("a1111");
    expect(hook.current!.form?.endpoint).toBe("");
    // The capability mirror comes from the real registry table (single
    // source) — a1111 is the v1 roster's full-param backend.
    expect(hook.current!.form?.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
    expect(hook.current!.form?.capabilities.supportsSamplers).toBe(true);
    expect(hook.current!.headerMode).toBe("edit");
    // The form holds a COPY, not a reference into the shared table.
    expect(hook.current!.form?.capabilities).not.toBe(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
  });

  it("save creates when form.id is null; blank key sends undefined; capabilities ride the payload", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    hook.current!.startCreate("Custom cloud", "openai-images");
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    hook.current!.setForm({ endpoint: "https://api.example.com/v1" });
    await waitFor(() => expect(hook.current?.dirty).toBe(true));
    await hook.current!.save();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    expect(createMock).toHaveBeenCalled();
    const createArg = (createMock.mock.calls[0] as unknown[])[0] as {
      name: string;
      backend: string;
      presetId?: string;
      endpoint: string;
      apiKey?: string;
      capabilities: ImageGenRecord["capabilities"];
    };
    expect(createArg.name).toBe("Custom cloud");
    expect(createArg.backend).toBe("openai-images");
    expect(createArg.endpoint).toBe("https://api.example.com/v1");
    // Blank form key = no key sent (undefined, not an empty string) and no
    // preset when the form carries none (Custom).
    expect(createArg.apiKey).toBeUndefined();
    expect(createArg.presetId).toBeUndefined();
    expect(createArg.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES["openai-images"]);
  });

  it("save updates when id exists and rewrites the capability mirror on a backend switch", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    // Backend flip a1111 → openrouter: the new backend's capability row must
    // land on the wire (the create/update contract carries the mirror).
    act(() => hook.current!.setForm({ backend: "openrouter" }));
    await waitFor(() => expect(hook.current?.form?.backend).toBe("openrouter"));
    act(() => hook.current!.setForm({ endpoint: "https://openrouter.ai/api/v1" }));
    await waitFor(() => expect(hook.current?.form?.endpoint).toBe("https://openrouter.ai/api/v1"));
    await hook.current!.save();
    await waitFor(() =>
      expect(hook.current?.profiles.find((p: ImageGenRecord) => p.id === "p1")?.backend).toBe("openrouter"),
    );
    expect(updateMock).toHaveBeenCalled();
    const updateArg = (updateMock.mock.calls[0] as unknown[])[1] as {
      backend: string;
      capabilities: ImageGenRecord["capabilities"];
    };
    expect(updateArg.backend).toBe("openrouter");
    expect(updateArg.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES.openrouter);
    expect(updateArg.capabilities.supportsSamplers).toBe(false);
  });

  it("save failure sets error", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    crud.failUpdate = true;
    const hook = await mountProfileHook(() => useImageProfiles());
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
    crud.store = [makeRecord({ id: "p1", name: "Alpha" }), makeRecord({ id: "p2", name: "Beta" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    await hook.current!.remove();
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    expect(hook.current!.form).toBeNull();
    expect(hook.current!.editingId).toBeNull();
  });

  // IF-7a: the unbound arm of the sets row — payload merges into the form's
  // defaultParams, the pointer rides the profile PATCH on save, and a
  // pointer-only clear keeps the values (the setModelSamplerSetBinding rule).
  it("applyBaseSamplerSet merges payload + points defaultParamsSetId; save PATCHes the pointer; null-clear keeps values", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    act(() => hook.current!.applyBaseSamplerSet("set-a", { steps: 30, sampler: "Euler a" }));
    expect(hook.current!.form?.defaultParams).toEqual({ steps: 30, sampler: "Euler a" });
    expect(hook.current!.form?.defaultParamsSetId).toBe("set-a");
    expect(hook.current!.dirty).toBe(true);

    // Pointer-only clear: values stay (copy-on-select, never a live link).
    act(() => hook.current!.applyBaseSamplerSet(null));
    expect(hook.current!.form?.defaultParams).toEqual({ steps: 30, sampler: "Euler a" });
    expect(hook.current!.form?.defaultParamsSetId).toBe(null);

    // Re-point and save — the update PATCH carries the pointer.
    act(() => hook.current!.applyBaseSamplerSet("set-a"));
    await hook.current!.save();
    const body = updateMock.mock.calls[updateMock.mock.calls.length - 1]![1] as Record<string, unknown>;
    expect(body["defaultParamsSetId"]).toBe("set-a");
    expect(body["defaultParams"]).toEqual({ steps: 30, sampler: "Euler a" });
  });

  // IF-7b: the grown set payload (scheduler + vae + hires) lands in the
  // base verbatim — the stock sets' whole point.
  it("applyBaseSamplerSet carries the grown payload fields (scheduler, vae, hires) into defaultParams", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    act(() =>
      hook.current!.applyBaseSamplerSet("set-anima", {
        sampler: "euler_sde",
        scheduler: "simple",
        steps: 30,
        cfgScale: 5,
        vae: "qwen_image_vae.safetensors",
        hires: { enabled: false, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 },
      }),
    );
    expect(hook.current!.form?.defaultParams).toEqual({
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
      vae: "qwen_image_vae.safetensors",
      hires: { enabled: false, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 },
    });
    expect(hook.current!.form?.defaultParamsSetId).toBe("set-anima");
    expect(hook.current!.dirty).toBe(true);
  });
});

describe("useImageProfiles — backend switch hygiene", () => {
  it("switching backends resets endpoint/key/model/preset/params and reseeds capabilities", async () => {
    crud.store = [
      makeRecord({
        id: "p1",
        backend: "openrouter",
        presetId: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        hasStoredApiKey: true,
        modelId: "google/gemini-2.5-flash-image",
        defaultParams: { seed: 42 },
        modeSizePresets: { portrait: { width: 832, height: 1248 } },
      }),
    ];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.backend).toBe("openrouter"));
    expect(hook.current!.form?.hasStoredApiKey).toBe(true);
    expect(hook.current!.form?.defaultParams).toEqual({ seed: 42 });

    hook.current!.setForm({ backend: "a1111" });
    await waitFor(() => expect(hook.current?.form?.backend).toBe("a1111"));
    // Everything backend-coupled resets — no invented default endpoint.
    expect(hook.current!.form?.endpoint).toBe("");
    expect(hook.current!.form?.apiKey).toBe("");
    expect(hook.current!.form?.hasStoredApiKey).toBe(false);
    expect(hook.current!.form?.modelId).toBeNull();
    expect(hook.current!.form?.presetId).toBeNull();
    expect(hook.current!.form?.defaultParams).toEqual({});
    expect(hook.current!.form?.modeSizePresets).toEqual({});
    expect(hook.current!.form?.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
  });
});

describe("useImageProfiles — models / samplers / draft", () => {
  it("fetchSavedModels caches per profile and maps the 404 null to an error", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    const models = await hook.current!.fetchSavedModels();
    expect(models?.length).toBe(2);
    await waitFor(() => expect(hook.current?.modelsByProfile.p1?.length).toBe(2));
    expect(hook.current!.error).toBeNull();

    await hook.current!.fetchSavedModels("missing");
    await waitFor(() => expect(hook.current?.error).toBe("Image-gen profile not found"));
  });

  // IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11: the open path
  // (`storedFirst`) is options data only — its failure leaves the shared
  // error alone; the refresh path (no options) still reports.
  it("step 11: storedFirst rides to the API; its failure sets no shared error, a refresh failure does", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    const ref = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(ref.current?.profiles.length).toBe(1));

    modelsMock.mockClear();
    expect((await ref.current!.fetchSavedModels("p1", { storedFirst: true }))?.length).toBe(2);
    expect(modelsMock.mock.calls.at(-1) as unknown[]).toEqual(["p1", undefined, { storedFirst: true }]);
    await waitFor(() => expect(ref.current?.modelsByProfile.p1?.length).toBe(2));

    modelsMock.mockImplementationOnce(async () => {
      throw new Error("upstream down");
    });
    expect(await ref.current!.fetchSavedModels("p1", { storedFirst: true })).toBeNull();
    expect(ref.current?.error).toBeNull();
    // The failed open read keeps the cached list.
    expect(ref.current?.modelsByProfile.p1?.length).toBe(2);

    modelsMock.mockImplementationOnce(async () => {
      throw new Error("upstream down");
    });
    expect(await ref.current!.fetchSavedModels("p1")).toBeNull();
    await waitFor(() => expect(ref.current?.error).toBe("upstream down"));
  });

  it("step 11: saving a new endpoint drops the cached model list; a save on the same server keeps it", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    const ref = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(ref.current?.profiles.length).toBe(1));
    ref.current!.select("p1");
    await waitFor(() => expect(ref.current?.form?.id).toBe("p1"));
    await ref.current!.fetchSavedModels("p1");
    await waitFor(() => expect(ref.current?.modelsByProfile.p1?.length).toBe(2));

    act(() => ref.current!.setForm({ name: "Renamed" }));
    await act(async () => {
      await ref.current!.save();
    });
    expect(ref.current?.modelsByProfile.p1?.length).toBe(2);

    act(() => ref.current!.setForm({ endpoint: "http://other-host:9000/v1" }));
    await act(async () => {
      await ref.current!.save();
    });
    await waitFor(() => expect(ref.current?.modelsByProfile.p1).toBeUndefined());
  });

  it("fetchSamplers caches per profile; failures land in the per-profile OFFLINE status, never the shared error (IG-CF12a)", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    samplersMock.mockImplementationOnce(async () => {
      throw new Error("Image-gen sampler list failed: 400 Bad Request: sampler listing not supported");
    });
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    // The OLD boundary pinned the failure into `error` — exactly the CF12
    // defect (an A1111-down painted «profiles failed to load» while the
    // profiles had loaded fine). The new boundary: connectivity is a
    // per-profile status; `error` stays clean.
    await hook.current!.fetchSamplers();
    await waitFor(() => expect(hook.current?.samplerStatusByProfile.p1).toBe("offline"));
    expect(hook.current!.error).toBeNull();
    expect(hook.current!.samplersByProfile.p1).toBeUndefined();

    // Recovery (the status chip's re-check): refetch flips online + caches.
    const samplers = await hook.current!.fetchSamplers();
    expect(samplers?.length).toBe(2);
    await waitFor(() => expect(hook.current?.samplerStatusByProfile.p1).toBe("online"));
    expect(hook.current!.samplersByProfile.p1?.length).toBe(2);
    expect(hook.current!.error).toBeNull();

    // Unknown-profile nulls STILL surface in `error` and draw no conclusion
    // in the status (owner decision: profile-not-found stays an error).
    await hook.current!.fetchSamplers("missing");
    await waitFor(() => expect(hook.current?.error).toBe("Image-gen profile not found"));
    expect(hook.current!.samplerStatusByProfile.missing).toBe("unknown");
  });

  it("fetchSchedulers caches per profile (PG-3); failures leave the cache + error + connectivity status untouched", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    const schedulers = await hook.current!.fetchSchedulers();
    expect(schedulers?.length).toBe(2);
    await waitFor(() => expect(hook.current?.schedulersByProfile.p1?.length).toBe(2));
    // Options data only: no connectivity conclusion, no shared error.
    expect(hook.current!.samplerStatusByProfile.p1).toBeUndefined();
    expect(hook.current!.error).toBeNull();

    // A failed fetch returns null and paints NOTHING anywhere.
    schedulersMock.mockImplementationOnce(async () => {
      throw new Error("Image-gen scheduler list failed: 503");
    });
    const failed = await hook.current!.fetchSchedulers();
    expect(failed).toBeNull();
    expect(hook.current!.error).toBeNull();
    expect(hook.current!.samplerStatusByProfile.p1).toBeUndefined();

    // Unknown profile: null, still no shared error (unlike fetchSamplers —
    // a scheduler miss is not a load conclusion).
    expect(await hook.current!.fetchSchedulers("missing")).toBeNull();
    expect(hook.current!.error).toBeNull();
  });

  it("fetchSidecars caches per profile; a failure raises the per-profile hint flag, a later success clears it (T3 parity)", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "comfyui" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    // Success: cached, flag clear — options data only, no connectivity
    // conclusion, no shared error.
    const sidecars = await hook.current!.fetchSidecars();
    expect(sidecars?.encoders.length).toBe(1);
    await waitFor(() => expect(hook.current?.sidecarsByProfile.p1?.encoders.length).toBe(1));
    expect(hook.current!.sidecarsFailedByProfile.p1).toBe(false);
    expect(hook.current!.samplerStatusByProfile.p1).toBeUndefined();
    expect(hook.current!.error).toBeNull();

    // Failure: null + the per-profile flag (the pane's hint input) — the
    // cache, error, and connectivity status stay untouched.
    sidecarsMock.mockImplementationOnce(async () => {
      throw new Error("Image-gen sidecar list failed: 503");
    });
    const failed = await hook.current!.fetchSidecars();
    expect(failed).toBeNull();
    await waitFor(() => expect(hook.current?.sidecarsFailedByProfile.p1).toBe(true));
    expect(hook.current!.error).toBeNull();
    expect(hook.current!.samplerStatusByProfile.p1).toBeUndefined();

    // Recovery: a successful refetch clears the flag.
    await hook.current!.fetchSidecars();
    await waitFor(() => expect(hook.current?.sidecarsFailedByProfile.p1).toBe(false));
  });

  it("IF-20: a snapshot answer fills the caches and records its time; a live answer clears it", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "comfyui" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));

    const at = "2026-09-29T10:00:00.000Z";
    modelsMock.mockImplementationOnce(async () => ({ data: [{ id: "saved", label: "Saved" }], snapshotAt: at }));
    sidecarsMock.mockImplementationOnce(async () => ({ data: { encoders: ["e"], vaes: ["v"] }, snapshotAt: at }));
    await hook.current!.fetchSavedModels();
    await hook.current!.fetchSidecars();
    await waitFor(() => expect(hook.current?.modelsSnapshotAtByProfile.p1).toBe(at));
    expect(hook.current!.modelsByProfile.p1).toEqual([{ id: "saved", label: "Saved" }]);
    expect(hook.current!.sidecarsSnapshotAtByProfile.p1).toBe(at);
    // A snapshot is data, not a failure: the failed flag stays clear.
    expect(hook.current!.sidecarsFailedByProfile.p1).toBe(false);

    await hook.current!.fetchSavedModels();
    await hook.current!.fetchSidecars();
    await waitFor(() => expect(hook.current?.modelsSnapshotAtByProfile.p1).toBeNull());
    expect(hook.current!.sidecarsSnapshotAtByProfile.p1).toBeNull();
  });

  it("IG-21: draftAutoKeyProviderName mirrors the server cascade (saved name wins; drafts match by rule; keyless providers never match)", async () => {
    // Saved record decorated by the server — the decorated name WINS even
    // though the mirror pool would resolve a different provider.
    crud.store = [
      makeRecord({
        id: "p1",
        name: "Saved OR",
        backend: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        autoKeyProviderName: "Decorated by server",
      }),
      makeRecord({ id: "p2", name: "Exact OAi", backend: "openai-images", endpoint: "https://api.openai.com/v1" }),
      makeRecord({ id: "p3", name: "Wrong endpoint", backend: "openai-images", endpoint: "https://images.gate.test/v1" }),
      makeRecord({ id: "p4", name: "Local", backend: "a1111", endpoint: "http://127.0.0.1:7860" }),
    ];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(4));

    hook.current!.select("p1");
    await waitFor(() => expect(hook.current!.form?.id).toBe("p1"));
    expect(hook.current!.draftAutoKeyProviderName).toBe("Decorated by server");

    // Draft twin — openai-images by EXACT endpoint (OAi main), a wrong
    // endpoint stays null, a1111 never matches.
    hook.current!.select("p2");
    await waitFor(() => expect(hook.current!.form?.id).toBe("p2"));
    // p2 is saved but UNdecorated (the server hint is null in this record) —
    // the client mirror resolves it from the provider pool.
    expect(hook.current!.draftAutoKeyProviderName).toBe("OAi main");

    hook.current!.select("p3");
    await waitFor(() => expect(hook.current!.form?.id).toBe("p3"));
    expect(hook.current!.draftAutoKeyProviderName).toBeNull();

    hook.current!.select("p4");
    await waitFor(() => expect(hook.current!.form?.id).toBe("p4"));
    expect(hook.current!.draftAutoKeyProviderName).toBeNull();

    // A brand-new draft on the vendor host resolves through the mirror too
    // (openrouter vendor rule: first KEYFUL provider on the host wins — the
    // keyless same-host row never matches).
    hook.current!.startCreate("New card", "openrouter");
    await waitFor(() => expect(hook.current!.form?.name).toBe("New card"));
    hook.current!.setForm({ endpoint: "https://openrouter.ai/api/v1" });
    expect(hook.current!.draftAutoKeyProviderName).toBe("OR main");
  });

  it("MR-3: a keyless nanogpt draft auto-matches the provider key by exact endpoint (mirror)", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "openrouter", endpoint: "https://openrouter.ai/api/v1" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    // The owner's own case: a NanoGPT draft (dedicated backend, NOT
    // openai-compat-backends-only anymore) with the provider profile's
    // exact endpoint → the hint names that provider.
    hook.current!.startCreate("Draft", IMAGE_GEN_BACKENDS.NanoGpt);
    await waitFor(() => expect(hook.current?.form?.backend).toBe("nanogpt"));
    act(() => hook.current!.setForm({ endpoint: "https://nano-gpt.com/api/v1" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBe("Nano main"));

    // Same backend, a different endpoint — the exact-match guard holds.
    act(() => hook.current!.setForm({ endpoint: "https://other-gateway.test/v1" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBeNull());

    // Local keyless backends never match, even on an exact endpoint.
    hook.current!.startCreate("Local", IMAGE_GEN_BACKENDS.A1111);
    await waitFor(() => expect(hook.current?.form?.backend).toBe("a1111"));
    act(() => hook.current!.setForm({ endpoint: "https://nano-gpt.com/api/v1" }));
    await waitFor(() => expect(hook.current?.draftAutoKeyProviderName).toBeNull());
  });

  it("fetchDraftModels sends the live form config with the typed key inside it", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha", backend: "openrouter", endpoint: "https://openrouter.ai/api/v1" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    // Draft flow on an UNSAVED form: the just-typed key rides inside config.
    hook.current!.startCreate("Draft", "openai-images");
    await waitFor(() => expect(hook.current?.form?.id).toBeNull());
    act(() => hook.current!.setForm({ endpoint: "https://api.example.com/v1", apiKey: "sk-live" }));
    await waitFor(() => expect(hook.current?.form?.endpoint).toBe("https://api.example.com/v1"));
    const entries = await hook.current!.fetchDraftModels();
    expect(entries.length).toBe(1);
    const body = draftModelsMock.mock.calls[0][0] as { backend: string; config: Record<string, unknown>; profileId?: string };
    expect(body.backend).toBe("openai-images");
    expect(body.config).toEqual({ endpoint: "https://api.example.com/v1", apiKey: "sk-live" });
    expect(body.profileId).toBeUndefined();

    // Draft on a SAVED form with a blank key: profileId rides for
    // stored-key resolution and no empty key is sent.
    hook.current!.select("p1");
    await waitFor(() => expect(hook.current?.form?.id).toBe("p1"));
    await hook.current!.fetchDraftModels();
    const savedBody = draftModelsMock.mock.calls[1][0] as { backend: string; config: Record<string, unknown>; profileId?: string };
    expect(savedBody.backend).toBe("openrouter");
    expect(savedBody.config).toEqual({ endpoint: "https://openrouter.ai/api/v1" });
    expect(savedBody.profileId).toBe("p1");

    // MR-2: failures RETHROW to the form (its Test badge is the only
    // surface) and never touch the shared `error` — a failed draft must not
    // paint «profiles failed to load» over the list.
    act(() => hook.current!.setForm({ endpoint: "https://boom.example" }));
    await waitFor(() => expect(hook.current?.form?.endpoint).toBe("https://boom.example"));
    let threw = false;
    try {
      await hook.current!.fetchDraftModels();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(hook.current!.error).toBeNull();
  });
});

describe("useImageProfiles — activateProfile (MR-12)", () => {
  it("persists server-first, flips the session pointer on success, reloads the flag", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Cloud" }), makeRecord({ id: "p2", name: "Comfy" })];
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(2));

    await hook.current!.activateProfile("p2");
    expect(setDefaultMock).toHaveBeenCalledTimes(1);
    expect(setDefaultMock).toHaveBeenCalledWith("p2");
    // The reloaded list carries the moved flag (the ★ rows + resolver source).
    await waitFor(() => expect(hook.current!.profiles.find((p: ImageGenRecord) => p.id === "p2")?.isDefault).toBe(true));
    expect(hook.current!.profiles.find((p: ImageGenRecord) => p.id === "p1")?.isDefault).toBe(false);
    expect(hook.current!.error).toBeNull();
  });

  it("a failed PUT lands in the shared error surface and flips no pointer", async () => {
    crud.store = [makeRecord({ id: "p1" })];
    setDefaultMock.mockImplementationOnce(async () => {
      throw new Error("route down");
    });
    const hook = await mountProfileHook(() => useImageProfiles());
    await waitFor(() => expect(hook.current?.profiles.length).toBe(1));

    await hook.current!.activateProfile("p1");
    await waitFor(() => expect(hook.current?.error).toBe("route down"));
    expect(hook.current!.profiles.find((p: ImageGenRecord) => p.id === "p1")?.isDefault).toBe(false);
  });
});

describe("useImageProfiles — headerMode machine", () => {
  it("select -> view; startEdit -> edit; save returns to view; cancelEdit restores", async () => {
    crud.store = [makeRecord({ id: "p1", name: "Alpha" })];
    const hook = await mountProfileHook(() => useImageProfiles());
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

    await hook.current!.save();
    await waitFor(() => expect(hook.current?.headerMode).toBe("view"));
  });
});

describe("toImageGenBackend", () => {
  it("known slugs pass through; unknown degrade to the OpenRouter roster default", () => {
    expect(toImageGenBackend("openrouter")).toBe("openrouter");
    expect(toImageGenBackend("openai-images")).toBe("openai-images");
    expect(toImageGenBackend("a1111")).toBe("a1111");
    expect(toImageGenBackend("future-backend")).toBe("openrouter");
  });
});
