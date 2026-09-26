import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === "object" && Object.keys(params).length > 0
        ? `${key}:${Object.values(params).join(",")}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// Real-hook seam (the use-image-profiles.test.tsx harness): the api module
// mocked with the `...real` spread — only the IG-12b functions the overlay
// round-trip needs are overridden; the mocked-hook describes below never
// reach this seam (their hook object is a local factory).
const realImageGenApi = await import("../../../../api/image-gen-api.js");

type ImageGenRecord = import("../../../../api/image-gen-api.js").ImageGenProfileRecord;
type ImageGenModelEntry = import("../../../../api/image-gen-api.js").ImageGenModelEntry;
type ImageGenSamplerSet = import("@vibe-tavern/api-contracts").ImageGenSamplerSet;
type ImageGenModelSettings = import("@vibe-tavern/api-contracts").ImageGenModelSettingsValue;
type ImageGenModelFavorite = import("@vibe-tavern/api-contracts").ImageGenModelFavoriteValue;

let apiStore: ImageGenRecord[] = [];
let settingsRow: ImageGenModelSettings | null = null;
let favoritesList: ImageGenModelFavorite[] = [];
const listAllApi = mock(async (): Promise<ImageGenRecord[]> => [...apiStore]);
const updateProfileApi = mock(async (id: string, body: Record<string, unknown>): Promise<ImageGenRecord> => {
  const idx = apiStore.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error("not found");
  const updated = { ...apiStore[idx], ...body } as ImageGenRecord;
  apiStore[idx] = updated;
  return updated;
});
const getSettingsApi = mock(async (_id: string, _modelId: string): Promise<ImageGenModelSettings | null> => settingsRow);
const upsertSettingsApi = mock(
  async (id: string, modelId: string, overlay: Record<string, unknown>): Promise<ImageGenModelSettings> => {
    settingsRow = {
      id: "ms1",
      profileId: id,
      modelId,
      settings: overlay as ImageGenModelSettings["settings"],
      samplerSetId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return settingsRow;
  },
);
const deleteSettingsApi = mock(async (): Promise<void> => {
  settingsRow = null;
});
const listFavoritesApi = mock(async (): Promise<ImageGenModelFavorite[]> => [...favoritesList]);
const addFavoriteApi = mock(
  async (id: string, body: { modelId: string; label?: string }): Promise<ImageGenModelFavorite> => {
    const row: ImageGenModelFavorite = {
      id: `fav-${body.modelId}`,
      profileId: id,
      modelId: body.modelId,
      label: body.label ?? null,
      createdAt: new Date().toISOString(),
    };
    favoritesList = [...favoritesList.filter((f) => f.modelId !== body.modelId), row];
    return row;
  },
);
const removeFavoriteApi = mock(async (_id: string, modelId: string): Promise<void> => {
  favoritesList = favoritesList.filter((f) => f.modelId !== modelId);
});
const listSamplersApi = mock(async (): Promise<import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue[]> => [
  { name: "Euler a", aliases: [] },
  { name: "DPM++ 2M", aliases: [] },
]);
const listSamplerSetsApi = mock(async (): Promise<ImageGenSamplerSet[]> => [
  {
    id: "set-a",
    name: "Cinematic 30",
    sortOrder: 0,
    payload: { steps: 30, cfgScale: 5, sampler: "Euler a", clipSkip: 1 },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  },
]);
// IF-7b: the pane's hires section fetches the upscaler vocabulary through
// the same api seam the chip uses — overridden here so no test ever issues
// a real network call.
const listUpscalersApi = mock(async (): Promise<Array<{ name: string }>> => [
  { name: "R-ESRGAN 4x+ Anime6B" },
  { name: "4x-UltraSharp" },
]);
let extensionsValue: string[] = [];
const listExtensionsApi = mock(async (): Promise<string[]> => [...extensionsValue]);
let faceDetectorsValue: string[] | null = null;
const faceDetectorCalls: string[] = [];
const listFaceDetectorsApi = mock(async (id: string): Promise<string[]> => {
  faceDetectorCalls.push(id);
  return [...(faceDetectorsValue ?? [])];
});

// IPT-5: the family row's API seam — registry list, manual pin, detection
// probe — mocked with the `...real` spread (leak-safe; only the three
// functions the family row consumes are overridden).
type ImagePromptFamilyInfo = import("@vibe-tavern/api-contracts").ImagePromptFamilyInfoValue;
type ImagePromptFamily = import("@vibe-tavern/api-contracts").ImagePromptFamilyValue;
type FamilyDetectResult = import("@vibe-tavern/api-contracts").ImageGenFamilyDetectionResultValue;

const REGISTRY_FAMILIES: ImagePromptFamilyInfo[] = [
  { id: "prose", grammar: "prose", ownTemplates: true, ownNegative: true, ownQuality: false, hasAssistAddendum: false },
  { id: "pony", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
  { id: "illustrious", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
  { id: "noobai", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
  { id: "anima", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
  { id: "krea2", grammar: "prose", ownTemplates: false, ownNegative: true, ownQuality: false, hasAssistAddendum: true },
  { id: "qwen", grammar: "prose", ownTemplates: false, ownNegative: true, ownQuality: false, hasAssistAddendum: true },
  { id: "sdxl-realism", grammar: "prose", ownTemplates: false, ownNegative: true, ownQuality: true, hasAssistAddendum: false },
  { id: "hybrid", grammar: "hybrid", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
];
let familiesFail = false;
const listFamiliesApi = mock(async (): Promise<{ families: ImagePromptFamilyInfo[] }> => {
  if (familiesFail) throw new Error("registry unavailable");
  return { families: REGISTRY_FAMILIES.map((family) => ({ ...family })) };
});
let pendingFamilyWrite: Promise<void> | null = null;
const setFamilyApi = mock(async (id: string, family: ImagePromptFamily | null): Promise<ImageGenRecord> => {
  await pendingFamilyWrite;
  const idx = apiStore.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error("not found");
  const updated = {
    ...apiStore[idx],
    familyOverride: family ?? undefined,
    familySource: family !== null ? "manual" : apiStore[idx].familyDetected !== undefined ? "auto" : "none",
  } as ImageGenRecord;
  apiStore[idx] = updated;
  return updated;
});

/** Server-side success persistence mirror: a success stores familyDetected
 *  anchored to the REQUESTED model (the displayed one — the route contract
 *  since IF-8a); every no-answer leaves the stored state untouched. */
function applyDetectOutcome(id: string, outcome: FamilyDetectResult, model?: string): FamilyDetectResult {
  if (outcome.ok) {
    const idx = apiStore.findIndex((p) => p.id === id);
    if (idx !== -1) {
      const rec = apiStore[idx];
      apiStore[idx] = {
        ...rec,
        familyDetected: outcome.family,
        familyDetectedForModel: model ?? rec.modelId,
        familySource: rec.familyOverride !== undefined ? "manual" : "auto",
      } as ImageGenRecord;
    }
  }
  return outcome;
}
let detectOutcome: FamilyDetectResult = { ok: false, error: "no authoritative source answered", tried: [] };
let pendingDetect: Promise<FamilyDetectResult> | null = null;
const detectFamilyApi = mock(async (id: string, _signal?: AbortSignal, model?: string): Promise<FamilyDetectResult> =>
  applyDetectOutcome(id, await (pendingDetect ?? Promise.resolve(detectOutcome)), model),
);

mock.module("../../../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: listAllApi,
  updateImageGenProfile: updateProfileApi,
  getImageGenModelSettings: getSettingsApi,
  upsertImageGenModelSettings: upsertSettingsApi,
  deleteImageGenModelSettings: deleteSettingsApi,
  listImageGenModelFavorites: listFavoritesApi,
  addImageGenModelFavorite: addFavoriteApi,
  removeImageGenModelFavorite: removeFavoriteApi,
  listImageGenSamplers: listSamplersApi,
  listImageGenSamplerSets: listSamplerSetsApi,
  listImageGenUpscalers: listUpscalersApi,
  listImageGenExtensions: listExtensionsApi,
  listImageGenFaceDetectors: listFaceDetectorsApi,
  listImagePromptFamilies: listFamiliesApi,
  setImageGenProfileFamily: setFamilyApi,
  detectImageGenProfileFamily: detectFamilyApi,
}));

// IG-15: the LLM-assist pickers fetch the LLM provider list + model catalog
// through provider-api — mocked with the `...real` spread (leak-safe; only
// the two functions the assist section consumes are overridden). Partial
// records (id/name/defaultModel) — the section maps exactly those fields
// (the ExperienceSetupModal.test.tsx double pattern).
const realProviderApi = await import("../../../../api/provider-api.js");
const listLlmProfilesApi = mock(async (): Promise<Array<{ id: string; name: string; defaultModel: string | null }>> => []);
const fetchLlmModelsApi = mock(
  async (_profileId: string): Promise<{ models: Array<{ id: string; label?: string }> }> => ({ models: [] }),
);
mock.module("../../../../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles: listLlmProfilesApi,
  fetchProviderProfileModels: fetchLlmModelsApi,
}));

const { act, cleanup, fireEvent, render: render_impl, waitFor, within } = await import("@testing-library/react");
const { ImageGenPane } = await import("./ImageGenPane.js");
const { useImageProfiles } = await import("../../../../hooks/use-image-profiles.js");
const { IMAGE_GEN_BACKENDS, IMAGE_GENERATION_MODES, IMAGE_GEN_PARAM_RANGES } = await import("@vibe-tavern/domain");
const { TooltipProvider } = await import("../../../shared/Tooltip.js");

/** App-realistic tree: app.tsx mounts TooltipProvider at the root, so the
 *  picker's CustomTooltip-wrapped in-row stars (CF3) render inside it in
 *  production — the harness wraps with the same provider (the menu-test
 *  pattern). */
function render(node: React.ReactElement): ReturnType<typeof render_impl> {
  return render_impl(<TooltipProvider delayDuration={200}>{node}</TooltipProvider>);
}

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** All six v1 modes — the pane must render a row for EVERY one (domain
 *  order is the render order). */
const ALL_MODES = Object.values(IMAGE_GENERATION_MODES) as string[];

function makeCaps(overrides: Partial<ImageGenRecord["capabilities"]> = {}): ImageGenRecord["capabilities"] {
  return {
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: { kind: "vendor-set", sizes: ["1024x1024", "832x1248"] },
    noApiKey: false,
    supportsLiveProgress: false,
        localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    ...overrides,
  };
}

function scalarCaps(overrides: Partial<ImageGenRecord["capabilities"]> = {}): ImageGenRecord["capabilities"] {
  return makeCaps({ supportsSeed: true, supportsSteps: true, supportsCfgScale: true, ...overrides });
}

function makeRecord(overrides: Partial<ImageGenRecord> = {}): ImageGenRecord {
  return {
    id: "ig1",
    name: "OpenRouter art",
    backend: "openrouter",
    presetId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    modelId: undefined,
    defaultParams: {},
    defaultParamsSetId: null,
    modeSizePresets: {},
    userSizes: [],
    llmAssistEnabled: false,
    familySource: "none",
    qualityLayerEnabled: false,
    llmProviderProfileId: undefined,
    llmModelId: undefined,
    capabilities: makeCaps(),
    isDefault: false,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeForm(overrides: Partial<NonNullable<ImageGenHook["form"]>> = {}): NonNullable<ImageGenHook["form"]> {
  return {
    id: "ig1",
    name: "OpenRouter art",
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    presetId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "",
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    modelId: null,
    defaultParams: {},
    defaultParamsSetId: null,
    modeSizePresets: {},
    userSizes: [],
    llmAssistEnabled: false,
    llmProviderProfileId: null,
    llmModelId: null,
    capabilities: makeCaps(),
    ...overrides,
  };
}

function makeImageGen(overrides: Partial<ImageGenHook> = {}): ImageGenHook {
  return {
    profiles: [] as ImageGenRecord[],
    loading: false,
    editingId: "ig1",
    form: makeForm(),
    dirty: false,
    error: null,
    saving: false,
    headerMode: "view",
    draftAutoKeyProviderName: null,
    modelsByProfile: {},
    samplersByProfile: {},
    schedulersByProfile: {},
    sidecarsByProfile: {},
    sidecarsFailedByProfile: {},
    vaeByProfile: {},
    samplerStatusByProfile: {},
    startEdit: mock(() => {}),
    startCreate: mock(() => {}),
    select: mock(() => {}),
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    activateProfile: mock(async () => {}),
    fetchSavedModels: mock(async () => null),
    fetchSamplers: mock(async () => null),
    fetchSchedulers: mock(async () => null),
    fetchSidecars: mock(async () => null),
    fetchVae: mock(async () => null),
    fetchDraftModels: mock(async () => []),
    favorites: [],
    starModel: mock(async () => {}),
    unstarModel: mock(async () => {}),
    modelOverlay: null,
    overlayDirty: false,
    loadModelOverlay: mock(async () => {}),
    bindModelOverlay: mock(async () => {}),
    unbindModelOverlay: mock(async () => {}),
    setModelOverlay: mock(() => {}),
    modelOverlaySetId: null,
    setModelSamplerSetBinding: mock(() => {}),
    applyBaseSamplerSet: mock(() => {}),
    ...overrides,
  };
}

/** Find a cmdk option by exact text and click it — portal content lives
 *  in document.body, not the RTL container (the editor-harness pattern). */
async function findAndClickOption(label: string) {
  const option = await waitFor(() => {
    const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
      (n) => n.textContent?.trim() === label,
    );
    expect(el).toBeTruthy();
    return el!;
  });
  await act(async () => {
    (option as HTMLElement).click();
  });
}

/** Open a Radix/cmdk dropdown by its trigger and click the option whose
 *  textContent matches (first click OPENS — do not call on an already-open
 *  popover: the trigger toggles). */
async function pickOption(view: { getByTestId: (id: string) => HTMLElement }, triggerId: string, label: string) {
  await act(async () => {
    view.getByTestId(triggerId).click();
  });
  await findAndClickOption(label);
}

async function pickOptionContaining(view: { getByTestId: (id: string) => HTMLElement }, triggerId: string, text: string) {
  await act(async () => {
    view.getByTestId(triggerId).click();
  });
  const option = await waitFor(() => {
    const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find((node) => node.textContent?.includes(text));
    expect(el).toBeTruthy();
    return el!;
  });
  await act(async () => {
    (option as HTMLElement).click();
  });
}

afterEach(async () => {
  await act(async () => {});
  cleanup();
  apiStore = [];
  settingsRow = null;
  favoritesList = [];
  for (const m of [
    listAllApi,
    updateProfileApi,
    getSettingsApi,
    upsertSettingsApi,
    deleteSettingsApi,
    listFavoritesApi,
    addFavoriteApi,
    removeFavoriteApi,
    listSamplersApi,
    listLlmProfilesApi,
    fetchLlmModelsApi,
    listSamplerSetsApi,
    listExtensionsApi,
    listFamiliesApi,
    setFamilyApi,
    detectFamilyApi,
  ]) {
    m.mockClear();
  }
  extensionsValue = [];
  faceDetectorsValue = null;
  faceDetectorCalls.length = 0;
  familiesFail = false;
  pendingFamilyWrite = null;
  detectOutcome = { ok: false, error: "no authoritative source answered", tried: [] };
  pendingDetect = null;
});

// IG-CF13: the slider cell is NumberInput inside a testid wrapper. Typing
// commits on blur (NumberInput's commit contract — steppers commit on
// click, typed text on blur-with-change).
async function typeCell(view: { getByTestId: (id: string) => HTMLElement }, cellId: string, value: string) {
  const input = view.getByTestId(cellId).querySelector("input");
  if (!input) throw new Error(`no <input> inside ${cellId}`);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.blur(input);
  });
}

describe("ImageGenPane — second level rendering", () => {
  it("renders the pane with the sizes accordion + params section; opening reveals a size row for EVERY v1 mode (six)", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-pane")).toBeTruthy());
    expect(view.getByTestId("image-gen-sizes-section")).toBeTruthy();
    expect(view.getByTestId("image-gen-params-section")).toBeTruthy();
    // IG-CF14: the table starts collapsed — no rows until the header opens it.
    expect(view.queryByTestId("image-gen-sizes-body")).toBeNull();
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    for (const mode of ALL_MODES) {
      expect(view.getByTestId(`image-gen-mode-row-${mode}`)).toBeTruthy();
    }
  });

  it("renders nothing without a form or for an UNSAVED profile (form.id null)", async () => {
    const noForm = render(<ImageGenPane imageGen={makeImageGen({ form: null })} />);
    expect(noForm.container.querySelector("[data-testid='image-gen-pane']")).toBeNull();
    cleanup();
    const unsaved = render(<ImageGenPane imageGen={makeImageGen({ form: makeForm({ id: null }) })} />);
    expect(unsaved.container.querySelector("[data-testid='image-gen-pane']")).toBeNull();
  });
});

describe("ImageGenPane — model picker (cached catalog + persisted stars)", () => {
  it("lists the cached models in the popover, favorites first in the FLAT sort (no group headers)", async () => {
    const imageGen = makeImageGen({
      modelsByProfile: {
        ig1: [
          { id: "m-alpha", label: "Alpha" },
          { id: "m-zeta", label: "Zeta" },
        ],
      },
      favorites: [
        { id: "fav1", profileId: "ig1", modelId: "m-zeta", label: "Zeta", createdAt: new Date().toISOString() },
      ],
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const options = await waitFor(() => {
      const nodes = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']"));
      expect(nodes.length).toBe(2);
      return nodes;
    });
    // Zeta is the favorite — it must render ABOVE Alpha despite the label
    // sort putting Alpha first (favorites-first SORT, the LLM canon).
    expect((options[0] as HTMLElement).textContent).toContain("Zeta");
    expect((options[1] as HTMLElement).textContent).toContain("Alpha");
    // The LLM dropdown is FLAT: the favorites group headers never render
    // (CF3 — the owner ruling: the LLM picker is the canon, and it sorts,
    // it does not section).
    expect(document.body.textContent).not.toContain("image_gen_favorites_group");
    expect(document.body.textContent).not.toContain("image_gen_all_models_group");
    // Every row carries its own in-row star toggle (h-5 w-5, the LLM canon).
    expect(options[0].querySelector('[data-testid="image-gen-model-star"]')).toBeTruthy();
    expect(options[1].querySelector('[data-testid="image-gen-model-star"]')).toBeTruthy();
  });

  it("the in-row star toggles favorites: star calls starModel(id, label); starred row's star calls unstarModel(id)", async () => {
    const starModel = mock(async () => {});
    const unstarModel = mock(async () => {});
    const imageGen = makeImageGen({
      modelsByProfile: {
        ig1: [
          { id: "m-alpha", label: "Alpha" },
          { id: "m-zeta", label: "Zeta" },
        ],
      },
      starModel,
      unstarModel,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const options = await waitFor(() => {
      const nodes = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']"));
      expect(nodes.length).toBe(2);
      return nodes;
    });
    // Click Alpha's in-row star — not Alpha's selection, the star INSIDE the
    // row (stopPropagation keeps the click off the row's own onSelect).
    fireEvent.click(options.find((n) => n.textContent?.includes("Alpha"))!.querySelector('[data-testid="image-gen-model-star"]')!);
    await waitFor(() => expect(starModel).toHaveBeenCalledTimes(1));
    expect((starModel.mock.calls[0] as unknown[])).toEqual(["m-alpha", "Alpha"]);
    expect(unstarModel).not.toHaveBeenCalled();
    cleanup();

    // Starred: the SAME in-row star now routes the DELETE-shaped call.
    const starred = makeImageGen({
      modelsByProfile: { ig1: [{ id: "m-alpha", label: "Alpha" }, { id: "m-zeta", label: "Zeta" }] },
      favorites: [
        { id: "fav1", profileId: "ig1", modelId: "m-alpha", label: "Alpha", createdAt: new Date().toISOString() },
      ],
      unstarModel,
    });
    const view2 = render(<ImageGenPane imageGen={starred} />);
    await waitFor(() => expect(view2.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view2.getByTestId("image-gen-field-model").click();
    });
    const options2 = await waitFor(() => {
      const nodes = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']"));
      expect(nodes.length).toBe(2);
      return nodes;
    });
    fireEvent.click(options2.find((n) => n.textContent?.includes("Alpha"))!.querySelector('[data-testid="image-gen-model-star"]')!);
    await waitFor(() => expect(unstarModel).toHaveBeenCalledTimes(1));
    expect((unstarModel.mock.calls[0] as unknown[])).toEqual(["m-alpha"]);
  });

  it("a custom slug typed in the search field becomes the modelId via setForm (use-custom-model)", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      modelsByProfile: { ig1: [{ id: "m-alpha", label: "Alpha" }] },
      setForm,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const search = await waitFor(() => {
      const input = Array.from(document.body.querySelectorAll("input")).find((i) =>
        i.placeholder.includes("search_models"),
      );
      expect(input).toBeTruthy();
      return input!;
    });
    await act(async () => {
      fireEvent.change(search, { target: { value: "my-hand-typed-model" } });
    });
    await findAndClickOption("use_custom_model_id:my-hand-typed-model");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(patch["modelId"]).toBe("my-hand-typed-model");
  });

  it("refresh re-fetches the SAVED profile's model catalog", async () => {
    const fetchSavedModels = mock(async () => null);
    const imageGen = makeImageGen({ fetchSavedModels });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-models-refresh")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-models-refresh"));
    await waitFor(() => expect(fetchSavedModels).toHaveBeenCalledTimes(1));
    expect((fetchSavedModels.mock.calls[0] as unknown[])).toEqual(["ig1"]);
  });
});

describe("ImageGenPane — local connection status (IG-CF12a)", () => {
  /** The A1111 form twin: local backend + sampler-capable + free sizes. */
  function makeLocalForm(overrides: Partial<NonNullable<ImageGenHook["form"]>> = {}) {
    return makeForm({
      backend: IMAGE_GEN_BACKENDS.A1111,
      endpoint: "http://127.0.0.1:7860",
      capabilities: makeCaps({ supportsSamplers: true, sizeSupport: { kind: "free" } }),
      ...overrides,
    });
  }

  it("offline: chip + endpoint above the picker, the control panel greyed AND natively disabled, shared error NOT set", async () => {
    const fetchSamplers = mock(async () => null);
    const imageGen = makeImageGen({
      form: makeLocalForm(),
      samplerStatusByProfile: { ig1: "offline" },
      fetchSamplers,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);

    const chip = view.getByTestId("image-gen-local-status");
    expect(chip.textContent).toContain("local_connection_offline");
    expect(chip.textContent).toContain("http://127.0.0.1:7860");
    // The pane never writes the shared error for connectivity (that was the
    // CF12 origin defect — the synthetic hook pins the pane side: the pane
    // reads the status, not the error, to grey the panel).
    const controls = view.getByTestId("image-gen-pane-controls");
    expect(controls.hasAttribute("disabled")).toBe(true);
    expect(controls.getAttribute("aria-disabled")).toBe("true");
    expect(controls.className).toContain("opacity-50");
    expect(controls.className).toContain("pointer-events-none");
    // happy-dom does not implement fieldset-descendant disabling (neither
    // the `:disabled` pseudo nor IDL propagation) — in real browsers the
    // native `disabled` additionally blocks keyboard focus/activation; the
    // grey + pointer-events-none classes are the observable pins here.
    // Settle the always-mounted family registry effect before this fast test
    // completes so its asynchronous state update stays inside React's act.
    await act(async () => {});
  });

  it("online: no disabled attribute, no grey, panel fully interactive", async () => {
    const imageGen = makeImageGen({
      form: makeLocalForm(),
      samplerStatusByProfile: { ig1: "online" },
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    const chip = view.getByTestId("image-gen-local-status");
    expect(chip.textContent).toContain("local_connection_online");
    const controls = view.getByTestId("image-gen-pane-controls");
    expect(controls.hasAttribute("disabled")).toBe(false);
    expect(controls.className).not.toContain("opacity-50");
    expect(controls.className).not.toContain("pointer-events-none");
    // See the offline case: this test also exits before the family registry
    // promise otherwise has a chance to commit its state under act.
    await act(async () => {});
  });

  it("the chip's re-check button refetches samplers for THIS profile (the recovery affordance while greyed)", async () => {
    const fetchSamplers = mock(async (_id?: string) => null);
    const imageGen = makeImageGen({
      form: makeLocalForm(),
      samplerStatusByProfile: { ig1: "offline" },
      fetchSamplers,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    // The mini button sits INSIDE the chip (outside the fieldset) — clickable
    // while the panel is greyed.
    const chip = view.getByTestId("image-gen-local-status");
    const recheck = chip.querySelector("button");
    expect(recheck).toBeTruthy();
    await act(async () => {
      recheck!.click();
    });
    expect(fetchSamplers.mock.calls[0]?.[0]).toBe("ig1");
  });

  it("cloud backends render NO chip (openrouter form — the default factory shape)", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-pane-controls")).toBeTruthy());
    expect(view.container.querySelector("[data-testid='image-gen-local-status']")).toBeNull();
    // And the controls wrapper is never disabled for cloud profiles.
    expect(view.getByTestId("image-gen-pane-controls").hasAttribute("disabled")).toBe(false);
  });
});

describe("ImageGenPane — per-mode sizes (IG-CF14: accordion + stepper ladder + swap + preset dropdown)", () => {
  const freeBackend = (formOverrides: Partial<NonNullable<ImageGenHook["form"]>> = {}) =>
    makeForm({
      backend: IMAGE_GEN_BACKENDS.A1111,
      capabilities: makeCaps({
        supportsNegativePrompt: true,
        supportsSamplers: true,
        supportsSeed: true,
        sizeSupport: { kind: "free" },
        noApiKey: true,
        supportsLiveProgress: true,
        localExecution: true,
      }),
      ...formOverrides,
    });

  async function renderFree(formOverrides: Parameters<typeof freeBackend>[0] = {}) {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({ form: freeBackend(formOverrides), setForm });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    return { view, setForm };
  }

  /** NumberInput has no testid passthrough — the pane wraps it in one; the
   * steppers are the two buttons inside (minus first, plus second). */
  function sizeCell(view: { getByTestId: (id: string) => HTMLElement }, side: "width" | "height", mode = "portrait") {
    return view.getByTestId(`image-gen-mode-${side}-${mode}`);
  }

  it("unset rows display the anchor defaults (1024×1024) and store NOTHING until edited", async () => {
    const { view } = await renderFree();
    const width = sizeCell(view, "width");
    const height = sizeCell(view, "height");
    expect((width.querySelector("input") as HTMLInputElement).value).toBe("1024");
    expect((height.querySelector("input") as HTMLInputElement).value).toBe("1024");
    expect(view.getByTestId("image-gen-mode-preset-portrait").textContent).toContain("image_gen_size_auto");
    // The vendor-set dropdown must not render for a free backend.
    expect(view.queryByTestId("image-gen-mode-size-portrait")).toBeNull();
  });

  it("steppers walk the ±128 ladder (owner example: 720 → 848↑ / 592↓) and pin the untouched side", async () => {
    const { view, setForm } = await renderFree({ modeSizePresets: { portrait: { width: 720, height: 1280 } } });
    const width = sizeCell(view, "width");
    const minus = width.querySelectorAll("button")[0]!;
    const plus = width.querySelectorAll("button")[1]!;
    await act(async () => {
      plus.click();
    });
    const patchAt = (i: number) =>
      ((setForm.mock.calls[i] as unknown[])[0] as { modeSizePresets: Record<string, { width: number; height: number }> })
        .modeSizePresets.portrait;
    // setForm is a mock — the form never rerenders, so NumberInput keeps its
    // internal string and the walk continues from the stepped value: the
    // owner's ladder example pinned at every step (720 ↑848, back down
    // through 720 to 592).
    expect(patchAt(0)).toEqual({ width: 848, height: 1280 });
    await act(async () => {
      minus.click();
    });
    expect(patchAt(1)).toEqual({ width: 720, height: 1280 });
    await act(async () => {
      minus.click();
    });
    expect(patchAt(2)).toEqual({ width: 592, height: 1280 });
  });

  it("stepping an UNSET row pins the pair: the untouched side commits its displayed anchor", async () => {
    const { view, setForm } = await renderFree();
    const height = sizeCell(view, "height");
    await act(async () => {
      height.querySelectorAll("button")[1]!.click();
    });
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, { width: number; height: number }> };
    expect(patch.modeSizePresets.portrait).toEqual({ width: 1024, height: 1152 });
  });

  it("raw typing never snaps: 733 stays 733 after blur", async () => {
    const { view, setForm } = await renderFree();
    const width = sizeCell(view, "width");
    const input = width.querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "733" } });
      fireEvent.blur(input);
    });
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, { width: number; height: number }> };
    expect(patch.modeSizePresets.portrait).toEqual({ width: 733, height: 1024 });
    expect((width.querySelector("input") as HTMLInputElement).value).toBe("733");
  });

  it("swap flips W↔H (the i18n'd tooltip names it); preset dropdown entries carry ratio + resolution", async () => {
    const { view, setForm } = await renderFree({ modeSizePresets: { portrait: { width: 720, height: 1280 } } });
    const swap = view.getByTestId("image-gen-mode-swap-portrait");
    // The i18n mock renders raw keys — the aria-label pins the swap key.
    expect(swap.getAttribute("aria-label")).toBe("image_gen_size_swap");
    await act(async () => {
      swap.click();
    });
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, { width: number; height: number }> };
    expect(patch.modeSizePresets.portrait).toEqual({ width: 1280, height: 720 });
  });

  it("picking a preset fills BOTH fields; Auto clears the row back to unset", async () => {
    const { view, setForm } = await renderFree();
    // The i18n mock renders preset labels as key:params — pick the full mocked string.
    await pickOption(view, "image-gen-mode-preset-portrait", "image_gen_preset_portrait:2:3,832×1216");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    let patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, { width: number; height: number }> };
    expect(patch.modeSizePresets.portrait).toEqual({ width: 832, height: 1216 });
    cleanup();

    // From a stored table pair, Auto deletes the row preset entirely.
    const second = await renderFree({ modeSizePresets: { portrait: { width: 832, height: 1216 } } });
    await pickOption(second.view, "image-gen-mode-preset-portrait", "image_gen_size_auto");
    await waitFor(() => expect(second.setForm).toHaveBeenCalled());
    const secondPatch = (second.setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, unknown> };
    expect(secondPatch.modeSizePresets).toEqual({});
  });

  it("a stored custom pair outside the table renders its own dropdown entry (never lies about the value)", async () => {
    const { view } = await renderFree({ modeSizePresets: { portrait: { width: 733, height: 900 } } });
    expect(view.getByTestId("image-gen-mode-preset-portrait").textContent).toContain("733×900");
  });

  it("vendor-set backends: a dropdown per mode with the capability grid; picking one patches modeSizePresets", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({ setForm });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-mode-size-portrait")).toBeTruthy());
    // Unset mode → the auto placeholder label shows in the trigger.
    expect(view.getByTestId("image-gen-mode-size-portrait").textContent).toContain("image_gen_size_auto");
    await pickOption(view, "image-gen-mode-size-portrait", "832x1248");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, unknown> };
    expect(patch.modeSizePresets).toEqual({ portrait: { width: 832, height: 1248 } });
  });

  it("custom size block (IG-20a): OpenRouter shows the ratio field, duplicates stay disabled, a complete entry adds to userSizes", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({ setForm });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-user-sizes")).toBeTruthy());
    // OpenRouter's wire is ratio-native → the ratio field renders.
    expect(view.getByTestId("image-gen-user-size-ratio")).toBeTruthy();
    // Default draft 1024×1024 duplicates the vendor table → Add disabled.
    expect((view.getByTestId("image-gen-user-size-add") as HTMLButtonElement).disabled).toBe(true);
    await typeCell(view, "image-gen-user-size-width", "1152");
    await typeCell(view, "image-gen-user-size-height", "896");
    // Off-table pair but ratio still empty → still disabled.
    expect((view.getByTestId("image-gen-user-size-add") as HTMLButtonElement).disabled).toBe(true);
    const ratioInput = view.getByTestId("image-gen-user-size-ratio").querySelector("input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(ratioInput, { target: { value: "9:7" } });
    });
    await waitFor(() =>
      expect((view.getByTestId("image-gen-user-size-add") as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      view.getByTestId("image-gen-user-size-add").click();
    });
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as {
      userSizes: Array<{ width: number; height: number; ratio?: string }>;
    };
    expect(patch.userSizes).toEqual([{ width: 1152, height: 896, ratio: "9:7" }]);
  });

  it("custom size block (IG-20a): pixel-wire backends have NO ratio field; a bare W×H entry adds", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      setForm,
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.OpenAiImages }),
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-user-sizes")).toBeTruthy());
    expect(view.queryByTestId("image-gen-user-size-ratio")).toBeNull();
    await typeCell(view, "image-gen-user-size-width", "1216");
    await typeCell(view, "image-gen-user-size-height", "896");
    await waitFor(() =>
      expect((view.getByTestId("image-gen-user-size-add") as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      view.getByTestId("image-gen-user-size-add").click();
    });
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as {
      userSizes: Array<{ width: number; height: number; ratio?: string }>;
    };
    expect(patch.userSizes).toEqual([{ width: 1216, height: 896 }]);
  });

  it("user entries (IG-20a) join the mode dropdowns with their ratio label and delete removes them", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      setForm,
      form: makeForm({ userSizes: [{ width: 1152, height: 896, ratio: "9:7" }] }),
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await act(async () => {
      view.getByTestId("image-gen-sizes-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-user-sizes-list")).toBeTruthy());
    expect(view.getByTestId("image-gen-user-sizes-list").textContent).toContain("1152×896");
    expect(view.getByTestId("image-gen-user-sizes-list").textContent).toContain("9:7");
    // The entry is pickable in a mode dropdown — label carries the ratio.
    await pickOption(view, "image-gen-mode-size-portrait", "1152×896 · 9:7");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const pickPatch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, unknown> };
    expect(pickPatch.modeSizePresets).toEqual({ portrait: { width: 1152, height: 896 } });
    // Delete drops the entry from the profile form.
    await act(async () => {
      view.getByTestId("image-gen-user-size-delete-1152x896").click();
    });
    await waitFor(() => expect(setForm.mock.calls.length).toBe(2));
    const deletePatch = (setForm.mock.calls[1] as unknown[])[0] as {
      userSizes: Array<{ width: number; height: number; ratio?: string }>;
    };
    expect(deletePatch.userSizes).toEqual([]);
  });
});

describe("ImageGenPane — comfyui dialect surfaces (CG-B1)", () => {
  const COMFY_MODELS: ImageGenModelEntry[] = [
    { id: "graycolor_v18.safetensors", label: "graycolor_v18", family: "Illustrious", template: "checkpoint" },
    {
      id: "raySemiReal_krea2TurboV1Nsfw.safetensors",
      label: "raySemiReal_krea2TurboV1Nsfw",
      family: "Krea 2",
      template: "krea2-dit",
    },
  ];

  function comfyImageGen(
    formOverrides: Partial<NonNullable<ImageGenHook["form"]>> = {},
    hookOverrides: Partial<ImageGenHook> = {},
  ): ImageGenHook {
    return makeImageGen({
      form: makeForm({
        backend: IMAGE_GEN_BACKENDS.ComfyUI,
        presetId: "comfyui",
        endpoint: "http://127.0.0.1:8188",
        modelId: "graycolor_v18.safetensors",
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          sizeSupport: { kind: "free" },
          localExecution: true,
        }),
        ...formOverrides,
      }),
      ...hookOverrides,
    });
  }

  it("comfy joins the local family: status chip + scheduler surface render; a CHECKPOINT model shows its Detected readout and NO DiT fields", async () => {
    const view = render(
      <ImageGenPane imageGen={comfyImageGen({}, { modelsByProfile: { ig1: COMFY_MODELS } })} />,
    );
    // The IG-CF12a chip — the local-family gate widened to comfy (CG-B1).
    await waitFor(() => expect(view.getByTestId("image-gen-local-status")).toBeTruthy());
    // «Detected: Checkpoint» — the template marker through the i18n mock.
    expect(view.getByTestId("image-gen-model-detected").textContent).toBe(
      "image_gen_detected_template:image_gen_template_checkpoint",
    );
    await openAdvanced(view);
    // The scheduler surface is dialect-gated on the LOCAL family — comfy
    // feeds from the KSampler combo (CG-A3), the same dropdown as a1111.
    await waitFor(() => expect(view.getByTestId("image-gen-field-scheduler")).toBeTruthy());
    // The DiT sidecar fields are template-gated: a checkpoint model must
    // not render them.
    expect(view.queryByTestId("image-gen-field-encoder")).toBeNull();
    expect(view.queryByTestId("image-gen-field-vae")).toBeNull();
  });

  it("T3 hint parity: a failed sidecar fetch renders the failure hint under the DiT fields (the chip's twin); a clean fetch renders none", async () => {
    const view = render(
      <ImageGenPane
        imageGen={comfyImageGen(
          { modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors" },
          {
            modelsByProfile: { ig1: COMFY_MODELS },
            sidecarsByProfile: {
              ig1: { encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vaes: ["qwen_image_vae.safetensors"] },
            },
            sidecarsFailedByProfile: { ig1: true },
          },
        )}
      />,
    );
    await openAdvanced(view);
    expect(view.getByTestId("image-gen-sidecars-failed").textContent).toBe("image_gen_sidecars_failed");

    // The clean profile (flag clear / absent) renders no hint.
    view.unmount();
    const clean = render(
      <ImageGenPane
        imageGen={comfyImageGen(
          { modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors" },
          {
            modelsByProfile: { ig1: COMFY_MODELS },
            sidecarsByProfile: {
              ig1: { encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vaes: ["qwen_image_vae.safetensors"] },
            },
          },
        )}
      />,
    );
    await openAdvanced(clean);
    expect(clean.queryByTestId("image-gen-sidecars-failed")).toBeNull();
  });

  it("a DiT model shows the Krea-2 Detected readout, the family chip in the picker, and encoder/VAE fields fed from the sidecar cache", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane
        imageGen={comfyImageGen(
          { modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors" },
          {
            modelsByProfile: { ig1: COMFY_MODELS },
            sidecarsByProfile: {
              ig1: { encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vaes: ["qwen_image_vae.safetensors"] },
            },
            setForm,
          },
        )}
      />,
    );
    expect(view.getByTestId("image-gen-model-detected").textContent).toBe(
      "image_gen_detected_template:image_gen_template_krea2_dit",
    );
    // The picker rows carry the family chip (the "free" chip's shape).
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    await waitFor(() => {
      const chips = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-family']"));
      expect(chips.length).toBe(2);
      expect((chips[1] as HTMLElement).textContent).toBe("Krea 2");
      return chips;
    });
    await act(async () => {
      fireEvent.click(document.body);
    });
    // The DiT fields: same bind routing as the sampler (bind off → the
    // profile base layer).
    await openAdvanced(view);
    await pickOption(view, "image-gen-field-encoder", "qwen3vl_4b_fp8_scaled.safetensors");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ encoderName: "qwen3vl_4b_fp8_scaled.safetensors" });
    await pickOption(view, "image-gen-field-vae", "qwen_image_vae.safetensors");
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(2));
    const patch2 = (setForm.mock.calls[1] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch2.defaultParams).toEqual({ vaeName: "qwen_image_vae.safetensors" });

    // CG-B2 parity fix: Auto is PICKABLE in the opened list (defaultOption —
    // empty-id options are filtered out) and picking it CLEARS the field.
    await pickOption(view, "image-gen-field-encoder", "image_gen_sidecar_auto");
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(3));
    const patch3 = (setForm.mock.calls[2] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch3.defaultParams).toEqual({ encoderName: undefined });
  });

  it("the sidecar cache fills ONCE while a DiT model is selected (options-data fetch, no status signal)", async () => {
    const fetchSidecars = mock(async () => null);
    const view = render(
      <ImageGenPane
        imageGen={comfyImageGen(
          { modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors" },
          { modelsByProfile: { ig1: COMFY_MODELS }, fetchSidecars },
        )}
      />,
    );
    await waitFor(() => expect(fetchSidecars).toHaveBeenCalledWith("ig1"));
    // A checkpoint selection never fires the sidecar fetch.
    const fetchSidecars2 = mock(async () => null);
    render(
      <ImageGenPane
        imageGen={comfyImageGen({}, { modelsByProfile: { ig1: COMFY_MODELS }, fetchSidecars: fetchSidecars2 })}
      />,
    );
    await act(async () => {});
    expect(fetchSidecars2).not.toHaveBeenCalled();
  });

  it("picking a DiT model on an UNTOUCHED param base prefills the krea2 starting points as EXPLICIT form values (CF5); a tuned base is kept verbatim", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={comfyImageGen({ modelId: null }, { modelsByProfile: { ig1: COMFY_MODELS }, setForm })} />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    // The model rows carry the family chip (extra text) — open the picker,
    // then click by CONTAINS (the test-344 direct-DOM idiom), not the
    // exact-text helper.
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const ditOption = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']")).find(
        (n) => n.textContent?.includes("raySemiReal_krea2TurboV1Nsfw"),
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      ditOption.click();
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    expect((setForm.mock.calls[0] as unknown[])[0]).toEqual({
      modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors",
      defaultParams: { steps: 8, cfgScale: 1, sampler: "euler", scheduler: "simple" },
    });
    cleanup();

    // A base the user already tuned for checkpoints keeps its values — no
    // partial merge of the krea2 starting points (the all-four-unset gate).
    const setForm2 = mock(() => {});
    const view2 = render(
      <ImageGenPane
        imageGen={comfyImageGen(
          { modelId: null, defaultParams: { steps: 30, cfgScale: 7 } },
          { modelsByProfile: { ig1: COMFY_MODELS }, setForm: setForm2 },
        )}
      />,
    );
    await waitFor(() => expect(view2.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view2.getByTestId("image-gen-field-model").click();
    });
    const ditOption2 = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']")).find(
        (n) => n.textContent?.includes("raySemiReal_krea2TurboV1Nsfw"),
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      ditOption2.click();
    });
    await waitFor(() => expect(setForm2).toHaveBeenCalledTimes(1));
    expect((setForm2.mock.calls[0] as unknown[])[0]).toEqual({ modelId: "raySemiReal_krea2TurboV1Nsfw.safetensors" });
  });

  it("IF-8b: a krea2-dit template WITHOUT Krea-2 family truth (a bare Anima DiT) prefills NOTHING — the folder marker is not Krea-2 truth", async () => {
    // The owner's live case: homosimileAnima lives in diffusion_models (the
    // krea2-dit template marker) but is its own family — krea2 starting
    // points (8 steps / CFG 1) are garbage for it; its own stock set rides
    // detect-preselect instead (IF-7b).
    const animaDiT: ImageGenModelEntry[] = [
      { id: "homosimileAnima_v20.safetensors", label: "homosimileAnima_v20", family: "Anima", template: "krea2-dit" },
    ];
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={comfyImageGen({ modelId: null }, { modelsByProfile: { ig1: animaDiT }, setForm })} />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const ditOption = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']")).find(
        (n) => n.textContent?.includes("homosimileAnima_v20"),
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      ditOption.click();
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    // modelId only — the krea2 prefill stays OFF without family truth, and
    // no defaultParams key rides the patch at all.
    expect((setForm.mock.calls[0] as unknown[])[0]).toEqual({ modelId: "homosimileAnima_v20.safetensors" });
  });
});

describe("ImageGenPane — params: sampler gating + bind routing + advanced", () => {
  it("sampler dropdown renders ONLY for supportsSamplers backends and feeds from samplersByProfile", async () => {
    const setForm = mock(() => {});
    const a1111 = makeImageGen({
      form: makeForm({
        backend: IMAGE_GEN_BACKENDS.A1111,
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          sizeSupport: { kind: "free" },
          noApiKey: true,
          supportsLiveProgress: true,
        localExecution: true,
        }),
      }),
      samplersByProfile: { ig1: [{ name: "Euler a", aliases: [] }, { name: "DPM++ 2M", aliases: [] }] },
      setForm,
    });
    const view = render(<ImageGenPane imageGen={a1111} />);
    await openAdvanced(view);
    await waitFor(() => expect(view.getByTestId("image-gen-field-sampler")).toBeTruthy());
    await pickOption(view, "image-gen-field-sampler", "Euler a");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ sampler: "Euler a" });
    cleanup();

    // OpenRouter (no sampler surface): the control must not render at all —
    // checked with the accordion OPEN so the pin is about GATING, not about
    // the collapsed state hiding it.
    const openrouter = makeImageGen({ setForm });
    const view2 = render(<ImageGenPane imageGen={openrouter} />);
    await openAdvanced(view2);
    expect(view2.queryByTestId("image-gen-field-sampler")).toBeNull();
  });

  it("scheduler dropdown renders ONLY for the A1111 dialect, feeds from schedulersByProfile, and routes through setParam (PG-3)", async () => {
    const setForm = mock(() => {});
    const a1111 = makeImageGen({
      form: makeForm({
        backend: IMAGE_GEN_BACKENDS.A1111,
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          sizeSupport: { kind: "free" },
          noApiKey: true,
          supportsLiveProgress: true,
        localExecution: true,
        }),
      }),
      schedulersByProfile: { ig1: [{ name: "karras", label: "Karras" }, { name: "sgm_uniform" }] },
      setForm,
    });
    const view = render(<ImageGenPane imageGen={a1111} />);
    await openAdvanced(view);
    await waitFor(() => expect(view.getByTestId("image-gen-field-scheduler")).toBeTruthy());
    await pickOption(view, "image-gen-field-scheduler", "Karras");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ scheduler: "karras" });
    cleanup();

    // OpenRouter: no scheduler surface on cloud dialects — the control must
    // not render at all (accordion open, so the pin is about GATING).
    const openrouter = makeImageGen({ setForm });
    const view2 = render(<ImageGenPane imageGen={openrouter} />);
    await openAdvanced(view2);
    expect(view2.queryByTestId("image-gen-field-scheduler")).toBeNull();
  });

  it("capability gates show Krea seed only, Luma no scalar controls, and all four controls for ComfyUI", async () => {
    let view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.Krea, capabilities: makeCaps({ supportsSeed: true }) }),
        })}
      />,
    );
    await openAdvanced(view);
    for (const id of ["image-gen-field-steps", "image-gen-field-cfg", "image-gen-field-clip-skip"]) {
      expect(view.queryByTestId(id)).toBeNull();
    }
    expect(view.getByTestId("image-gen-field-seed")).toBeTruthy();
    cleanup();

    view = render(
      <ImageGenPane
        imageGen={makeImageGen({ form: makeForm({ backend: "luma", capabilities: makeCaps() }) })}
      />,
    );
    await openAdvanced(view);
    for (const id of ["image-gen-field-steps", "image-gen-field-cfg", "image-gen-field-clip-skip", "image-gen-field-seed"]) {
      expect(view.queryByTestId(id)).toBeNull();
    }
    cleanup();

    view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, capabilities: scalarCaps({ supportsClipSkip: true }) }),
        })}
      />,
    );
    await openAdvanced(view);
    expect((view.getByTestId("image-gen-field-seed") as HTMLInputElement).value).toBe("");
    for (const id of ["image-gen-field-steps", "image-gen-field-cfg", "image-gen-field-clip-skip"]) {
      expect(view.getByTestId(id).querySelector("input")).toBeTruthy();
    }
    expect(view.getByTestId("image-gen-advanced-body").querySelectorAll("input").length).toBe(7);
  });

  it("bind OFF: numeric edits route to the PROFILE BASE (setForm defaultParams), overlay untouched", async () => {
    const setForm = mock(() => {});
    const setModelOverlay = mock(() => {});
    const imageGen = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha", capabilities: scalarCaps() }),
      setForm,
      setModelOverlay,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    // Unbound: no overlay-inherit hint renders.
    expect(view.queryByTestId("image-gen-overlay-inherit-hint")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByText("image_gen_advanced"));
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    await typeCell(view, "image-gen-field-steps", "30");
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ steps: 30 });
    expect(setModelOverlay).not.toHaveBeenCalled();
  });

  it("bind ON: the inherit hint renders, edits route to the overlay, toggle-off calls unbindModelOverlay", async () => {
    const setForm = mock(() => {});
    const setModelOverlay = mock(() => {});
    const bindModelOverlay = mock(async () => {});
    const unbindModelOverlay = mock(async () => {});
    // Phase 1 — UNBOUND (modelOverlay null): the toggle is off, no hint;
    // clicking it routes through bindModelOverlay.
    const unbound = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha", capabilities: scalarCaps() }),
      setForm,
      setModelOverlay,
      bindModelOverlay,
      unbindModelOverlay,
    });
    const view1 = render(<ImageGenPane imageGen={unbound} />);
    await waitFor(() => expect(view1.getByTestId("image-gen-params-section")).toBeTruthy());
    expect(view1.queryByTestId("image-gen-overlay-inherit-hint")).toBeNull();
    fireEvent.click(view1.getByRole("switch", { name: "image_gen_bind_per_model" }));
    await waitFor(() => expect(bindModelOverlay).toHaveBeenCalledTimes(1));
    cleanup();

    // Phase 2 — BOUND (modelOverlay {}): the inherit hint renders; numeric
    // edits route to the overlay, never to the profile base.
    const imageGen = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha", capabilities: scalarCaps() }),
      modelOverlay: {},
      setForm,
      setModelOverlay,
      bindModelOverlay,
      unbindModelOverlay,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-overlay-inherit-hint")).toBeTruthy());

    await act(async () => {
      fireEvent.click(view.getByText("image_gen_advanced"));
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    await typeCell(view, "image-gen-field-steps", "30");
    await waitFor(() => expect(setModelOverlay).toHaveBeenCalledTimes(1));
    expect((setModelOverlay.mock.calls[0] as unknown[])[0]).toEqual({ steps: 30 });
    expect(setForm).not.toHaveBeenCalled();

    // Unbind is the destructive revert — the toggle-off wires to it.
    fireEvent.click(view.getByRole("switch", { name: "image_gen_bind_per_model" }));
    await waitFor(() => expect(unbindModelOverlay).toHaveBeenCalledTimes(1));
  });

  it("the bind toggle renders ONLY when a model is selected", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen({ form: makeForm({ modelId: null }) })} />);
    await waitFor(() => expect(view.getByTestId("image-gen-params-section")).toBeTruthy());
    // The BIND toggle's section must hold no switch without a model (the
    // assist toggle lives in its own section and is always present — IG-15).
    expect(view.getByTestId("image-gen-params-section").querySelector('[role="switch"]')).toBeNull();
  });
});

describe("ImageGenPane — Krea 2 section (T6, TWIN_UNIFICATION step 2)", () => {
  it("renders for krea-2 models on BOTH arms — never gated behind the bind toggle (owner ruling); hidden on third-party models", async () => {
    // Unbound — the section still renders and writes the PROFILE BASE
    // (the per-model bind toggle is for per-model overrides, not a gate
    // for generative controls).
    const unbound = render(
      <ImageGenPane
        imageGen={makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.Krea, modelId: "krea/krea-2/medium" }) })}
      />,
    );
    await waitFor(() => expect(unbound.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await openAdvanced(unbound);
    await waitFor(() => expect(unbound.getByTestId("image-gen-krea-section")).toBeTruthy());
    expect(unbound.getByText("image_gen_krea_creativity")).toBeTruthy();
    expect(unbound.getByText("image_gen_krea_movement")).toBeTruthy();
    cleanup();

    // A third-party aggregator model on the same backend — no generative
    // controls (the descriptor's gate).
    const thirdParty = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.Krea, modelId: "google/nano-banana" }),
          modelOverlay: {},
        })}
      />,
    );
    await waitFor(() => expect(thirdParty.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await openAdvanced(thirdParty);
    expect(thirdParty.queryByTestId("image-gen-krea-section")).toBeNull();
    cleanup();

    // Bound + a krea-2 model: the CF13/CF15 canon — the display reads the
    // ARM's own block. The overlay's intensity shows; the base's movement
    // does NOT leak into the bound display (the anchor default 0 shows;
    // the GENERATION ladder still inherits the base per-field).
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({
            backend: IMAGE_GEN_BACKENDS.Krea,
            modelId: "krea/krea-2/medium",
            defaultParams: { krea: { movement: 20 } },
          }),
          modelOverlay: { krea: { intensity: 40 } },
        })}
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await openAdvanced(view);
    await waitFor(() => expect(view.getByTestId("image-gen-krea-section")).toBeTruthy());
    expect(view.getByTestId("image-gen-range-krea-intensity")).toBeTruthy();
    expect((view.getByTestId("image-gen-range-krea-intensity") as HTMLInputElement).value).toBe("40");
    expect((view.getByTestId("image-gen-range-krea-movement") as HTMLInputElement).value).toBe("0");
  });

  it("commits write the ACTIVE arm — the profile base when unbound, the overlay when bound (merge into the arm's own block, siblings preserved)", async () => {
    const setForm = mock(() => {});
    const setModelOverlay = mock(() => {});
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.Krea, modelId: "krea/krea-2/medium" }),
          setForm,
          setModelOverlay,
        })}
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await openAdvanced(view);
    await waitFor(() => expect(view.getByTestId("image-gen-krea-section")).toBeTruthy());

    // UNBOUND: creativity High writes the BASE defaultParams, not the overlay.
    await act(async () => {
      fireEvent.click(view.getByText("image_gen_krea_creativity_high"));
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    expect((setForm.mock.calls[0] as unknown[])[0]).toEqual({ defaultParams: { krea: { creativity: "high" } } });
    expect(setModelOverlay).not.toHaveBeenCalled();

    // The real store would hold the written base now — re-render with it
    // (the mock setForm does not apply the write) so the slider commit
    // merges against the CURRENT block, as it does in production.
    const kreaForm = makeForm({
      backend: IMAGE_GEN_BACKENDS.Krea,
      modelId: "krea/krea-2/medium",
      defaultParams: { krea: { creativity: "high" } },
    });
    view.rerender(
      <TooltipProvider delayDuration={200}>
        <ImageGenPane
          imageGen={makeImageGen({
            form: kreaForm,
            setForm,
            setModelOverlay,
          })}
        />
      </TooltipProvider>,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-krea-section")).toBeTruthy());

    // The intensity slider merges into the SAME base block.
    const range = view.getByTestId("image-gen-range-krea-intensity") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(range, { target: { value: "40" } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(2));
    expect((setForm.mock.calls[1] as unknown[])[0]).toEqual({
      defaultParams: { krea: { creativity: "high", intensity: 40 } },
    });
    expect(setModelOverlay).not.toHaveBeenCalled();

    // BOUND arm: the same section writes the OVERLAY's own block instead.
    // (Unmount first — two live panes in one document collide on the
    // document-scoped queries inside openAdvanced.)
    view.unmount();
    const bound = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: kreaForm,
          modelOverlay: {},
          setForm,
          setModelOverlay,
        })}
      />,
    );
    await waitFor(() => expect(bound.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await openAdvanced(bound);
    await waitFor(() => expect(bound.getByTestId("image-gen-krea-section")).toBeTruthy());
    await act(async () => {
      fireEvent.click(bound.getByText("image_gen_krea_creativity_high"));
    });
    await waitFor(() => expect(setModelOverlay).toHaveBeenCalledTimes(1));
    expect((setModelOverlay.mock.calls[0] as unknown[])[0]).toEqual({ krea: { creativity: "high" } });
  });
});

/** Open the advanced accordion (module scope — shared across describes). */
async function openAdvanced(view: { getByTestId: (id: string) => HTMLElement; getByText: (text: string) => HTMLElement }) {
  await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
  await act(async () => {
    fireEvent.click(view.getByText("image_gen_advanced"));
  });
  await waitFor(() => expect(view.getByTestId("image-gen-advanced-body")).toBeTruthy());
}

describe("ImageGenPane — advanced sliders (IG-CF5)", () => {
  it("a range move commits the value to the profile base (bind off)", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, capabilities: scalarCaps() }), setForm })} />,
    );
    await openAdvanced(view);
    const max = IMAGE_GEN_PARAM_RANGES.steps.max;
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-range-steps"), { target: { value: String(max) } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ steps: max });
  });

  it("a typed number commits through the slider field's number cell", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, capabilities: scalarCaps() }), setForm })} />,
    );
    await openAdvanced(view);
    const max = IMAGE_GEN_PARAM_RANGES.cfgScale.max;
    await typeCell(view, "image-gen-field-cfg", String(max));
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ cfgScale: max });
  });

  it("IG-CF13/CF15: a BOUND overlay with an empty field shows the range-min anchor, not the profile base (owner rollback 2026-09-17)", async () => {
    // The inherit-display variant (empty overlay cell showing the profile
    // base value) was rolled back by the owner: SamplerSliderField stays
    // verbatim CF13 — `value ?? range.min`. An empty bound overlay cell
    // shows the same range-min anchor as an unbound one; the generation
    // merge ladder (overlay > base > vendor) is where inheritance actually
    // resolves, not in the cell display.
    const imageGen = makeImageGen({
      form: makeForm({
        backend: IMAGE_GEN_BACKENDS.A1111,
        modelId: "m-alpha",
        capabilities: scalarCaps(),
        defaultParams: { steps: IMAGE_GEN_PARAM_RANGES.steps.max },
      }),
      modelOverlay: {},
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    const input = view.getByTestId("image-gen-field-steps").querySelector("input");
    if (!input) throw new Error("no steps input");
    expect((input as HTMLInputElement).value).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.min));
    // The anchor display alone commits NOTHING (untouched params don't send).
    expect((imageGen.setForm as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("seed stays a plain numeric field with NO range input", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, capabilities: scalarCaps() }), setForm })} />,
    );
    await openAdvanced(view);
    // A 0..2^32 range is meaningless on a slider (owner-approved) — no
    // range input exists for seed, only the plain numeric cell.
    expect(view.queryByTestId("image-gen-range-seed")).toBeNull();
    const seed = view.getByTestId("image-gen-field-seed") as HTMLInputElement;
    expect(seed.tagName).toBe("INPUT");
    expect(seed.value).toBe("");
    await act(async () => {
      fireEvent.change(seed, { target: { value: "12345" } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ seed: 12345 });
  });

  it("an a1111 profile renders the steps slider with the domain min/max/step (no duplicated literals)", async () => {
    const imageGen = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, capabilities: scalarCaps() }),
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    // A1111 wires steps and CFG but deliberately has no clip-skip surface.
    expect(view.getByTestId("image-gen-range-cfg")).toBeTruthy();
    expect(view.queryByTestId("image-gen-range-clip-skip")).toBeNull();
    const range = view.getByTestId("image-gen-range-steps");
    expect(range.getAttribute("min")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.min));
    expect(range.getAttribute("max")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.max));
    expect(range.getAttribute("step")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.step));
  });

  it("IG-CF13: undefined params render the range-min anchor (SamplerField `value ?? min` — no empty box); nothing commits on open", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({
        form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, capabilities: scalarCaps({ supportsClipSkip: true }) }),
        setForm,
      })} />,
    );
    await openAdvanced(view);
    const pairs: Array<[string, string, keyof typeof IMAGE_GEN_PARAM_RANGES]> = [
      ["image-gen-field-steps", "image-gen-range-steps", "steps"],
      ["image-gen-field-cfg", "image-gen-range-cfg", "cfgScale"],
      ["image-gen-field-clip-skip", "image-gen-range-clip-skip", "clipSkip"],
    ];
    for (const [fieldId, rangeId, key] of pairs) {
      // The cell displays the min as the editing ANCHOR (the LLM SamplerField
      // display) — the anchor alone commits nothing (param not sent).
      const input = view.getByTestId(fieldId).querySelector("input") as HTMLInputElement;
      expect(input.value).toBe(String(IMAGE_GEN_PARAM_RANGES[key].min));
      expect((view.getByTestId(rangeId) as HTMLInputElement).value).toBe(String(IMAGE_GEN_PARAM_RANGES[key].min));
    }
    expect(setForm).not.toHaveBeenCalled();
  });

  it("a typed out-of-range number commits CLAMPED to the domain max (the NumberInput semantics)", async () => {
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, capabilities: scalarCaps() }), setForm })} />,
    );
    await openAdvanced(view);
    // Ten-times-max via string concat (no literals): forces the clamp lane.
    const over = `${IMAGE_GEN_PARAM_RANGES.steps.max}0`;
    await typeCell(view, "image-gen-field-steps", over);
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ steps: IMAGE_GEN_PARAM_RANGES.steps.max });
  });
});

describe("ImageGenPane — named set row in the advanced header (CF15c, LLM accordion clone)", () => {
  it("bound: the set row lives in the header, columnates on mobile, and never toggles the accordion", async () => {
    const imageGen = makeImageGen({
      form: makeForm({ modelId: "m-alpha" }),
      modelOverlay: {},
      modelOverlaySetId: "set-a",
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    const header = await waitFor(() => {
      const h = view.getByTestId("image-gen-advanced-header");
      expect(h).toBeTruthy();
      return h;
    });
    // Header shape parity with the LLM sampler accordion (ProviderSamplerPanel):
    // mobile-first column, desktop row with title left / set row right.
    expect(header.className).toContain("flex-col");
    expect(header.className).toContain("max-md:items-stretch");
    expect(header.className).toContain("md:flex-row");
    expect(header.className).toContain("md:justify-between");
    // The set cluster is the header's second child and columnates too.
    const cluster = view.getByTestId("image-gen-model-set-row");
    expect(cluster.parentElement).toBe(header);
    expect(cluster.className).toContain("max-md:flex-col");
    expect(cluster.className).toContain("md:flex-row");
    // The full icon-action row is present (7 actions + hidden file input).
    for (const action of ["new", "save", "rename", "revert", "delete", "import", "export"]) {
      expect(view.getByTestId(`image-gen-set-${action}`)).toBeTruthy();
    }
    // Title-only toggle: the body stays closed until the TITLE is clicked.
    expect(view.queryByTestId("image-gen-advanced-body")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByTestId("image-gen-model-set-trigger"));
    });
    expect(view.queryByTestId("image-gen-advanced-body")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByText("image_gen_advanced"));
    });
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-body")).toBeTruthy());
  });

  it("unbound (IF-7a): the set row is NOT gated — selecting a set applies its payload to the profile BASE, never the overlay arm", async () => {
    const applyBaseSamplerSet = mock(
      (_setId: string | null, _payload?: { steps?: number; cfgScale?: number; sampler?: string; seed?: number; clipSkip?: number }) => {},
    );
    const setModelSamplerSetBinding = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ applyBaseSamplerSet, setModelSamplerSetBinding })} />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    // Owner ruling 2026-09-22: the per-model toggle gates only the overlay
    // FIELDS — the sets row renders with binding OFF too.
    expect(view.getByTestId("image-gen-model-set-row")).toBeTruthy();
    expect(view.getByTestId("image-gen-set-new")).toBeTruthy();

    await pickOption(view, "image-gen-model-set-trigger", "Cinematic 30");
    // The BASE arm receives the copy-on-select payload + pointer.
    await waitFor(() => expect(applyBaseSamplerSet).toHaveBeenCalledTimes(1));
    expect(applyBaseSamplerSet.mock.calls[0]![0]).toBe("set-a");
    expect(applyBaseSamplerSet.mock.calls[0]![1]).toEqual({ steps: 30, cfgScale: 5, sampler: "Euler a", clipSkip: 1 });
    // The overlay arm stays untouched while unbound (arm separation).
    expect(setModelSamplerSetBinding).not.toHaveBeenCalled();
  });

  it("IF-7b: a set carrying scheduler + vae + a hires block applies the WHOLE payload to the base (the grown projection)", async () => {
    const applyBaseSamplerSet = mock(
      (_setId: string | null, _payload?: Record<string, unknown>) => {},
    );
    const grown = {
      id: "set-grown",
      name: "Anima",
      sortOrder: 1,
      payload: {
        sampler: "euler_sde",
        scheduler: "simple",
        steps: 30,
        cfgScale: 5,
        vae: "qwen_image_vae.safetensors",
        hires: { enabled: false, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 },
      },
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    } as ImageGenSamplerSet;
    const restoreSets = listSamplerSetsApi.mockImplementation(async () => [grown]);
    const view = render(<ImageGenPane imageGen={makeImageGen({ applyBaseSamplerSet })} />);
    await waitFor(() => expect(view.getByTestId("image-gen-model-set-row")).toBeTruthy());
    await pickOption(view, "image-gen-model-set-trigger", "Anima");
    await waitFor(() => expect(applyBaseSamplerSet).toHaveBeenCalledTimes(1));
    expect(applyBaseSamplerSet.mock.calls[0]![1]).toEqual(grown.payload);
    restoreSets();
  });

  it("IF-7c: an A1111-vocabulary set on a COMFY target translates through the alias bridge before applying", async () => {
    const applyBaseSamplerSet = mock((_setId: string | null, _payload?: Record<string, unknown>) => {});
    const diffusion = {
      id: "set-diff",
      name: "Diffusion",
      sortOrder: 1,
      payload: { sampler: "Euler a", scheduler: "karras", steps: 25, cfgScale: 5, clipSkip: 2 },
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    } as ImageGenSamplerSet;
    const restoreSets = listSamplerSetsApi.mockImplementation(async () => [diffusion]);
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          applyBaseSamplerSet,
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI }),
          samplersByProfile: { ig1: [{ name: "euler" }, { name: "euler_ancestral" }] },
          schedulersByProfile: { ig1: [{ name: "karras" }, { name: "simple" }] },
        })}
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-model-set-row")).toBeTruthy());
    await pickOption(view, "image-gen-model-set-trigger", "Diffusion");
    await waitFor(() => expect(applyBaseSamplerSet).toHaveBeenCalledTimes(1));
    // «Euler a» (A1111 display name, the stock Diffusion row's vocabulary)
    // lands as the comfy combo id; numeric fields pass through untouched.
    expect(applyBaseSamplerSet.mock.calls[0]![1]).toEqual({
      sampler: "euler_ancestral",
      scheduler: "karras",
      steps: 25,
      cfgScale: 5,
      clipSkip: 2,
    });
    restoreSets();
  });

  it("IF-7c: a sampler missing from the target's live list is SKIPPED with a note — the rest applies, never silent garbage", async () => {
    const applyBaseSamplerSet = mock((_setId: string | null, _payload?: Record<string, unknown>) => {});
    const bogus = {
      id: "set-bogus",
      name: "Bogus",
      sortOrder: 1,
      payload: { sampler: "TotallyMissing", steps: 30 },
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    } as ImageGenSamplerSet;
    const restoreSets = listSamplerSetsApi.mockImplementation(async () => [bogus]);
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          applyBaseSamplerSet,
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI }),
          samplersByProfile: { ig1: [{ name: "euler" }] },
          schedulersByProfile: { ig1: [{ name: "simple" }] },
        })}
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-model-set-row")).toBeTruthy());
    await pickOption(view, "image-gen-model-set-trigger", "Bogus");
    await waitFor(() => expect(applyBaseSamplerSet).toHaveBeenCalledTimes(1));
    // The arm keeps its current sampler (field skipped), steps still apply.
    expect(applyBaseSamplerSet.mock.calls[0]![1]).toEqual({ steps: 30 });
    restoreSets();
  });

  it("IF-7c: a set vae on a DiT target (family-fixed sidecar) is stripped — the encoder never applies, the sampler still does", async () => {
    const applyBaseSamplerSet = mock((_setId: string | null, _payload?: Record<string, unknown>) => {});
    const anima = {
      id: "set-anima",
      name: "Anima",
      sortOrder: 1,
      payload: { sampler: "euler_sde", scheduler: "simple", steps: 30, cfgScale: 5, vae: "qwen_image_vae.safetensors" },
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    } as ImageGenSamplerSet;
    const restoreSets = listSamplerSetsApi.mockImplementation(async () => [anima]);
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          applyBaseSamplerSet,
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, modelId: "ray.safetensors" }),
          modelsByProfile: {
            ig1: [{ id: "ray.safetensors", label: "ray", family: "Krea 2", template: "krea2-dit" }],
          },
          samplersByProfile: { ig1: [{ name: "euler" }, { name: "euler_sde" }] },
          schedulersByProfile: { ig1: [{ name: "simple" }] },
        })}
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-model-set-row")).toBeTruthy());
    await pickOption(view, "image-gen-model-set-trigger", "Anima");
    await waitFor(() => expect(applyBaseSamplerSet).toHaveBeenCalledTimes(1));
    expect(applyBaseSamplerSet.mock.calls[0]![1]).toEqual({
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
    });
    restoreSets();
  });
});

describe("ImageGenPane — VAE field + hires section (IF-7b)", () => {
  it("a1111 unbound: the VAE dropdown lists the live vocabulary and a pick writes defaultParams.vae; the DiT twin never renders on a1111", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      form: makeForm({
        backend: IMAGE_GEN_BACKENDS.A1111,
        endpoint: "http://127.0.0.1:7860",
        capabilities: makeCaps({ supportsSamplers: true, sizeSupport: { kind: "free" } }),
      }),
      setForm,
      vaeByProfile: { ig1: ["sdxl_vae.safetensors", "vae-ft-mse.safetensors"] },
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    expect(view.getByTestId("image-gen-field-vae-swap")).toBeTruthy();
    // The DiT sidecar twin (vaeName) must NOT render for a1111.
    expect(view.queryByTestId("image-gen-field-vae")).toBeNull();

    await pickOption(view, "image-gen-field-vae-swap", "sdxl_vae.safetensors");
    const lastForm = (setForm.mock.calls[setForm.mock.calls.length - 1] as unknown[])[0] as {
      defaultParams: { vae?: string };
    };
    expect(lastForm.defaultParams.vae).toBe("sdxl_vae.safetensors");
  });

  it("a1111: the hires section renders OFF with no knobs (a configured block stays inert); an ENABLED block reveals the knob body; the toggle merges, never wipes", async () => {
    const setForm = mock(() => {});
    const localForm = (hires: { enabled: boolean; upscaler?: string; scale?: number; denoisingStrength?: number }) =>
      makeForm({
        backend: IMAGE_GEN_BACKENDS.A1111,
        endpoint: "http://127.0.0.1:7860",
        capabilities: makeCaps({ supportsSamplers: true, sizeSupport: { kind: "free" } }),
        defaultParams: { steps: 30, cfgScale: 5, sampler: "euler_sde", hires },
      });
    const imageGen = makeImageGen({
      // The stock Anima shape: configured but DISABLED.
      form: localForm({ enabled: false, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 }),
      setForm,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    const row = view.getByTestId("image-gen-hires-row");
    expect(row).toBeTruthy();
    // OFF: the knob body stays hidden — the configured block is inert until
    // the user opts in (the owner's «пусть пользователь включает»).
    expect(view.queryByTestId("image-gen-hires-body")).toBeNull();

    // The toggle write MERGES over the configured block (enabled flips,
    // knobs stay — never a wipe).
    const toggle = within(row).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    const lastForm = (setForm.mock.calls[setForm.mock.calls.length - 1] as unknown[])[0] as {
      defaultParams: { hires?: { enabled: boolean; upscaler?: string; scale?: number; denoisingStrength?: number } };
    };
    expect(lastForm.defaultParams.hires).toEqual({
      enabled: true,
      upscaler: "R-ESRGAN 4x+ Anime6B",
      scale: 1.5,
      denoisingStrength: 0.35,
    });
    view.unmount();

    // An ENABLED block (the state the toggle write produces) reveals the
    // knob body — the seeded-state reveal twin of the ADetailer pattern.
    const view2 = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: localForm({ enabled: true, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 }),
          setForm,
        })}
      />,
    );
    await openAdvanced(view2);
    const body = view2.getByTestId("image-gen-hires-body");
    expect(body).toBeTruthy();
    expect(view2.getByTestId("image-gen-hires-upscaler")).toBeTruthy();
    // The knob sliders anchor at the block's own values (the chip's own
    // change-event idiom — the range input IS the testid element).
    expect((view2.getByTestId("image-gen-hires-scale") as HTMLInputElement).value).toBe("1.5");
  });

  it("cloud backend: neither the VAE field nor the hires section renders (dialect gates)", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await openAdvanced(view);
    expect(view.queryByTestId("image-gen-field-vae-swap")).toBeNull();
    expect(view.queryByTestId("image-gen-hires-row")).toBeNull();
  });
});

describe("ImageGenPane — ADetailer row (CF15d, the chip's twin surface)", () => {
  it("bound a1111 profile with the extension: the row lives in the advanced body; the toggle writes the overlay", async () => {
    extensionsValue = ["adetailer", "sd-webui-controlnet"];
    const setModelOverlay = mock((_patch: Partial<import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue>) => {});
    const imageGen = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha" }),
      modelOverlay: {},
      setModelOverlay,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    const row = view.getByTestId("image-gen-adetailer-row");
    expect(row).toBeTruthy();
    // No dropdown while OFF — the preset only exists when enabled.
    expect(view.queryByTestId("image-gen-adetailer-model")).toBeNull();

    const toggle = within(row).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setModelOverlay.mock.calls[0]?.[0]).toEqual({ adetailer: true });
  });

  it("enabled overlay reveals the face-model dropdown; a pick writes the overlay", async () => {
    extensionsValue = ["adetailer"];
    const setModelOverlay = mock((_patch: Partial<import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue>) => {});
    const imageGen = makeImageGen({
      form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha" }),
      modelOverlay: { adetailer: true },
      setModelOverlay,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    await pickOption(view, "image-gen-adetailer-model", "face_yolov8s.pt");
    expect((setModelOverlay.mock.calls.at(-1) as unknown[])[0]).toEqual({ adetailerModel: "face_yolov8s.pt" });
  });

  it("hidden when the server lacks the extension (a1111, bound)", async () => {
    extensionsValue = ["sd-webui-controlnet"];
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha" }),
          modelOverlay: {},
        })}
      />,
    );
    await openAdvanced(view);
    expect(view.queryByTestId("image-gen-adetailer-row")).toBeNull();
  });

  it("renders UNBOUND too (2026-09-27: the bind toggle routes writes, it never hides controls) and writes the profile base", async () => {
    extensionsValue = ["adetailer"];
    const setForm = mock((patch: Partial<NonNullable<ImageGenHook["form"]>>) => {});
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha" }),
          modelOverlay: null,
          setForm,
        })}
      />,
    );
    await openAdvanced(view);
    const row = view.getByTestId("image-gen-adetailer-row");
    expect(row).toBeTruthy();
    const toggle = within(row).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    // The unbound arm writes defaultParams — NOT the per-model overlay.
    const last = setForm.mock.calls.at(-1)?.[0] as { defaultParams?: { adetailer?: boolean } };
    expect(last?.defaultParams?.adetailer).toBe(true);
  });

  it("hidden on cloud backends — no extension surface at all", async () => {
    extensionsValue = ["adetailer"]; // even if the mock would answer
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ modelId: "m-alpha" }), modelOverlay: {} })} />,
    );
    await openAdvanced(view);
    expect(view.queryByTestId("image-gen-adetailer-row")).toBeNull();
  });

  it("comfy + discovered chain (IF-6): the row lights up, the picker serves the LIVE detectors, and the extensions probe is never called", async () => {
    faceDetectorsValue = ["bbox/face_yolov8m.pt", "bbox/face_yolov8n.pt"];
    const setModelOverlay = mock((_patch: Partial<import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue>) => {});
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, modelId: "m-alpha", endpoint: "http://127.0.0.1:8188" }),
          modelOverlay: {},
          setModelOverlay,
        })}
      />,
    );
    await openAdvanced(view);
    const row = await waitFor(() => {
      const el = view.getByTestId("image-gen-adetailer-row");
      expect(el).toBeTruthy();
      return el;
    });
    expect(view.queryByTestId("image-gen-adetailer-missing")).toBeNull();
    expect(faceDetectorCalls).toEqual(["ig1"]);

    const toggle = within(row).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setModelOverlay.mock.calls[0]?.[0]).toEqual({ adetailer: true });

    // The face-model picker reveal (the a1111 twin's shape): a fresh view
    // with the overlay already enabled serves the DISCOVERED chain — a
    // live-only entry is pickable (the static presets would not carry it).
    // Unmount the first pane first: two live panes break testid queries.
    await act(async () => {
      view.unmount();
    });
    const enabled = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, modelId: "m-alpha", endpoint: "http://127.0.0.1:8188" }),
          modelOverlay: { adetailer: true },
          setModelOverlay,
        })}
      />,
    );
    await openAdvanced(enabled);
    await pickOption(enabled, "image-gen-adetailer-model", "bbox/face_yolov8n.pt");
    expect((setModelOverlay.mock.calls.at(-1) as unknown[])[0]).toEqual({ adetailerModel: "bbox/face_yolov8n.pt" });
  });

  it("comfy + ANSWERED empty chain (IF-6): the row renders disabled with the Impact Pack hint — honest-unavailable, not hidden", async () => {
    faceDetectorsValue = [];
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, modelId: "m-alpha", endpoint: "http://127.0.0.1:8188" }),
          modelOverlay: {},
        })}
      />,
    );
    await openAdvanced(view);
    const row = await waitFor(() => {
      const el = view.getByTestId("image-gen-adetailer-row");
      expect(el).toBeTruthy();
      return el;
    });
    expect(view.getByTestId("image-gen-adetailer-missing").textContent).toContain("image_gen_adetailer_missing_hint");
    // Honest-unavailable: the toggle RENDERS but is disabled — the row
    // stays discoverable, the hint explains why.
    const disabledToggle = within(row).getByRole("switch");
    expect(disabledToggle.getAttribute("disabled")).not.toBeNull();
  });

  it("comfy + FAILED probe (IF-6): the row hides entirely — the failed-extensions-probe precedent", async () => {
    // The mock answers a value; the pane path under test is the catch
    // branch, so reject through a one-shot override of the same seam.
    faceDetectorsValue = ["bbox/face_yolov8m.pt"];
    listFaceDetectorsApi.mockImplementationOnce(() => Promise.reject(new Error("probe boom")));
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, modelId: "m-alpha", endpoint: "http://127.0.0.1:8188" }),
          modelOverlay: {},
        })}
      />,
    );
    await openAdvanced(view);
    // Give the rejected probe a tick to settle before the absence pin.
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByTestId("image-gen-adetailer-row")).toBeNull();
    expect(view.queryByTestId("image-gen-adetailer-missing")).toBeNull();
  });
});

describe("ImageGenPane — overlay round-trip via the API seam (plan self-check)", () => {
  function Harness({ hookRef }: { hookRef: { current: ImageGenHook | null } }) {
    const hook = useImageProfiles();
    hookRef.current = hook;
    return <ImageGenPane imageGen={hook} />;
  }

  it("bind → edit → save PUTs the overlay after the profile PATCH; reload restores the bound state", async () => {
    apiStore = [
      makeRecord({
        id: "p1",
        name: "Forge local",
        backend: IMAGE_GEN_BACKENDS.A1111,
        presetId: undefined,
        endpoint: "http://127.0.0.1:7860",
        modelId: "sd_xl",
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          supportsSteps: true,
          supportsCfgScale: true,
          sizeSupport: { kind: "free" },
          noApiKey: true,
          supportsLiveProgress: true,
          localExecution: true,
        }),
      }),
    ];
    const hookRef: { current: ImageGenHook | null } = { current: null };
    const view = render(<Harness hookRef={hookRef} />);
    // The hook loads the profile list on mount; select() is a lookup over
    // that list — wait for the load before selecting (the hook-test
    // harness rule).
    await waitFor(() => expect(hookRef.current!.profiles.length).toBe(1));
    const hook = hookRef.current!;
    await act(async () => {
      hook.select("p1");
    });
    await waitFor(() => expect(view.getByTestId("image-gen-pane")).toBeTruthy());

    // 1 — bind ON: the stored overlay is fetched (none yet) and the editor
    //     opens empty-but-bound.
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "image_gen_bind_per_model" }));
    });
    await waitFor(() => expect(getSettingsApi).toHaveBeenCalled());
    await waitFor(() => expect(hookRef.current!.modelOverlay).toEqual({}));

    // 2 — an overlay edit (advanced steps) marks the overlay dirty.
    await act(async () => {
      fireEvent.click(view.getByText("image_gen_advanced"));
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    const cellInput = view.getByTestId("image-gen-field-steps").querySelector("input")!;
    await act(async () => {
      fireEvent.change(cellInput, { target: { value: "30" } });
    });
    await act(async () => {
      fireEvent.blur(cellInput);
    });
    await waitFor(() => expect(hookRef.current!.overlayDirty).toBe(true));

    // 3 — save: the profile PATCH goes first, then the overlay PUT with the
    //     right (profileId, modelId, overlay) triple.
    await act(async () => {
      await hookRef.current!.save();
    });
    await waitFor(() => expect(upsertSettingsApi).toHaveBeenCalledTimes(1));
    expect((upsertSettingsApi.mock.calls[0] as unknown[])[0]).toBe("p1");
    expect((upsertSettingsApi.mock.calls[0] as unknown[])[1]).toBe("sd_xl");
    expect((upsertSettingsApi.mock.calls[0] as unknown[])[2]).toEqual({ steps: 30 });
    expect(updateProfileApi).toHaveBeenCalledTimes(1);
    expect(hookRef.current!.error).toBeNull();

    // 4 — reload: a fresh session re-selects the profile; the stored overlay
    //     resurfaces as the BOUND state with its values (persisted).
    cleanup();
    const view2 = render(<Harness hookRef={hookRef} />);
    await waitFor(() => expect(hookRef.current!.profiles.length).toBe(1));
    await act(async () => {
      hookRef.current!.select("p1");
    });
    await waitFor(() => expect(view2.getByRole("switch", { name: "image_gen_bind_per_model" }).getAttribute("aria-checked")).toBe("true"));
    await act(async () => {
      fireEvent.click(view2.getByText("image_gen_advanced"));
    });
    await waitFor(() =>
      expect((view2.getByTestId("image-gen-field-steps").querySelector("input") as HTMLInputElement).value).toBe("30"),
    );
  });

  it("unbind immediately DELETEs the stored overlay (the revert is the destructive action)", async () => {
    settingsRow = {
      id: "ms1",
      profileId: "p1",
      modelId: "sd_xl",
      settings: { steps: 30 },
      samplerSetId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    apiStore = [
      makeRecord({
        id: "p1",
        backend: IMAGE_GEN_BACKENDS.A1111,
        modelId: "sd_xl",
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          sizeSupport: { kind: "free" },
          noApiKey: true,
          supportsLiveProgress: true,
        localExecution: true,
        }),
      }),
    ];
    const hookRef: { current: ImageGenHook | null } = { current: null };
    const view = render(<Harness hookRef={hookRef} />);
    await waitFor(() => expect(hookRef.current!.profiles.length).toBe(1));
    await act(async () => {
      hookRef.current!.select("p1");
    });
    await waitFor(() =>
      expect(view.getByRole("switch", { name: "image_gen_bind_per_model" }).getAttribute("aria-checked")).toBe("true"),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "image_gen_bind_per_model" }));
    });
    await waitFor(() => expect(deleteSettingsApi).toHaveBeenCalledTimes(1));
    expect((deleteSettingsApi.mock.calls[0] as unknown[])[0]).toBe("p1");
    expect((deleteSettingsApi.mock.calls[0] as unknown[])[1]).toBe("sd_xl");
    await waitFor(() =>
      expect(view.getByRole("switch", { name: "image_gen_bind_per_model" }).getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("stars ride the API seam: star POSTs (modelId + cached label), unstar DELETEs", async () => {
    apiStore = [
      makeRecord({
        id: "p1",
        backend: IMAGE_GEN_BACKENDS.A1111,
        modelId: "sd_xl",
        capabilities: makeCaps({
          supportsNegativePrompt: true,
          supportsSamplers: true,
          supportsSeed: true,
          sizeSupport: { kind: "free" },
          noApiKey: true,
          supportsLiveProgress: true,
        localExecution: true,
        }),
      }),
    ];
    const hookRef: { current: ImageGenHook | null } = { current: null };
    const view = render(<Harness hookRef={hookRef} />);
    await waitFor(() => expect(hookRef.current!.profiles.length).toBe(1));
    await act(async () => {
      hookRef.current!.select("p1");
    });
    // CF3: the star is the IN-ROW toggle inside the opened dropdown — open
    // the picker and click the synthesized selected-id row's star.
    await waitFor(() => expect(view.getByTestId("image-gen-field-model")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-field-model").click();
    });
    const starButton = await waitFor(() => {
      const rows = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']"));
      const row = rows.find((n) => n.textContent?.includes("sd_xl"));
      const star = row?.querySelector('[data-testid="image-gen-model-star"]');
      expect(star).toBeTruthy();
      return star as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(starButton);
    });
    await waitFor(() => expect(addFavoriteApi).toHaveBeenCalledTimes(1));
    expect((addFavoriteApi.mock.calls[0] as unknown[])[0]).toBe("p1");
    // The synthesized selected-id row carries label = id (the picker's own
    // convention for non-catalog models) — the POST rides it along.
    expect((addFavoriteApi.mock.calls[0] as unknown[])[1]).toEqual({ modelId: "sd_xl", label: "sd_xl" });
    // After the POST the favorites list reloads and the SAME in-row star
    // routes the DELETE-shaped call (the star icon flips, the row stays).
    const starredStar = await waitFor(() => {
      const rows = Array.from(document.body.querySelectorAll("[data-testid='image-gen-model-option']"));
      const row = rows.find((n) => n.textContent?.includes("sd_xl"));
      const star = row?.querySelector('[data-testid="image-gen-model-star"]');
      expect(star).toBeTruthy();
      return star as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(starredStar);
    });
    await waitFor(() => expect(removeFavoriteApi).toHaveBeenCalledTimes(1));
    expect((removeFavoriteApi.mock.calls[0] as unknown[])).toEqual(["p1", "sd_xl"]);
  });
});

describe("ImageGenPane — LLM assist (IG-15)", () => {
  function Harness({ hookRef }: { hookRef: { current: ImageGenHook | null } }) {
    const hook = useImageProfiles();
    hookRef.current = hook;
    return <ImageGenPane imageGen={hook} />;
  }

  it("disabled by default: the section renders, no pickers, no provider fetch", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-assist-section")).toBeTruthy());
    expect(view.getByRole("switch", { name: "image_gen_assist_title" }).getAttribute("aria-checked")).toBe("false");
    expect(view.queryByTestId("image-gen-assist-provider")).toBeNull();
    expect(view.queryByTestId("image-gen-assist-model")).toBeNull();
    expect(listLlmProfilesApi).not.toHaveBeenCalled();
  });

  it("toggling on patches the form with llmAssistEnabled", async () => {
    const setForm = mock(() => {});
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
    await waitFor(() => expect(view.getByTestId("image-gen-assist-section")).toBeTruthy());
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "image_gen_assist_title" }));
    });
    expect(setForm).toHaveBeenCalledWith({ llmAssistEnabled: true });
  });

  it("enabled: picking a provider RESETS the model pick (a model from another provider is meaningless)", async () => {
    listLlmProfilesApi.mockResolvedValue([
      { id: "llm-p1", name: "Writer", defaultModel: "w-default" },
      { id: "llm-p2", name: "Poet", defaultModel: null },
    ]);
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ llmAssistEnabled: true }), setForm })} />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-assist-provider")).toBeTruthy());
    await waitFor(() => expect(listLlmProfilesApi).toHaveBeenCalled());
    await pickOption(view, "image-gen-assist-provider", "Writer");
    expect(setForm).toHaveBeenCalledWith({ llmProviderProfileId: "llm-p1", llmModelId: null });
  });

  it("enabled with a provider picked: its model catalog loads and a pick patches llmModelId", async () => {
    listLlmProfilesApi.mockResolvedValue([{ id: "llm-p1", name: "Writer", defaultModel: "w-default" }]);
    fetchLlmModelsApi.mockResolvedValue({ models: [{ id: "w-default", label: "Writer Default" }, { id: "w-2", label: "Writer Two" }] });
    const setForm = mock(() => {});
    const view = render(
      <ImageGenPane
        imageGen={
          makeImageGen({
            form: makeForm({ llmAssistEnabled: true, llmProviderProfileId: "llm-p1" }),
            setForm,
          })
        }
      />,
    );
    await waitFor(() => expect(view.getByTestId("image-gen-assist-model")).toBeTruthy());
    await waitFor(() => expect(fetchLlmModelsApi).toHaveBeenCalledWith("llm-p1"));
    await pickOption(view, "image-gen-assist-model", "Writer Two");
    expect(setForm).toHaveBeenCalledWith({ llmModelId: "w-2" });
  });

  it("round-trip (real hook): toggle + picks ride the profile PATCH on Save", async () => {
    apiStore = [makeRecord({ id: "p1" })];
    listLlmProfilesApi.mockResolvedValue([{ id: "llm-p1", name: "Writer", defaultModel: null }]);
    fetchLlmModelsApi.mockResolvedValue({ models: [{ id: "w-2", label: "Writer Two" }] });
    const hookRef: { current: ImageGenHook | null } = { current: null };
    const view = render(<Harness hookRef={hookRef} />);
    await waitFor(() => expect(hookRef.current!.profiles.length).toBe(1));
    await act(async () => {
      hookRef.current!.select("p1");
    });
    await waitFor(() => expect(view.getByTestId("image-gen-pane")).toBeTruthy());

    // Toggle on, pick the provider (form state — the REAL hook now), then a model.
    await act(async () => {
      fireEvent.click(view.getByRole("switch", { name: "image_gen_assist_title" }));
    });
    await waitFor(() => expect(listLlmProfilesApi).toHaveBeenCalled());
    await pickOption(view, "image-gen-assist-provider", "Writer");
    await waitFor(() => expect(view.getByTestId("image-gen-assist-provider").textContent).toContain("Writer"));
    await waitFor(() => expect(fetchLlmModelsApi).toHaveBeenCalledWith("llm-p1"));
    await pickOption(view, "image-gen-assist-model", "Writer Two");

    await act(async () => {
      await hookRef.current!.save();
    });
    expect(updateProfileApi).toHaveBeenCalledTimes(1);
    const patch = (updateProfileApi.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(patch.llmAssistEnabled).toBe(true);
    expect(patch.llmProviderProfileId).toBe("llm-p1");
    expect(patch.llmModelId).toBe("w-2");
    expect(hookRef.current!.error).toBeNull();
  });
});

describe("ImageGenPane — prompt family row (IPT-5)", () => {
  function familyHook(record: ImageGenRecord, modelId: string | null = record.modelId ?? null): ImageGenHook {
    return makeImageGen({
      profiles: [record],
      form: makeForm({ id: record.id, modelId }),
    });
  }

  function familyNode(imageGen: ImageGenHook) {
    return (
      <TooltipProvider delayDuration={200}>
        <ImageGenPane imageGen={imageGen} />
      </TooltipProvider>
    );
  }

  function FamilyReloadHarness({ record, onReload }: { record: ImageGenRecord; onReload: () => Promise<void> }) {
    const [profiles, setProfiles] = React.useState<ImageGenRecord[]>([record]);
    const imageGen = familyHook(profiles[0]!);
    imageGen.reload = async () => {
      await onReload();
      setProfiles([...apiStore]);
    };
    return <ImageGenPane imageGen={imageGen} />;
  }

  function FamilyIdentityHarness({
    controller,
    record,
  }: {
    controller: { setTarget: ((nextRecord: ImageGenRecord, nextModel: string) => void) | null };
    record: ImageGenRecord;
  }) {
    const [target, setTarget] = React.useState({ record, model: record.modelId ?? "" });
    controller.setTarget = (nextRecord, nextModel) => setTarget({ record: nextRecord, model: nextModel });
    return <ImageGenPane imageGen={familyHook(target.record, target.model)} />;
  }

  it("renders directly under ModelPicker for persisted cloud and local profiles; create mode remains outside this pane", async () => {
    const cloud = makeRecord({ modelId: "cloud-model" });
    const cloudView = render(<ImageGenPane imageGen={familyHook(cloud)} />);
    await waitFor(() => expect(cloudView.getByTestId("image-gen-family-row")).toBeTruthy());
    const cloudModel = cloudView.getByTestId("image-gen-field-model");
    const cloudRow = cloudView.getByTestId("image-gen-family-row");
    expect(cloudModel.compareDocumentPosition(cloudRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    cleanup();

    const local = makeRecord({
      backend: "a1111",
      presetId: "a1111",
      endpoint: "http://127.0.0.1:7860",
      modelId: "local-model",
      capabilities: makeCaps({ supportsSamplers: true, sizeSupport: { kind: "free" } }),
    });
    const localView = render(
      <ImageGenPane
        imageGen={familyHook(local, "local-model")}
      />,
    );
    await waitFor(() => expect(localView.getByTestId("image-gen-family-row")).toBeTruthy());
    expect(localView.getByTestId("image-gen-field-model").compareDocumentPosition(localView.getByTestId("image-gen-family-row"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    cleanup();
    const createView = render(<ImageGenPane imageGen={makeImageGen({ form: makeForm({ id: null }) })} />);
    expect(createView.queryByTestId("image-gen-family-row")).toBeNull();
  });

  it("lists server registry families and persists an exact manual pin and automatic clear", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    const reload = mock(async () => {});
    const imageGen = familyHook(record);
    imageGen.reload = reload;
    const view = render(familyNode(imageGen));
    await waitFor(() => expect(listFamiliesApi).toHaveBeenCalledTimes(1));

    await pickOptionContaining(view, "image-gen-family-select", "imagePromptTemplates.family.pony");
    await waitFor(() => expect(setFamilyApi).toHaveBeenCalledTimes(1));
    expect((setFamilyApi.mock.calls[0] as unknown[])).toEqual(["ig1", "pony"]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(apiStore[0]?.familyOverride).toBe("pony");

    view.rerender(familyNode(familyHook(apiStore[0]!)));
    await pickOption(view, "image-gen-family-select", "image_gen_family_automatic");
    await waitFor(() => expect(setFamilyApi).toHaveBeenCalledTimes(2));
    expect((setFamilyApi.mock.calls[1] as unknown[])).toEqual(["ig1", null]);
    expect(apiStore[0]?.familyOverride).toBeUndefined();
  });

  it("refreshes successful detection for the matching saved model and shows the exact response source", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    detectOutcome = { ok: true, family: "illustrious", sourceLabel: "sidecar" };
    const reload = mock(async () => {});
    const view = render(<FamilyReloadHarness record={record} onReload={reload} />);
    await waitFor(() => expect(view.getByTestId("image-gen-family-detect")).toBeTruthy());
    // The blocked hint is a save-first state — a SAVED model never shows it.
    expect(view.queryByTestId("image-gen-family-detect-blocked-hint")).toBeNull();

    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    await waitFor(() => expect(apiStore[0]?.familyDetected).toBe("illustrious"));
    expect(apiStore[0]?.familyDetectedForModel).toBe("checkpoint-a");
    expect(reload).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(view.getByTestId("image-gen-family-detected").textContent).toContain("imagePromptTemplates.family.illustrious"));
    expect(view.getByTestId("image-gen-family-status").textContent).toContain(
      "image_gen_family_source_note:image_gen_family_source_sidecar",
    );
  });

  it("hides a response-only source while a manual pin is authoritative", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    detectOutcome = { ok: true, family: "illustrious", sourceLabel: "sidecar" };
    const view = render(<FamilyReloadHarness record={record} onReload={async () => {}} />);
    await waitFor(() => expect(view.getByTestId("image-gen-family-detect")).toBeTruthy());

    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    await waitFor(() =>
      expect(view.getByTestId("image-gen-family-status").textContent).toContain(
        "image_gen_family_source_note:image_gen_family_source_sidecar",
      ),
    );

    await pickOptionContaining(view, "image-gen-family-select", "imagePromptTemplates.family.pony");
    await waitFor(() => expect(apiStore[0]?.familyOverride).toBe("pony"));
    expect(view.getByTestId("image-gen-family-status").textContent).toContain("image_gen_family_manual_note");
    expect(view.getByTestId("image-gen-family-status").textContent).not.toContain("image_gen_family_source_note");

    await pickOption(view, "image-gen-family-select", "image_gen_family_automatic");
    await waitFor(() => expect(apiStore[0]?.familyOverride).toBeUndefined());
    expect(view.getByTestId("image-gen-family-status").textContent).toContain(
      "image_gen_family_source_note:image_gen_family_source_sidecar",
    );
  });

  it("keeps saved family state on failed detection and renders the error plus every ordered attempt", async () => {
    const record = makeRecord({
      modelId: "checkpoint-a",
      familyDetected: "pony",
      familyDetectedForModel: "checkpoint-a",
      familySource: "auto",
    });
    apiStore = [record];
    detectOutcome = {
      ok: false,
      error: "No authoritative metadata answered.",
      tried: [
        { source: "backend-metadata", reason: "Model API did not include metadata." },
        { source: "sidecar", reason: "No sidecar was found." },
        { source: "civitai-by-hash", reason: "No model hash was available." },
      ],
    };
    const view = render(familyNode(familyHook(record)));
    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    const error = await waitFor(() => view.getByTestId("image-gen-family-error"));
    expect(error.textContent).toContain("No authoritative metadata answered.");
    const tried = Array.from(error.querySelectorAll("[data-testid='image-gen-family-tried-item']"));
    expect(tried.map((item) => item.textContent)).toEqual([
      "image_gen_family_source_backend-metadata: Model API did not include metadata.",
      "image_gen_family_source_sidecar: No sidecar was found.",
      "image_gen_family_source_civitai-by-hash: No model hash was available.",
    ]);
    expect(apiStore[0]?.familyDetected).toBe("pony");
    expect(view.getByTestId("image-gen-family-detected")).toBeTruthy();
  });

  it("marks an automatic detection stale after a draft model edit while a manual pin stays authoritative", async () => {
    const automatic = makeRecord({
      modelId: "checkpoint-a",
      familyDetected: "pony",
      familyDetectedForModel: "checkpoint-a",
      familySource: "auto",
    });
    const staleView = render(familyNode(familyHook(automatic, "checkpoint-b")));
    await waitFor(() => expect(staleView.getByTestId("image-gen-family-stale")).toBeTruthy());
    expect(staleView.getByTestId("image-gen-family-stale").textContent).toContain("checkpoint-a");
    cleanup();

    const pinned = makeRecord({
      modelId: "checkpoint-a",
      familyOverride: "pony",
      familyDetected: "illustrious",
      familyDetectedForModel: "checkpoint-a",
      familySource: "manual",
    });
    const pinnedView = render(familyNode(familyHook(pinned, "checkpoint-b")));
    await waitFor(() => expect(pinnedView.getByTestId("image-gen-family-status").textContent).toContain("image_gen_family_manual_note"));
    expect(pinnedView.queryByTestId("image-gen-family-stale")).toBeNull();
  });

  it("detects the DISPLAYED model without a save round-trip; only an absent model blocks (IF-8a, owner correction 2026-09-25)", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    const draftView = render(familyNode(familyHook(record, "checkpoint-b")));
    await waitFor(() => expect(draftView.getByTestId("image-gen-family-detect")).toBeTruthy());
    // No disabled twin, no blocked hint — a freshly picked unsaved model is
    // detectable on the spot (the save-first gate is gone).
    expect(draftView.queryByTestId("image-gen-family-detect-disabled")).toBeNull();
    expect(draftView.queryByTestId("image-gen-family-detect-blocked-hint")).toBeNull();
    await act(async () => {
      draftView.getByTestId("image-gen-family-detect").click();
    });
    await waitFor(() => expect(detectFamilyApi).toHaveBeenCalledTimes(1));
    // The DISPLAYED model rides the request (the third arg) — the server
    // anchors the detection to exactly that model.
    expect((detectFamilyApi.mock.calls[0] as unknown[])[0]).toBe("ig1");
    expect((detectFamilyApi.mock.calls[0] as unknown[])[2]).toBe("checkpoint-b");
    // The default no-answer outcome renders the honest in-row failure box.
    await waitFor(() => expect(draftView.getByTestId("image-gen-family-error")).toBeTruthy());
    cleanup();

    const absentView = render(familyNode(familyHook(record, null)));
    await waitFor(() => expect(absentView.getByTestId("image-gen-family-detect-disabled")).toBeTruthy());
    expect(absentView.queryByTestId("image-gen-family-detect")).toBeNull();
    expect(absentView.getByTestId("image-gen-family-detect-blocked-hint").textContent).toContain(
      "image_gen_family_detect_pick_model_first",
    );
    const absentDetect = absentView.getByTestId("image-gen-family-detect-disabled");
    await act(async () => {
      fireEvent.pointerMove(absentDetect, { pointerType: "mouse" });
    });
    await waitFor(() => expect(document.body.textContent).toContain("image_gen_family_detect_pick_model_first"));
  });

  it("does not let an older profile or model detection response clobber the current row", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    let resolveDetect: ((result: FamilyDetectResult) => void) | null = null;
    pendingDetect = new Promise<FamilyDetectResult>((resolve) => {
      resolveDetect = resolve;
    });
    const controller: { setTarget: ((nextRecord: ImageGenRecord, nextModel: string) => void) | null } = { setTarget: null };
    const view = render(<FamilyIdentityHarness controller={controller} record={record} />);
    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    await waitFor(() => expect(detectFamilyApi).toHaveBeenCalledTimes(1));

    const changedProfile = makeRecord({ id: "ig2", modelId: "checkpoint-b" });
    await act(async () => {
      controller.setTarget!(changedProfile, "checkpoint-b");
    });
    await act(async () => {
      resolveDetect!({ ok: true, family: "pony", sourceLabel: "sidecar" });
    });
    await act(async () => {});
    expect(view.queryByTestId("image-gen-family-detected")).toBeNull();
    expect(view.getByTestId("image-gen-family-status").textContent).toContain("image_gen_family_not_detected");
    expect(view.getByTestId("image-gen-family-status").textContent).not.toContain("image_gen_family_source_note");
  });

  it("rejects an A to B to A detection response after the target changes", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    let resolveDetect: ((result: FamilyDetectResult) => void) | null = null;
    pendingDetect = new Promise<FamilyDetectResult>((resolve) => {
      resolveDetect = resolve;
    });
    const controller: { setTarget: ((nextRecord: ImageGenRecord, nextModel: string) => void) | null } = { setTarget: null };
    const view = render(<FamilyIdentityHarness controller={controller} record={record} />);
    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    await waitFor(() => expect(detectFamilyApi).toHaveBeenCalledTimes(1));

    await act(async () => {
      controller.setTarget!(record, "checkpoint-b");
    });
    await act(async () => {
      controller.setTarget!(record, "checkpoint-a");
    });
    await act(async () => {
      resolveDetect!({ ok: true, family: "pony", sourceLabel: "sidecar" });
    });
    await act(async () => {});

    expect(view.queryByTestId("image-gen-family-detected")).toBeNull();
    expect(view.getByTestId("image-gen-family-status").textContent).toContain("image_gen_family_not_detected");
    expect(view.getByTestId("image-gen-family-status").textContent).not.toContain("image_gen_family_source_note");
  });

  it("disables auto-detection while a manual family write is pending", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    let resolveWrite: (() => void) | null = null;
    pendingFamilyWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const view = render(familyNode(familyHook(record)));
    await waitFor(() => expect(listFamiliesApi).toHaveBeenCalledTimes(1));

    await pickOptionContaining(view, "image-gen-family-select", "imagePromptTemplates.family.pony");
    await waitFor(() => expect(setFamilyApi).toHaveBeenCalledTimes(1));
    const detect = view.getByTestId("image-gen-family-detect") as HTMLButtonElement;
    expect(detect.disabled).toBe(true);
    await act(async () => {
      detect.click();
    });
    expect(detectFamilyApi).not.toHaveBeenCalled();

    await act(async () => {
      resolveWrite!();
    });
    await waitFor(() => expect(detect.disabled).toBe(false));
  });

  it("keeps authored status and failure copy wrapping without truncation classes", async () => {
    const record = makeRecord({ modelId: "checkpoint-a" });
    apiStore = [record];
    detectOutcome = {
      ok: false,
      error: "A deliberately long authoritative failure reason must remain readable in full on narrow layouts.",
      tried: [{ source: "extension-preset", reason: "The extension returned a deliberately long diagnostic reason." }],
    };
    const view = render(familyNode(familyHook(record)));
    await act(async () => {
      view.getByTestId("image-gen-family-detect").click();
    });
    const error = await waitFor(() => view.getByTestId("image-gen-family-error"));
    const status = view.getByTestId("image-gen-family-status");
    expect(error.className).toContain("leading-[1.5]");
    expect(error.innerHTML).toContain("break-words");
    expect(error.innerHTML).not.toContain("text-ellipsis");
    expect(error.innerHTML).not.toContain("whitespace-nowrap");
    expect(error.innerHTML).not.toContain("overflow-hidden");
    expect(status.innerHTML).not.toContain("text-ellipsis");
    expect(status.innerHTML).not.toContain("whitespace-nowrap");
    expect(status.innerHTML).not.toContain("overflow-hidden");
  });
});
