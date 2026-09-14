import { describe, expect, it, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import type { ImageGenProfileRecord } from "../../../../api/image-gen-api.js";
import type { useImageProfiles } from "../../../../hooks/use-image-profiles.js";

// ── Mobile mock (mutable-flag convention, MasterDetailModal.test.tsx) ────
const realUseMobile = await import("../../../../hooks/use-mobile.js");
let isMobile = false;
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobile,
}));

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

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");

let ImageGenFooter: typeof import("./ImageGenFooter.js").ImageGenFooter;
beforeAll(async () => {
  ({ ImageGenFooter } = await import("./ImageGenFooter.js"));
});

type ImageGenHook = ReturnType<typeof useImageProfiles>;

function makeImageGen(overrides: Partial<ImageGenHook> = {}): ImageGenHook {
  return {
    profiles: [] as ImageGenProfileRecord[],
    loading: false,
    editingId: "ig1",
    form: {
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
      capabilities: {
        supportsNegativePrompt: false,
        supportsSamplers: false,
        supportsSeed: false,
        sizeSupport: { kind: "vendor-set", sizes: ["1024x1024"] },
        noApiKey: false,
        supportsLiveProgress: false,
        supportsImg2img: false,
        supportsInpaint: false,
      },
    },
    dirty: true,
    error: null,
    saving: false,
    headerMode: "view",
    modelsByProfile: {},
    samplersByProfile: {},
    probeOutcome: null,
    startEdit: mock(() => {}),
    startCreate: mock(() => {}),
    select: mock(() => {}),
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    probeSaved: mock(async () => null),
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

beforeEach(() => {
  isMobile = false;
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("ImageGenFooter", () => {
  it("Save click calls the hook's save (the master-detail save pattern)", async () => {
    const imageGen = makeImageGen();
    const view = render(<ImageGenFooter imageGen={imageGen} />);
    await waitFor(() => expect(view.getByRole("button", { name: /save|floppy/i })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /save|floppy/i }));
    expect(imageGen.save).toHaveBeenCalledTimes(1);
  });

  it("Cancel renders while a form is open and calls cancelEdit", async () => {
    const imageGen = makeImageGen();
    const view = render(<ImageGenFooter imageGen={imageGen} />);
    const cancel = await waitFor(() => view.getByTestId("image-gen-cancel-btn"));
    fireEvent.click(cancel);
    expect(imageGen.cancelEdit).toHaveBeenCalledTimes(1);
  });

  it("Cancel does not render without a form", async () => {
    const imageGen = makeImageGen({ form: null, dirty: false });
    const view = render(<ImageGenFooter imageGen={imageGen} />);
    expect(view.queryByTestId("image-gen-cancel-btn")).toBeNull();
  });

  it("Delete on a saved profile opens the confirm modal; confirm calls remove", async () => {
    const imageGen = makeImageGen();
    const view = render(<ImageGenFooter imageGen={imageGen} />);
    const deleteAction = await waitFor(() => view.getByText("delete"));
    fireEvent.click(deleteAction);
    // Confirm modal body interpolates the profile name (params → "key:name").
    await waitFor(() =>
      expect(document.body.textContent ?? "").toContain("image_gen_profile_delete_confirm_body:OpenRouter art"),
    );
    const confirm = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("button")).find(
        (n) => n.textContent?.trim() === "delete_btn",
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(imageGen.remove).toHaveBeenCalledTimes(1);
  });

  it("a NEW profile (id null) renders no delete action", async () => {
    const imageGen = makeImageGen({
      editingId: null,
      form: { ...makeImageGen().form!, id: null },
    });
    const view = render(<ImageGenFooter imageGen={imageGen} />);
    await waitFor(() => expect(view.getByTestId("image-gen-cancel-btn")).toBeTruthy());
    expect(view.queryByText("delete")).toBeNull();
  });
});
