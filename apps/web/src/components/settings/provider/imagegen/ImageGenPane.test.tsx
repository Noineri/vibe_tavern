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

const { act, cleanup, fireEvent, render: render_impl, waitFor } = await import("@testing-library/react");
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

function makeForm(overrides: Partial<NonNullable<ImageGenHook["form"]>> = {}): NonNullable<ImageGenHook["form"]> {
  return {
    id: "ig1",
    name: "OpenRouter art",
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    presetId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "",
    hasStoredApiKey: false,
    modelId: null,
    defaultParams: {},
    modeSizePresets: {},
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
    modelsByProfile: {},
    samplersByProfile: {},
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
  ]) {
    m.mockClear();
  }
});

describe("ImageGenPane — second level rendering", () => {
  it("renders the pane with a size row for EVERY v1 mode (six) and the params section", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-pane")).toBeTruthy());
    expect(view.getByTestId("image-gen-sizes-section")).toBeTruthy();
    expect(view.getByTestId("image-gen-params-section")).toBeTruthy();
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

describe("ImageGenPane — per-mode sizes", () => {
  it("vendor-set backends: a dropdown per mode with the capability grid; picking one patches modeSizePresets", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({ setForm });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-mode-size-portrait")).toBeTruthy());
    // Unset mode → the auto placeholder label shows in the trigger.
    expect(view.getByTestId("image-gen-mode-size-portrait").textContent).toContain("image_gen_size_auto");
    await pickOption(view, "image-gen-mode-size-portrait", "832x1248");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, unknown> };
    expect(patch.modeSizePresets).toEqual({ portrait: { width: 832, height: 1248 } });
  });

  it("free-size backends (a1111): free W×H inputs per mode, EMPTY by default; typing patches one dimension", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
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
      setForm,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await waitFor(() => expect((view.getByTestId("image-gen-mode-width-portrait") as HTMLInputElement).value).toBe(""));
    expect((view.getByTestId("image-gen-mode-height-portrait") as HTMLInputElement).value).toBe("");
    // Vendor-set dropdowns must NOT render for a free backend.
    expect(view.queryByTestId("image-gen-mode-size-portrait")).toBeNull();
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-mode-width-portrait"), { target: { value: "512" } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { modeSizePresets: Record<string, unknown> };
    expect(patch.modeSizePresets).toEqual({ portrait: { width: 512 } });
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
    await waitFor(() => expect(view.getByTestId("image-gen-field-sampler")).toBeTruthy());
    await pickOption(view, "image-gen-field-sampler", "Euler a");
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ sampler: "Euler a" });
    cleanup();

    // OpenRouter (no sampler surface): the control must not render at all.
    const openrouter = makeImageGen({ setForm });
    const view2 = render(<ImageGenPane imageGen={openrouter} />);
    await waitFor(() => expect(view2.getByTestId("image-gen-params-section")).toBeTruthy());
    expect(view2.queryByTestId("image-gen-field-sampler")).toBeNull();
  });

  it("advanced expand reveals steps/cfg/seed/clip-skip and every numeric field is EMPTY (no code defaults)", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    expect(view.queryByTestId("image-gen-advanced-body")).toBeNull();
    await act(async () => {
      view.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-body")).toBeTruthy());
    for (const fieldId of ["image-gen-field-steps", "image-gen-field-cfg", "image-gen-field-seed", "image-gen-field-clip-skip"]) {
      expect((view.getByTestId(fieldId) as HTMLInputElement).value).toBe("");
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
      view.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-steps"), { target: { value: "30" } });
    });
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
      view.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-steps"), { target: { value: "30" } });
    });
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

describe("ImageGenPane — advanced sliders (IG-CF5)", () => {
  async function openAdvanced(view: { getByTestId: (id: string) => HTMLElement }) {
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-header")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-advanced-body")).toBeTruthy());
  }

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
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-cfg"), { target: { value: String(max) } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ cfgScale: max });
  });

  it("clearing the number box commits back to undefined (param not sent)", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      form: makeForm({ defaultParams: { steps: IMAGE_GEN_PARAM_RANGES.steps.max } }),
      setForm,
    });
    const view = render(<ImageGenPane imageGen={imageGen} />);
    await openAdvanced(view);
    // Precondition: the committed value shows in the box (not the min).
    expect((view.getByTestId("image-gen-field-steps") as HTMLInputElement).value).toBe(
      String(IMAGE_GEN_PARAM_RANGES.steps.max),
    );
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-steps"), { target: { value: "" } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams["steps"]).toBe(undefined);
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

  it("undefined params render an EMPTY number box with the range parked at min", async () => {
    const view = render(<ImageGenPane imageGen={makeImageGen()} />);
    await openAdvanced(view);
    const pairs: Array<[string, string, keyof typeof IMAGE_GEN_PARAM_RANGES]> = [
      ["image-gen-field-steps", "image-gen-range-steps", "steps"],
      ["image-gen-field-cfg", "image-gen-range-cfg", "cfgScale"],
      ["image-gen-field-clip-skip", "image-gen-range-clip-skip", "clipSkip"],
    ];
    for (const [fieldId, rangeId, key] of pairs) {
      // The min must never masquerade as a committed value in the box.
      expect((view.getByTestId(fieldId) as HTMLInputElement).value).toBe("");
      expect((view.getByTestId(rangeId) as HTMLInputElement).value).toBe(String(IMAGE_GEN_PARAM_RANGES[key].min));
    }
  });

  it("a typed out-of-range number commits CLAMPED to the domain max (the NumberInput semantics)", async () => {
    const setForm = mock(() => {});
    const view = render(<ImageGenPane imageGen={makeImageGen({ setForm })} />);
    await openAdvanced(view);
    // Ten-times-max via string concat (no literals): forces the clamp lane.
    const over = `${IMAGE_GEN_PARAM_RANGES.steps.max}0`;
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-steps"), { target: { value: over } });
    });
    await waitFor(() => expect(setForm).toHaveBeenCalledTimes(1));
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { defaultParams: Record<string, unknown> };
    expect(patch.defaultParams).toEqual({ steps: IMAGE_GEN_PARAM_RANGES.steps.max });
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
      view.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect(view.getByTestId("image-gen-field-steps")).toBeTruthy());
    await act(async () => {
      fireEvent.change(view.getByTestId("image-gen-field-steps"), { target: { value: "30" } });
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
      view2.getByTestId("image-gen-advanced-header").click();
    });
    await waitFor(() => expect((view2.getByTestId("image-gen-field-steps") as HTMLInputElement).value).toBe("30"));
  });

  it("unbind immediately DELETEs the stored overlay (the revert is the destructive action)", async () => {
    settingsRow = {
      id: "ms1",
      profileId: "p1",
      modelId: "sd_xl",
      settings: { steps: 30 },
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
