import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === "object" && "name" in params
        ? `${key}:${String(params.name)}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { act, cleanup, waitFor, fireEvent, render } = await import("@testing-library/react");
const { ImageGenSection } = await import("./ImageGenSection.js");
const { useImageProfiles } = await import("../../../../hooks/use-image-profiles.js");
const { useMasterDetail, MasterDetailModal } = await import("../../../shared/MasterDetailModal.js");
const { IMAGE_GEN_BACKENDS } = await import("@vibe-tavern/domain");
const { useImageGenChatStore } = await import("../../../../stores/image-gen-chat-store.js");

type ImageGenRecord = import("../../../../api/image-gen-api.js").ImageGenProfileRecord;
type ImageGenHook = ReturnType<typeof useImageProfiles>;

function makeRecord(overrides: Partial<ImageGenRecord> = {}): ImageGenRecord {
  return {
    id: "ig1",
    name: "OpenRouter art",
    backend: "openrouter",
    presetId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    hasStoredApiKey: true,
    autoKeyProviderName: null,
    modelId: undefined,
    defaultParams: {},
    defaultParamsSetId: null,
    modeSizePresets: {},
    llmAssistEnabled: false,
    assistRetryOnRefusal: false,
    familySource: "none",
    qualityLayerEnabled: false,
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
    isDefault: false,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeImageGen(overrides: Record<string, unknown> = {}): ImageGenHook {
  const base = {
    profiles: [makeRecord()] as ImageGenRecord[],
    profileSearch: "",
    filteredProfiles: [makeRecord()] as ImageGenRecord[],
    loading: false,
    editingId: "ig1",
    form: null,
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
    modelsSnapshotAtByProfile: {},
    sidecarsSnapshotAtByProfile: {},
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
    setProfileSearch: mock(() => {}),
    reorder: mock(async () => {}),
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
  };
  return {
    ...base,
    ...overrides,
    filteredProfiles: "filteredProfiles" in overrides ? overrides.filteredProfiles : "profiles" in overrides ? overrides.profiles : base.filteredProfiles,
  } as ImageGenHook;
}

/** Section renders inside the MasterDetailModal context (it calls
 *  useMasterDetail through the list) — the SttSection.test twin. */
function SectionHost({ imageGen }: { imageGen: ReturnType<typeof useImageProfiles> }) {
  void useMasterDetail();
  return <ImageGenSection imageGen={imageGen} />;
}

function renderSection(imageGen: ImageGenHook) {
  return render(
    <MasterDetailModal
      isOpen={true}
      title="x"
      masterContent={() => <SectionHost imageGen={imageGen} />}
      detailContent={null}
      onClose={() => {}}
    />,
  );
}

afterEach(async () => {
  useImageGenChatStore.setState({ activeImageGenProfileId: null });
  await act(async () => {});
  cleanup();
});

describe("ImageGenSection", () => {
  it("renders the section title and profile rows with the preset sub-label", async () => {
    const imageGen = makeImageGen();
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-section")).toBeTruthy());
    expect(view.getByText("OpenRouter art")).toBeTruthy();
    // Preset-backed row: the row label is the PRESET row label, not the raw slug.
    expect(view.getAllByText("OpenRouter").length).toBeGreaterThan(0);
  });

  it("custom (preset-less) rows fall back to the raw backend slug", async () => {
    const imageGen = makeImageGen({
      profiles: [makeRecord({ id: "ig2", name: "Custom endpoint", presetId: undefined, backend: IMAGE_GEN_BACKENDS.OpenAiImages })],
    });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-profile-row")).toBeTruthy());
    expect(view.getByText("openai-images")).toBeTruthy();
  });

  it("loading state shows the loading label", async () => {
    const imageGen = makeImageGen({ loading: true, profiles: [] });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-section")).toBeTruthy());
    expect(view.getByTestId("image-gen-section").className).toBe("flex flex-col p-3");
    expect(view.getByText("image_gen_section_title")).toBeTruthy();
    expect(view.getByText("loading")).toBeTruthy();
  });

  it("uses the effective active pointer: session selection wins, then persisted default", async () => {
    const imageGen = makeImageGen({
      profiles: [makeRecord({ id: "default", name: "Saved default", isDefault: true }), makeRecord({ id: "session", name: "Session choice" })],
    });
    useImageGenChatStore.setState({ activeImageGenProfileId: "session" });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByText("★ Session choice")).toBeTruthy());
    expect(view.queryByText("★ Saved default")).toBeNull();
  });

  it("passes hook-owned search to the unified list and disables its drag handles while active", async () => {
    const setProfileSearch = mock(() => {});
    const imageGen = makeImageGen({ profileSearch: "OpenRouter", filteredProfiles: [makeRecord()], setProfileSearch });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByPlaceholderText("search_profiles")).toBeTruthy());
    fireEvent.change(view.getByPlaceholderText("search_profiles"), { target: { value: "art" } });
    expect(setProfileSearch).toHaveBeenCalledWith("art");
    expect(view.queryByLabelText("drag")).toBeNull();
  });

  it("error state renders the load-error banner", async () => {
    const imageGen = makeImageGen({ error: "boom" });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-load-error")).toBeTruthy());
  });

  it("'+ New' seeds a BARE custom profile (name + the openai-images dialect via startCreate, IG-CF8)", async () => {
    const imageGen = makeImageGen();
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-new-profile-btn")).toBeTruthy());
    fireEvent.click(view.getByTestId("image-gen-new-profile-btn"));
    await waitFor(() =>
      expect(imageGen.startCreate).toHaveBeenCalledWith("image_gen_profile_default_name", IMAGE_GEN_BACKENDS.OpenAiImages),
    );
  });

  it("keeps the mobile drill-down selection action on the shared row", async () => {
    const select = mock(() => {});
    const imageGen = makeImageGen({ select });
    const view = renderSection(imageGen);
    await waitFor(() => expect(view.getByTestId("image-gen-profile-row")).toBeTruthy());
    const rowButtons = view.getByTestId("image-gen-profile-row").querySelectorAll("button");
    fireEvent.click(rowButtons[rowButtons.length - 1]!);
    expect(select).toHaveBeenCalledWith("ig1");
  });
});
