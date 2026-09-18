import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// House i18n test pattern (SttLocalServerPanel.test.tsx): raw keys render
// as-is.
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { render, act, cleanup } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");

// The chip's honest ping seam — deterministic per test (default: an empty
// successful catalog). Leak-safe ...real.
let listModelsNext: unknown[] | Error = [];
const listModelsMock = mock(async () => {
  if (listModelsNext instanceof Error) throw listModelsNext;
  return listModelsNext;
});
const realImageGenApi = await import("../../../../api/image-gen-api.js");
mock.module("../../../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  draftListImageGenModels: listModelsMock,
}));

const { ImageGenLocalServerPanel } = await import("./ImageGenLocalServerPanel.js");
const { IMAGE_GEN_BACKENDS } = await import("@vibe-tavern/domain");
import type { ImageGenProfileForm } from "../../../../hooks/use-image-profiles.js";

function localForm(overrides: Partial<ImageGenProfileForm> = {}): ImageGenProfileForm {
  return {
    id: null,
    name: "",
    backend: IMAGE_GEN_BACKENDS.A1111,
    presetId: "a1111",
    endpoint: "",
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
    capabilities: {
      supportsNegativePrompt: true,
      supportsSamplers: true,
      supportsSeed: true,
      sizeSupport: { kind: "free" },
      noApiKey: true,
      supportsLiveProgress: true,
      localExecution: true,
      supportsImg2img: false,
      supportsInpaint: false,
    },
    ...overrides,
  };
}

function cloudForm(): ImageGenProfileForm {
  return localForm({
    backend: IMAGE_GEN_BACKENDS.OpenRouter,
    presetId: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
  });
}

function renderPanel(form: ImageGenProfileForm, updateForm: ReturnType<typeof makeUpdateForm>) {
  return render(React.createElement(ImageGenLocalServerPanel, { form, updateForm }));
}

function makeUpdateForm() {
  return mock(<K extends keyof ImageGenProfileForm>(_k: K, _v: ImageGenProfileForm[K]) => {});
}

describe("ImageGenLocalServerPanel — segment gating (PG-1)", () => {
  test("renders for the a1111 backend, null for cloud backends", () => {
    const view = renderPanel(localForm({ endpoint: "http://127.0.0.1:7860" }), makeUpdateForm());
    expect(view.queryByTestId("image-gen-local-server-panel")).not.toBeNull();

    cleanup();
    const viewCloud = renderPanel(cloudForm(), makeUpdateForm());
    expect(viewCloud.queryByTestId("image-gen-local-server-panel")).toBeNull();
  });
});

describe("ImageGenLocalServerPanel — comfyui guide (CG-B1)", () => {
  test("renders for the comfy backend with the comfy guide PRESELECTED and the 8188 endpoint", async () => {
    const updateForm = makeUpdateForm();
    const view = renderPanel(
      localForm({ backend: IMAGE_GEN_BACKENDS.ComfyUI, presetId: "comfyui", endpoint: "http://127.0.0.1:8188" }),
      updateForm,
    );
    expect(view.queryByTestId("image-gen-local-server-panel")).not.toBeNull();
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-setup-help-toggle"));
    });
    // The comfy card is the preselected guide (no a1111-first detour) and
    // the a1111 card stays a CHOICE (selected = accent border).
    const comfyChoice = view.getByTestId("image-gen-help-choice-comfyui");
    expect(comfyChoice.className).toContain("border-accent");
    const a1111Choice = view.getByTestId("image-gen-help-choice-a1111");
    expect(a1111Choice.className).not.toContain("border-accent");
    expect(view.getByText("ComfyUI")).not.toBeNull();

    // OS is environment-dependent — pin UNIX explicitly (the raw-key i18n
    // stub), then the PRESELECTED comfy run commands render while the
    // a1111 launchers never do.
    await act(async () => {
      const unixBtn = Array.from(view.getByTestId("image-gen-help-os-toggle").querySelectorAll("button")).find((b) =>
        b.textContent?.includes("image_gen_local_os_unix"),
      );
      expect(unixBtn).toBeTruthy();
      await userEvent.click(unixBtn!);
    });
    expect(view.getByText("python main.py")).not.toBeNull();
    expect(view.getByText("python main.py --listen")).not.toBeNull();
    expect(view.queryByText("./webui.sh --api --listen")).toBeNull();

    // The adopt button fills the preset endpoint 8188.
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-help-use-comfyui"));
    });
    expect(updateForm).toHaveBeenCalledWith("endpoint", "http://127.0.0.1:8188");
  });
});

describe("ImageGenLocalServerPanel — setup help accordion", () => {
  test("opens on toggle and renders the one guide card + run commands + diagnosis hints", async () => {
    const view = renderPanel(localForm(), makeUpdateForm());
    expect(view.queryByTestId("image-gen-setup-help-body")?.getAttribute("data-state")).toBeFalsy();
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-setup-help-toggle"));
    });
    // The single A1111-family card (ComfyUI joins when its adapter lands).
    expect(view.getByText("A1111-compatible UIs")).not.toBeNull();

    // The auto-detected OS is environment-dependent — pin UNIX explicitly
    // (the raw-key i18n stub makes the segment labels addressable by key).
    await act(async () => {
      const unixBtn = Array.from(view.getByTestId("image-gen-help-os-toggle").querySelectorAll("button")).find((b) =>
        b.textContent?.includes("image_gen_local_os_unix"),
      );
      expect(unixBtn).toBeTruthy();
      await userEvent.click(unixBtn!);
    });
    // Unix → three launcher rows, counted via the checklist buttons (the
    // command divs carry no ids).
    const unixRows = view.getAllByTestId(/^image-gen-help-check-/);
    expect(unixRows.length).toBe(3);
    expect(view.getByText("./webui.sh --api --listen")).not.toBeNull();
    expect(view.getByText("python launch.py --api --listen")).not.toBeNull();
    expect(view.getByText("python webui.py --api --listen")).not.toBeNull();

    // The owner's two diagnosis cases ride the body verbatim-keyed.
    expect(view.getByTestId("image-gen-help-diagnosis").textContent).toContain("image_gen_local_diag_404");
    expect(view.getByTestId("image-gen-help-diagnosis").textContent).toContain("image_gen_local_diag_gpu");
  });

  test("OS toggle switches to the Windows COMMANDLINE_ARGS variant", async () => {
    const view = renderPanel(localForm(), makeUpdateForm());
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-setup-help-toggle"));
    });
    await act(async () => {
      const winBtn = Array.from(view.getByTestId("image-gen-help-os-toggle").querySelectorAll("button")).find((b) =>
        b.textContent?.includes("image_gen_local_os_windows"),
      );
      expect(winBtn).toBeTruthy();
      await userEvent.click(winBtn!);
    });
    expect(view.getByText("set COMMANDLINE_ARGS=--api --listen")).not.toBeNull();
    expect(view.queryByText("./webui.sh --api --listen")).toBeNull();
  });

  test("adopt fills the endpoint field through the single updateForm write", async () => {
    const updateForm = makeUpdateForm();
    const view = renderPanel(localForm(), updateForm);
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-setup-help-toggle"));
    });
    await act(async () => {
      await userEvent.click(view.getByTestId("image-gen-help-use-a1111"));
    });
    expect(updateForm).toHaveBeenCalledTimes(1);
    expect(updateForm.mock.calls[0]).toEqual(["endpoint", "http://127.0.0.1:7860"]);
  });
});

describe("ImageGenLocalServerPanel — local status chip (honest endpoint ping)", () => {
  beforeEach(() => {
    listModelsNext = [];
    listModelsMock.mockClear();
  });

  test("empty endpoint → UNKNOWN and no ping fires", () => {
    const view = renderPanel(localForm(), makeUpdateForm());
    const chip = view.getByTestId("image-gen-local-status");
    expect(chip.className).toContain("border-border2");
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  test("endpoint answers → ONLINE; dead endpoint → OFFLINE", async () => {
    const form = localForm({ endpoint: "http://127.0.0.1:7860" });
    const view = renderPanel(form, makeUpdateForm());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("image-gen-local-status").className).toContain("border-success/30");
    view.unmount();

    listModelsNext = new Error("A1111 image-gen transport failed: 404");
    const view2 = renderPanel(form, makeUpdateForm());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view2.getByTestId("image-gen-local-status").className).toContain("border-danger/30");
  });

  test("the re-check button re-pings the endpoint", async () => {
    const form = localForm({ endpoint: "http://127.0.0.1:7860" });
    const view = renderPanel(form, makeUpdateForm());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const recheck = view.getByTestId("image-gen-local-status").querySelector("button");
    expect(recheck).toBeTruthy();
    await act(async () => {
      recheck!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listModelsMock).toHaveBeenCalledTimes(2);
  });
});
