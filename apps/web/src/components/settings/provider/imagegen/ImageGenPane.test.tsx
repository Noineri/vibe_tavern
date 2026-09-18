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
let extensionsValue: string[] = [];
const listExtensionsApi = mock(async (): Promise<string[]> => [...extensionsValue]);

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
  listImageGenExtensions: listExtensionsApi,
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
    modeSizePresets: {},
    userSizes: [],
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
    samplerStatusByProfile: {},
    startEdit: mock(() => {}),
    startCreate: mock(() => {}),
    select: mock(() => {}),
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    fetchSavedModels: mock(async () => null),
    fetchSamplers: mock(async () => null),
    fetchSchedulers: mock(async () => null),
    fetchSidecars: mock(async () => null),
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
  ]) {
    m.mockClear();
  }
  extensionsValue = [];
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

  it("advanced expand reveals steps/cfg/seed/clip-skip; seed stays EMPTY, sliders show anchors — nothing is a committed default (IG-CF13)", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    expect(view.queryByTestId("image-gen-advanced-body")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByText("image_gen_advanced"));
    });
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-body")).toBeTruthy());
    // Seed keeps its empty-able plain numeric cell (CF13 ruling: seed stays
    // a plain optional field). The three slider cells show their anchors
    // (range min) — the no-code-defaults rule now lives in "anchors commit
    // nothing", pinned in the IG-CF5 block.
    expect((view.getByTestId("image-gen-field-seed") as HTMLInputElement).value).toBe("");
    for (const fieldId of ["image-gen-field-steps", "image-gen-field-cfg", "image-gen-field-clip-skip"]) {
      expect(view.getByTestId(fieldId).querySelector("input")).toBeTruthy();
    }
    // IG-CF5 (named reason for the count change below): steps/CFG/CLIP-skip
    // are slider+number pairs now — each adds ONE range input beside its
    // number box (3 ranges + 4 numbers = 7). Seed stays a lone numeric with
    // no range (asserted in the IG-CF5 block).
    // The pane's param surface is EXACTLY these fields (+ the gated
    // sampler above): the negative prompt is NOT a pane field — the
    // IG-13/IG-17 surfaces own it (plan line 80/88), so nothing may sprout
    // here.
    expect(view.getByTestId("image-gen-advanced-body").querySelectorAll("input").length).toBe(7);
  });

  it("bind OFF: numeric edits route to the PROFILE BASE (setForm defaultParams), overlay untouched", async () => {
    const setForm = mock(() => {});
    const setModelOverlay = mock(() => {});
    const imageGen = makeImageGen({ form: makeForm({ modelId: "m-alpha" }), setForm, setModelOverlay });
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
      form: makeForm({ modelId: "m-alpha" }),
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
      form: makeForm({ modelId: "m-alpha" }),
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
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
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
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
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
      form: makeForm({ modelId: "m-alpha", defaultParams: { steps: IMAGE_GEN_PARAM_RANGES.steps.max } }),
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
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
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
    const imageGen = makeImageGen({ form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111 }) });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    // All three slider pairs exist; the steps triple is pinned attribute by
    // attribute against the domain constants (assert, never re-literalize).
    expect(view.getByTestId("image-gen-range-cfg")).toBeTruthy();
    expect(view.getByTestId("image-gen-range-clip-skip")).toBeTruthy();
    const range = view.getByTestId("image-gen-range-steps");
    expect(range.getAttribute("min")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.min));
    expect(range.getAttribute("max")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.max));
    expect(range.getAttribute("step")).toBe(String(IMAGE_GEN_PARAM_RANGES.steps.step));
  });

  it("IG-CF13: undefined params render the range-min anchor (SamplerField `value ?? min` — no empty box); nothing commits on open", async () => {
    const setForm = mock(() => {});
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
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
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
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

  it("unbound: the header renders title-only — no set row, no set actions", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    expect(view.queryByTestId("image-gen-model-set-row")).toBeNull();
    expect(view.queryByTestId("image-gen-set-new")).toBeNull();
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

  it("hidden when unbound (no overlay row) — even with the extension present", async () => {
    extensionsValue = ["adetailer"];
    const view = render(
      <ImageGenPane
        imageGen={makeImageGen({
          form: makeForm({ backend: IMAGE_GEN_BACKENDS.A1111, modelId: "m-alpha" }),
          modelOverlay: null,
        })}
      />,
    );
    await openAdvanced(view);
    expect(view.queryByTestId("image-gen-adetailer-row")).toBeNull();
  });

  it("hidden on cloud backends — no extension surface at all", async () => {
    extensionsValue = ["adetailer"]; // even if the mock would answer
    const view = render(
      <ImageGenPane imageGen={makeImageGen({ form: makeForm({ modelId: "m-alpha" }), modelOverlay: {} })} />,
    );
    await openAdvanced(view);
    expect(view.queryByTestId("image-gen-adetailer-row")).toBeNull();
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
