import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

// Safe pattern — real module first, spread, override only the functions the
// hook touches (the use-stt-profiles harness this suite forks).
const realImageGenApi = await import("../api/image-gen-api.js");

type ImageGenRecord = import("../api/image-gen-api.js").ImageGenProfileRecord;
type ImageGenModelEntry = import("../api/image-gen-api.js").ImageGenModelEntry;
type ImageGenProbeResult = import("@vibe-tavern/api-contracts").ImageGenProbeResultValue;
type ImageGenSampler = import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue;

function makeCaps(overrides: Partial<ImageGenRecord["capabilities"]> = {}): ImageGenRecord["capabilities"] {
  return {
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: { kind: "vendor-set", sizes: ["1024x1024"] },
    noApiKey: false,
    supportsLiveProgress: false,
        localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ImageGenRecord> = {}): ImageGenRecord {
  return {
    id: "p1",
    name: "Forge local",
    backend: "a1111",
    presetId: undefined,
    endpoint: "http://127.0.0.1:7860",
    hasStoredApiKey: false,
    modelId: undefined,
    defaultParams: {},
    modeSizePresets: {},
    llmAssistEnabled: false,
    llmProviderProfileId: undefined,
    llmModelId: undefined,
    capabilities: makeCaps(),
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Mutable store the mocked API closes over — changing it per test affects
// the already-imported hook.
let store: ImageGenRecord[] = [];
let failUpdate = false;
let failMessage = "save boom";

const listAllMock = mock(async () => [...store]);
const createMock = mock(
  async (body: {
    name: string;
    backend: ImageGenRecord["backend"];
    presetId?: string;
    endpoint: string;
    apiKey?: string;
    capabilities: ImageGenRecord["capabilities"];
  }) => {
    const rec = makeRecord({
      id: `p${store.length + 1}`,
      name: body.name,
      backend: body.backend,
      presetId: body.presetId,
      endpoint: body.endpoint,
      hasStoredApiKey: body.apiKey !== undefined && body.apiKey !== "",
      capabilities: body.capabilities,
    });
    store.push(rec);
    return rec;
  },
);
const updateMock = mock(
  async (
    id: string,
    body: Partial<{
      name: string;
      backend: string;
      endpoint: string;
      apiKey: string;
      capabilities: ImageGenRecord["capabilities"];
    }>,
  ) => {
    if (failUpdate) throw new Error(failMessage);
    const idx = store.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("not found");
    const updated = { ...store[idx], ...body } as ImageGenRecord;
    store[idx] = updated;
    return updated;
  },
);
const deleteMock = mock(async (id: string) => {
  store = store.filter((p) => p.id !== id);
});
const probeMock = mock(async (id: string): Promise<ImageGenProbeResult | null> => {
  if (id === "missing") return null;
  return { ok: true, detail: "2 image models", status: 200 };
});
const modelsMock = mock(async (id: string): Promise<ImageGenModelEntry[] | null> => {
  if (id === "missing") return null;
  return [
    { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", isFree: false },
    { id: "openai/gpt-image-2", label: "GPT Image 2", isFree: true },
  ];
});
const samplersMock = mock(async (id: string): Promise<ImageGenSampler[] | null> => {
  if (id === "missing") return null;
  return [{ name: "Euler a", aliases: ["k_euler_a"] }, { name: "DPM++ 2M" }];
});
const draftModelsMock = mock(
  async (body: { backend: string; config: Record<string, unknown>; profileId?: string }): Promise<ImageGenModelEntry[]> => {
    if (body.config.endpoint === "https://boom.example") throw new Error("draft boom");
    return [{ id: "draft-model", label: "Draft Model" }];
  },
);

mock.module("../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: listAllMock,
  createImageGenProfile: createMock,
  updateImageGenProfile: updateMock,
  deleteImageGenProfile: deleteMock,
  probeImageGenProfile: probeMock,
  listImageGenModels: modelsMock,
  listImageGenSamplers: samplersMock,
  draftListImageGenModels: draftModelsMock,
}));

const { act, cleanup, waitFor, render } = await import("@testing-library/react");
const { useImageProfiles, toImageGenBackend } = await import("./use-image-profiles.js");
const { IMAGE_GEN_BACKEND_CAPABILITIES } = await import("@vibe-tavern/domain");

afterEach(async () => {
  await act(async () => {});
  cleanup();
  store = [];
  failUpdate = false;
  listAllMock.mockClear();
  createMock.mockClear();
  updateMock.mockClear();
  deleteMock.mockClear();
  probeMock.mockClear();
  modelsMock.mockClear();
  samplersMock.mockClear();
  draftModelsMock.mockClear();
});

describe("useImageProfiles — CRUD", () => {
  it("loads profiles on mount; select hydrates the form from the record", async () => {
    store = [
      makeRecord({ id: "p1", name: "Alpha", backend: "openrouter", endpoint: "https://openrouter.ai/api/v1" }),
      makeRecord({ id: "p2", name: "Beta", backend: "a1111", hasStoredApiKey: true, modelId: "sd_xl" }),
    ];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    expect(hook?.loading).toBe(false);
    expect(hook?.error).toBeNull();

    hook!.select("p2");
    await waitFor(() => expect(hook!.editingId).toBe("p2"));
    expect(hook!.form?.name).toBe("Beta");
    expect(hook!.form?.backend).toBe("a1111");
    expect(hook!.form?.modelId).toBe("sd_xl");
    expect(hook!.form?.hasStoredApiKey).toBe(true);
    expect(hook!.form?.apiKey).toBe("");
    expect(hook!.form?.capabilities).toEqual(makeCaps());
    expect(hook!.dirty).toBe(false);

    hook!.setForm({ name: "Beta-2" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    expect(hook?.form?.name).toBe("Beta-2");
  });

  it("startCreate seeds the caller's name/backend with the static capability snapshot", async () => {
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.loading).toBe(false));

    hook!.startCreate("New profile", "a1111");
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    expect(hook!.form?.name).toBe("New profile");
    expect(hook!.form?.backend).toBe("a1111");
    expect(hook!.form?.endpoint).toBe("");
    // The capability mirror comes from the real registry table (single
    // source) — a1111 is the v1 roster's full-param backend.
    expect(hook!.form?.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
    expect(hook!.form?.capabilities.supportsSamplers).toBe(true);
    expect(hook!.headerMode).toBe("edit");
    // The form holds a COPY, not a reference into the shared table.
    expect(hook!.form?.capabilities).not.toBe(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
  });

  it("save creates when form.id is null; blank key sends undefined; capabilities ride the payload", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));

    hook!.startCreate("Custom cloud", "openai-images");
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    hook!.setForm({ endpoint: "https://api.example.com/v1" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
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
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));

    // Backend flip a1111 → openrouter: the new backend's capability row must
    // land on the wire (the create/update contract carries the mirror).
    act(() => hook!.setForm({ backend: "openrouter" }));
    await waitFor(() => expect(hook?.form?.backend).toBe("openrouter"));
    act(() => hook!.setForm({ endpoint: "https://openrouter.ai/api/v1" }));
    await waitFor(() => expect(hook?.form?.endpoint).toBe("https://openrouter.ai/api/v1"));
    await hook!.save();
    await waitFor(() =>
      expect(hook?.profiles.find((p: ImageGenRecord) => p.id === "p1")?.backend).toBe("openrouter"),
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
    store = [makeRecord({ id: "p1", name: "Alpha" })];
    failUpdate = true;
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    hook!.setForm({ name: "BadName" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    await hook!.save();
    await waitFor(() => expect(hook?.error).toContain("save boom"));
    failUpdate = false;
  });

  it("remove deletes the selected profile and clears selection", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha" }), makeRecord({ id: "p2", name: "Beta" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(2));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    await hook!.remove();
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    expect(hook?.form).toBeNull();
    expect(hook?.editingId).toBeNull();
  });
});

describe("useImageProfiles — backend switch hygiene", () => {
  it("switching backends resets endpoint/key/model/preset/params and reseeds capabilities", async () => {
    store = [
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
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.backend).toBe("openrouter"));
    expect(hook!.form?.hasStoredApiKey).toBe(true);
    expect(hook!.form?.defaultParams).toEqual({ seed: 42 });

    hook!.setForm({ backend: "a1111" });
    await waitFor(() => expect(hook?.form?.backend).toBe("a1111"));
    // Everything backend-coupled resets — no invented default endpoint.
    expect(hook!.form?.endpoint).toBe("");
    expect(hook!.form?.apiKey).toBe("");
    expect(hook!.form?.hasStoredApiKey).toBe(false);
    expect(hook!.form?.modelId).toBeNull();
    expect(hook!.form?.presetId).toBeNull();
    expect(hook!.form?.defaultParams).toEqual({});
    expect(hook!.form?.modeSizePresets).toEqual({});
    expect(hook!.form?.capabilities).toEqual(IMAGE_GEN_BACKEND_CAPABILITIES.a1111);
  });
});

describe("useImageProfiles — probe / models / samplers / draft", () => {
  it("probeSaved is a no-op on an unsaved form and records the outcome on a saved one", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));

    await hook!.probeSaved();
    expect(probeMock).not.toHaveBeenCalled();
    expect(hook?.probeOutcome).toBeNull();

    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    await hook!.probeSaved();
    await waitFor(() => expect(hook?.probeOutcome).toEqual({ profileId: "p1", result: { ok: true, detail: "2 image models", status: 200 } }));
    expect(probeMock.mock.calls[0][0]).toBe("p1");
  });

  it("fetchSavedModels caches per profile and maps the 404 null to an error", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));

    const models = await hook!.fetchSavedModels();
    expect(models?.length).toBe(2);
    await waitFor(() => expect(hook?.modelsByProfile.p1?.length).toBe(2));
    expect(hook?.error).toBeNull();

    await hook!.fetchSavedModels("missing");
    await waitFor(() => expect(hook?.error).toBe("Image-gen profile not found"));
  });

  it("fetchSamplers caches per profile; an unsupported backend surfaces the route message", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "a1111" })];
    samplersMock.mockImplementationOnce(async () => {
      throw new Error("Image-gen sampler list failed: 400 Bad Request: sampler listing not supported");
    });
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));

    await hook!.fetchSamplers();
    await waitFor(() => expect(hook?.error).toContain("sampler listing not supported"));
    expect(hook?.samplersByProfile.p1).toBeUndefined();

    const samplers = await hook!.fetchSamplers();
    expect(samplers?.length).toBe(2);
    await waitFor(() => expect(hook?.samplersByProfile.p1?.length).toBe(2));
    expect(hook?.error).toBeNull();
  });

  it("fetchDraftModels sends the live form config with the typed key inside it", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha", backend: "openrouter", endpoint: "https://openrouter.ai/api/v1" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));

    // Draft flow on an UNSAVED form: the just-typed key rides inside config.
    hook!.startCreate("Draft", "openai-images");
    await waitFor(() => expect(hook?.form?.id).toBeNull());
    act(() => hook!.setForm({ endpoint: "https://api.example.com/v1", apiKey: "sk-live" }));
    await waitFor(() => expect(hook?.form?.endpoint).toBe("https://api.example.com/v1"));
    const entries = await hook!.fetchDraftModels();
    expect(entries.length).toBe(1);
    const body = draftModelsMock.mock.calls[0][0] as { backend: string; config: Record<string, unknown>; profileId?: string };
    expect(body.backend).toBe("openai-images");
    expect(body.config).toEqual({ endpoint: "https://api.example.com/v1", apiKey: "sk-live" });
    expect(body.profileId).toBeUndefined();

    // Draft on a SAVED form with a blank key: profileId rides for
    // stored-key resolution and no empty key is sent.
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    await hook!.fetchDraftModels();
    const savedBody = draftModelsMock.mock.calls[1][0] as { backend: string; config: Record<string, unknown>; profileId?: string };
    expect(savedBody.backend).toBe("openrouter");
    expect(savedBody.config).toEqual({ endpoint: "https://openrouter.ai/api/v1" });
    expect(savedBody.profileId).toBe("p1");

    // Failures surface in error AND rethrow (the pane toasts its own copy).
    act(() => hook!.setForm({ endpoint: "https://boom.example" }));
    await waitFor(() => expect(hook?.form?.endpoint).toBe("https://boom.example"));
    let threw = false;
    try {
      await hook!.fetchDraftModels();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await waitFor(() => expect(hook?.error).toContain("draft boom"));
  });
});

describe("useImageProfiles — headerMode machine", () => {
  it("select -> view; startEdit -> edit; save returns to view; cancelEdit restores", async () => {
    store = [makeRecord({ id: "p1", name: "Alpha" })];
    let hook: any = null;
    function Probe() {
      hook = useImageProfiles();
      return null;
    }
    render(React.createElement(Probe));
    await waitFor(() => expect(hook?.profiles.length).toBe(1));
    hook!.select("p1");
    await waitFor(() => expect(hook?.form?.id).toBe("p1"));
    expect(hook?.headerMode).toBe("view");

    hook!.startEdit();
    await waitFor(() => expect(hook?.headerMode).toBe("edit"));
    hook!.setForm({ name: "Discard me" });
    await waitFor(() => expect(hook?.dirty).toBe(true));
    hook!.cancelEdit();
    await waitFor(() => expect(hook?.headerMode).toBe("view"));
    expect(hook?.form?.name).toBe("Alpha");
    expect(hook?.dirty).toBe(false);

    await hook!.save();
    await waitFor(() => expect(hook?.headerMode).toBe("view"));
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
