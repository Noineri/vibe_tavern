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

const { act, cleanup, waitFor, fireEvent, render } = await import("@testing-library/react");
const { ImageGenProfileEditor } = await import("./ImageGenProfileEditor.js");
const { useImageProfiles } = await import("../../../../hooks/use-image-profiles.js");
const { IMAGE_GEN_BACKENDS } = await import("@vibe-tavern/domain");

type ImageGenRecord = import("../../../../api/image-gen-api.js").ImageGenProfileRecord;
type ImageGenHook = ReturnType<typeof useImageProfiles>;

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
    capabilities: {
      supportsNegativePrompt: false,
      supportsSamplers: false,
      supportsSeed: false,
      sizeSupport: { kind: "vendor-set", sizes: ["1024x1024"] },
      noApiKey: false,
      supportsLiveProgress: false,
        localExecution: false,
      supportsImg2img: false,
      supportsInpaint: false,
    },
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Form-shape twin of the hook state (the ImageGenProfileForm fields the
 *  editor reads — endpoint/apiKey are TOP-LEVEL, not config, the IG-10
 *  deviation from STT). */
function makeForm(overrides: Partial<ImageGenHook["form"]> = {}): NonNullable<ImageGenHook["form"]> {
  return {
    id: null,
    name: "New profile",
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    presetId: null,
    endpoint: "",
    apiKey: "",
    hasStoredApiKey: false,
    modelId: null,
    defaultParams: {},
    modeSizePresets: {},
    llmAssistEnabled: false,
    llmProviderProfileId: null,
    llmModelId: null,
    capabilities: makeRecord().capabilities,
    ...overrides,
  };
}

function makeImageGen(overrides: Partial<ImageGenHook> = {}): ImageGenHook {
  return {
    profiles: [] as ImageGenRecord[],
    loading: false,
    editingId: null,
    form: makeForm(),
    dirty: false,
    error: null,
    saving: false,
    headerMode: "edit",
    modelsByProfile: {},
    samplersByProfile: {},
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

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("ImageGenProfileEditor — edit mode (level-1 connection form)", () => {
  it("renders the connection form (health: name + segment + endpoint + key + test card)", async () => {
    const view = render(<ImageGenProfileEditor imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-provider-form")).toBeTruthy());
    expect(view.getByTestId("image-gen-profile-name-input")).toBeTruthy();
    expect(view.getByTestId("image-gen-segment-select")).toBeTruthy();
    expect(view.getByTestId("image-gen-field-endpoint")).toBeTruthy();
    expect(view.getByTestId("image-gen-field-api-key")).toBeTruthy();
    expect(view.getByTestId("image-gen-test-card")).toBeTruthy();
  });

  it("GOVERNING-RULE PIN: no model / size / sampler controls inside the connection form (level-2 is IG-12)", async () => {
    const view = render(<ImageGenProfileEditor imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-provider-form")).toBeTruthy());
    expect(view.queryByTestId("image-gen-model-picker")).toBeNull();
    expect(view.queryByText("steps")).toBeNull();
    expect(view.queryByText("cfg_scale")).toBeNull();
  });

  it("CF8: custom segment is BARE — no protocol select, no preset dropdown (the SttProviderForm twin rule)", async () => {
    const view = render(<ImageGenProfileEditor imageGen={makeImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-provider-form")).toBeTruthy());
    expect(view.queryByTestId("image-gen-protocol-select")).toBeNull();
    expect(view.queryByTestId("image-gen-preset-select")).toBeNull();
  });

  it("CF8: segment switch to Custom pins the backend to openai-images under the hood + drops the preset slug", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({
      setForm,
      form: makeForm({ presetId: "a1111", backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" }),
    });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-segment-select")).toBeTruthy());
    await act(async () => {
      view.getByTestId("image-gen-segment-select").click();
    });
    const option = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
        (n) => n.textContent?.trim() === "custom",
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      (option as HTMLElement).click();
    });
    const calls = (setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    expect(calls.some((patch) => patch["backend"] === IMAGE_GEN_BACKENDS.OpenAiImages)).toBe(true);
    expect(calls.some((patch) => patch["presetId"] === null)).toBe(true);
  });

  it("preset-backed form renders the preset dropdown + read-only preset endpoint (cloud rows)", async () => {
    const imageGen = makeImageGen({
      form: makeForm({ presetId: "openrouter", backend: IMAGE_GEN_BACKENDS.OpenRouter, endpoint: "https://openrouter.ai/api/v1" }),
    });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-preset-select")).toBeTruthy());
    expect(view.queryByTestId("image-gen-protocol-select")).toBeNull();
    // Read-only preset endpoint echoes the row baseUrl.
    const readonly = view
      .getAllByRole("textbox")
      .find((el) => (el as HTMLInputElement).value === "https://openrouter.ai/api/v1");
    expect(readonly).toBeTruthy();
  });

  it("segment switch to Cloud applies the FIRST roster row: backend + presetId + endpoint (roster order, no guessing)", async () => {
    const setForm = mock(() => {});
    const imageGen = makeImageGen({ setForm });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-segment-select").textContent).toContain("custom"));
    await act(async () => {
      view.getByTestId("image-gen-segment-select").click();
    });
    const option = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
        (n) => n.textContent?.trim() === "Cloud",
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      (option as HTMLElement).click();
    });
    const calls = (setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    expect(calls.some((patch) => patch["backend"] === IMAGE_GEN_BACKENDS.OpenRouter)).toBe(true);
    expect(calls.some((patch) => patch["presetId"] === "openrouter")).toBe(true);
    expect(calls.some((patch) => patch["endpoint"] === "https://openrouter.ai/api/v1")).toBe(true);
  });

  it("key-optional hint renders for the A1111 preset, not for cloud rows", async () => {
    const imageGen = makeImageGen({
      form: makeForm({ presetId: "a1111", backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" }),
    });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-key-optional-hint")).toBeTruthy());
    cleanup();

    const cloud = makeImageGen({
      form: makeForm({ presetId: "openai", backend: IMAGE_GEN_BACKENDS.OpenAiImages, endpoint: "https://api.openai.com/v1" }),
    });
    const view2 = render(<ImageGenProfileEditor imageGen={cloud} />);
    await waitFor(() => expect(view2.getByTestId("image-gen-provider-form")).toBeTruthy());
    expect(view2.queryByTestId("image-gen-key-optional-hint")).toBeNull();
  });

  it("P10 PIN: Test connection probes the catalog via the DRAFT route (unsaved draft, key rides inside)", async () => {
    const fetchDraftModels = mock(async () => [{ id: "google/gemini-3.1-flash-image", label: "Gemini" }]);
    const imageGen = makeImageGen({ fetchDraftModels });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-test-connection-btn")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-test-connection-btn"));
    await waitFor(() => expect(view.getByTestId("image-gen-test-success")).toBeTruthy());
    expect(fetchDraftModels).toHaveBeenCalledTimes(1);
  });

  it("P10: a rejected probe shows the failure badge (fail-closed auth)", async () => {
    const fetchDraftModels = mock(async () => {
      throw new Error("401 Unauthorized");
    });
    const imageGen = makeImageGen({ fetchDraftModels });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-test-connection-btn")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-test-connection-btn"));
    await waitFor(() => expect(view.getByTestId("image-gen-test-failure")).toBeTruthy());
  });

  it("an empty model catalog still resolves as a successful probe (ok:true, zero models)", async () => {
    const fetchDraftModels = mock(async () => []);
    const imageGen = makeImageGen({ fetchDraftModels });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-test-connection-btn")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-test-connection-btn"));
    await waitFor(() => expect(view.getByTestId("image-gen-test-failure")).toBeTruthy());
    expect(fetchDraftModels).toHaveBeenCalledTimes(1);
  });
});

describe("ImageGenProfileEditor — view mode (saved profile)", () => {
  function makeViewImageGen(overrides: Partial<ImageGenHook> = {}): ImageGenHook {
    const record = makeRecord();
    return makeImageGen({
      profiles: [record],
      editingId: record.id,
      form: makeForm({
        id: record.id,
        name: record.name,
        backend: record.backend,
        presetId: record.presetId ?? null,
        endpoint: record.endpoint,
        hasStoredApiKey: record.hasStoredApiKey,
      }),
      headerMode: "view",
      ...overrides,
    });
  }

  it("renders the base card (name + preset label + endpoint host) and NO connection form", async () => {
    const view = render(<ImageGenProfileEditor imageGen={makeViewImageGen()} />);
    await waitFor(() => expect(view.getByTestId("image-gen-base-card")).toBeTruthy());
    expect(view.getByTestId("image-gen-base-card-name").textContent).toBe("OpenRouter art");
    expect(view.queryByTestId("image-gen-provider-form")).toBeNull();
  });

  it("A1111 keyless profiles show the neutral keyless note, not the no-key warning", async () => {
    const record = makeRecord({
      backend: IMAGE_GEN_BACKENDS.A1111,
      presetId: "a1111",
      endpoint: "http://127.0.0.1:7860",
      hasStoredApiKey: false,
    });
    const imageGen = makeViewImageGen({
      profiles: [record],
      form: makeForm({
        id: record.id,
        name: record.name,
        backend: record.backend,
        presetId: "a1111",
        endpoint: record.endpoint,
      }),
    });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-base-card-keyless")).toBeTruthy());
  });

  it("CF4: view mode renders NO connection-actions card (probe lives in the connection form's test card; model refresh lives in the Pane)", async () => {
    const imageGen = makeViewImageGen();
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    // The base card + the IG-12 pane stay; the whole duplicated-actions
    // card is gone (both buttons, the probe badge/detail, the count/error
    // lines — one boundary: the card's testid).
    await waitFor(() => expect(view.getByTestId("image-gen-base-card")).toBeTruthy());
    expect(view.queryByTestId("image-gen-connection-actions")).toBeNull();
    expect(view.queryByTestId("image-gen-probe-btn")).toBeNull();
    expect(view.queryByTestId("image-gen-fetch-models-btn")).toBeNull();
    expect(view.queryByTestId("image-gen-probe-success")).toBeNull();
    expect(view.queryByTestId("image-gen-models-count")).toBeNull();
  });

  it("Edit settings flips the editor into edit mode (startEdit)", async () => {
    const startEdit = mock(() => {});
    const imageGen = makeViewImageGen({ startEdit });
    const view = render(<ImageGenProfileEditor imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-base-card-edit-btn")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-base-card-edit-btn"));
    expect(startEdit).toHaveBeenCalledTimes(1);
  });
});
