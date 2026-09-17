import { describe, expect, it, mock, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const realImageGenApi = await import("../../api/image-gen-api.js");

type ProfileRecord = import("../../api/image-gen-api.js").ImageGenProfileRecord;
type ModelEntry = import("../../api/image-gen-api.js").ImageGenModelEntry;
type SamplerEntry = import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue;

type Caps = ProfileRecord["capabilities"];

function fullCaps(): Caps {
  return {
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
  };
}

function noCaps(): Caps {
  return { ...fullCaps(), supportsNegativePrompt: false, supportsSamplers: false, supportsSeed: false };
}

function profile(id: string, name: string, capabilities: Caps, modelId?: string): ProfileRecord {
  return {
    id,
    name,
    backend: "openrouter",
    endpoint: "https://example.test",
    hasStoredApiKey: true,
    autoKeyProviderName: null,
    modelId,
    defaultParams: {},
    modeSizePresets: {},
    llmAssistEnabled: false,
    capabilities,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let profilesStore: ProfileRecord[] = [];
let modelsStore: Record<string, ModelEntry[]> = {};
let samplersStore: Record<string, SamplerEntry[]> = {};
let extensionsStore: Record<string, string[]> = {};
let overlayStore: Record<string, import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue> = {};
const upsertCalls: Array<{
  profileId: string;
  modelId: string;
  settings: import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue;
}> = [];

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: () => Promise.resolve([...profilesStore]),
  listImageGenModels: (id: string) => Promise.resolve([...(modelsStore[id] ?? [])]),
  listImageGenSamplers: (id: string) => Promise.resolve([...(samplersStore[id] ?? [])]),
  listImageGenExtensions: (id: string) => Promise.resolve([...(extensionsStore[id] ?? [])]),
  getImageGenModelSettings: (id: string, modelId: string) =>
    Promise.resolve(overlayStore[`${id}/${modelId}`] ? { settings: overlayStore[`${id}/${modelId}`] } : null),
  upsertImageGenModelSettings: (
    id: string,
    modelId: string,
    settings: import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue,
  ) => {
    upsertCalls.push({ profileId: id, modelId, settings });
    overlayStore[`${id}/${modelId}`] = { ...settings };
    return Promise.resolve({
      id: "row1",
      profileId: id,
      modelId,
      settings: { ...settings },
      samplerSetId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  },
}));

// The pill self-forks on `useIsMobile` (CF1: the variant prop is gone). Mock
// it to a controllable flag so the mobile BottomSheet path is testable — the
// ExperienceCopilotShell pattern (capture real, spread, override one fn).
const realMobile = await import("../../hooks/use-mobile.js");
let mobileOverride = false;
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

const { ImageGenFineTuningChip } = await import("./ImageGenFineTuningChip.js");
const { useImageGenChatStore } = await import("../../stores/image-gen-chat-store.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");

function renderChip(node: React.ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider delayDuration={200}>{node}</TooltipProvider>);
}

function armChat(chatId: string): void {
  useImageGenChatStore.getState().setFineTuning(chatId, true);
}

function openChip(): void {
  const chip = document.body.querySelector('[data-testid="image-gen-ft-chip"]');
  if (!(chip instanceof HTMLElement)) throw new Error("no chip trigger");
  act(() => {
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
  });
}

/** Find a cmdk option by exact text and click it — portal content lives in
 *  document.body, not the RTL container (the ImageGenPane harness pattern). */
async function pickOption(triggerId: string, label: string) {
  const trigger = await waitFor(() => {
    const el = document.body.querySelector(`[data-testid="${triggerId}"]`);
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  await act(async () => {
    trigger.click();
  });
  const option = await waitFor(() => {
    const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
      (n) => n.textContent?.trim() === label,
    );
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  await act(async () => {
    option.click();
  });
}

afterEach(() => {
  cleanup();
  profilesStore = [];
  modelsStore = {};
  samplersStore = {};
  extensionsStore = {};
  overlayStore = {};
  upsertCalls.length = 0;
  mobileOverride = false;
  // The store is a module singleton shared across files in this worker —
  // leave every map pristine.
  useImageGenChatStore.setState({
    fineTuningByChat: {},
    fineTuningDraftByChat: {},
    activeProfileIdByChat: {},
    runningByChat: {},
  });
});

describe("ImageGenFineTuningChip — the IG-16 gate + pill canon (IG-17, CF1)", () => {
  it("renders nothing while the chat's Fine-tuning toggle is off; appears when it flips on", async () => {
    profilesStore = [profile("p1", "OpenRouter main", noCaps())];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-gate" />);
    expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(0);
    act(() => armChat("chat-gate"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
  });

  it("the pill label is FIXED — no profile name, no model id (the dice-pill rule; internals live in the editor)", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-label" />);
    act(() => armChat("chat-label"));
    const chip = await waitFor(() => {
      const el = view.container.querySelector('[data-testid="image-gen-ft-chip"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Mocked t returns the key — the label is exactly the fine-tuning string.
    expect(chip.textContent).toContain("image_gen_fine_tuning");
    expect(chip.textContent).not.toContain("A1111 local");
    expect(chip.textContent).not.toContain("sdxl-base");
  });

  it("accent state tracks the armed draft prompt (the dice pill's readyCount tint analog)", async () => {
    profilesStore = [profile("p1", "OpenRouter main", fullCaps())];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-accent" />);
    act(() => armChat("chat-accent"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    let chip = view.container.querySelector('[data-testid="image-gen-ft-chip"]') as HTMLElement;
    expect(chip.className).not.toContain("bg-accent-dim");

    act(() => {
      useImageGenChatStore.getState().setFineTuningDraft("chat-accent", { prompt: "a castle at dawn" });
    });
    await waitFor(() => {
      chip = view.container.querySelector('[data-testid="image-gen-ft-chip"]') as HTMLElement;
      expect(chip.className).toContain("bg-accent-dim");
      expect(chip.className).toContain("text-accent-t");
    });

    // Clearing the draft de-accents the pill.
    act(() => {
      useImageGenChatStore.getState().clearFineTuningDraft("chat-accent");
    });
    await waitFor(() => {
      chip = view.container.querySelector('[data-testid="image-gen-ft-chip"]') as HTMLElement;
      expect(chip.className).not.toContain("bg-accent-dim");
    });
  });

  it("the mobile fork opens the same editor body in a BottomSheet", async () => {
    mobileOverride = true;
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-mobile" />);
    act(() => armChat("chat-mobile"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).getByTestId("image-gen-ft-profile-select")).toBeTruthy();
  });
});

describe("ImageGenFineTuningChip — editor body (IG-17)", () => {
  it("profile/model/sampler/prompt render; negative + sampler rows are capability-gated OFF for a no-caps profile", async () => {
    profilesStore = [profile("p1", "OpenRouter main", noCaps(), "flux-1")];
    modelsStore = { p1: [{ id: "flux-1", label: "Flux 1" }, { id: "sdxl", label: "SDXL" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-body" />);
    act(() => armChat("chat-body"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).getByTestId("image-gen-ft-profile-select")).toBeTruthy();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
    expect(within(view.baseElement).getByTestId("image-gen-ft-prompt")).toBeTruthy();
    // No-caps profile: the gated rows never render.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-negative-row")).toBeNull();
    expect(within(view.baseElement).queryByTestId("image-gen-ft-sampler-row")).toBeNull();
  });

  it("a caps profile renders the negative + sampler rows; edits write the per-chat draft", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }, { id: "pony-v6", label: "Pony V6" }] };
    samplersStore = { p1: [{ name: "Euler a" }, { name: "DPM++ 2M" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-edit" />);
    act(() => armChat("chat-edit"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-negative-row")).toBeTruthy());
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-sampler-row")).toBeTruthy());

    fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-prompt"), {
      target: { value: "a castle at dawn" },
    });
    fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-negative"), {
      target: { value: "blurry, lowres" },
    });
    await pickOption("image-gen-ft-model-select", "Pony V6");
    await pickOption("image-gen-ft-sampler-select", "Euler a");

    const draft = useImageGenChatStore.getState().fineTuningDraftByChat["chat-edit"];
    expect(draft).toEqual({
      prompt: "a castle at dawn",
      negative: "blurry, lowres",
      model: "pony-v6",
      sampler: "Euler a",
    });
  });

  it("the draft persists across unmount/remount while the toggle stays on; Clear resets it", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }] };
    act(() => armChat("chat-persist"));
    useImageGenChatStore.getState().setFineTuningDraft("chat-persist", { prompt: "keep me" });

    const first = renderChip(<ImageGenFineTuningChip chatId="chat-persist" />);
    await waitFor(() => expect(first.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(first.baseElement).getByTestId("image-gen-ft-prompt")).toBeTruthy());
    expect((within(first.baseElement).getByTestId("image-gen-ft-prompt") as HTMLTextAreaElement).value).toBe("keep me");

    // Remount (same chat, toggle still on) — the value survives.
    first.unmount();
    const second = renderChip(<ImageGenFineTuningChip chatId="chat-persist" />);
    await waitFor(() => expect(second.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(second.baseElement).getByTestId("image-gen-ft-prompt")).toBeTruthy());
    expect((within(second.baseElement).getByTestId("image-gen-ft-prompt") as HTMLTextAreaElement).value).toBe("keep me");

    // Clear returns the chat to pristine.
    fireEvent.click(within(second.baseElement).getByTestId("image-gen-ft-clear"));
    await waitFor(() =>
      expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-persist"]).toBeUndefined(),
    );
    expect((within(second.baseElement).getByTestId("image-gen-ft-prompt") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("ImageGenFineTuningChip — model settings accordion (IG-CF15 15d)", () => {
  /** Open the chip, pick a concrete model, and open the model-settings
   *  accordion — returns the popover root to query inside. */
  async function openAccordion(chatId: string) {
    const view = renderChip(<ImageGenFineTuningChip chatId={chatId} />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
    await pickOption("image-gen-ft-model-select", "SDXL Base");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings")).toBeTruthy(),
    );
    await act(async () => {
      within(view.baseElement).getByTestId("image-gen-ft-model-settings-header").click();
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings-body")).toBeTruthy(),
    );
    return view;
  }

  it("renders ONLY when a concrete model is picked — the default-model state has no accordion", async () => {
    profilesStore = [profile("ig1", "Local Forge", fullCaps())];
    modelsStore["ig1"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    armChat("chat-ms1");

    const view = renderChip(<ImageGenFineTuningChip chatId="chat-ms1" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-model-settings")).toBeNull();

    await pickOption("image-gen-ft-model-select", "SDXL Base");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings")).toBeTruthy(),
    );
  });

  it("overlay edits merge over the loaded row and persist through upsert (one truth, two surfaces)", async () => {
    profilesStore = [profile("ig1", "Local Forge", fullCaps())];
    modelsStore["ig1"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    overlayStore["ig1/sdxl-base"] = { sampler: "Euler a", steps: 20 };
    armChat("chat-ms2");

    const view = await openAccordion("chat-ms2");
    // Loaded overlay shows through: the steps range sits at the stored 20.
    const range = within(view.baseElement).getByTestId("image-gen-range-overlay-steps") as HTMLInputElement;
    expect(range.value).toBe("20");

    await act(async () => {
      fireEvent.change(range, { target: { value: "40" } });
    });
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    // The write carries the MERGED overlay — the loaded sampler survives.
    expect(upsertCalls[0]).toEqual({
      profileId: "ig1",
      modelId: "sdxl-base",
      settings: { sampler: "Euler a", steps: 40 },
    });
  });

  it("ADetailer is hidden for non-A1111 backends and for servers without the extension", async () => {
    profilesStore = [profile("ig1", "Cloud", fullCaps())];
    modelsStore["ig1"] = [{ id: "m1", label: "SDXL Base" }];
    extensionsStore["ig1"] = ["adetailer"]; // even WITH the extension present
    armChat("chat-ms3");

    const view = await openAccordion("chat-ms3");
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer")).toBeNull();

    // A1111 dialect but the server does not list the extension → hidden too.
    cleanup();
    upsertCalls.length = 0;
    profilesStore = [{ ...profile("ig2", "Forge", fullCaps()), backend: "a1111" }];
    modelsStore = { ig2: [{ id: "sdxl-base", label: "SDXL Base" }] };
    extensionsStore = { ig2: ["sd-webui-controlnet"] };
    const view2 = await openAccordion("chat-ms3");
    expect(within(view2.baseElement).queryByTestId("image-gen-ft-adetailer")).toBeNull();
  });

  it("ADetailer nests INSIDE the samplers accordion; toggle + face model write the overlay", async () => {
    profilesStore = [{ ...profile("ig2", "Forge", fullCaps()), backend: "a1111" }];
    modelsStore["ig2"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    extensionsStore["ig2"] = ["adetailer", "sd-webui-controlnet"];
    armChat("chat-ms4");

    const view = renderChip(<ImageGenFineTuningChip chatId="chat-ms4" />);
    openChip();
    await pickOption("image-gen-ft-model-select", "SDXL Base");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings")).toBeTruthy(),
    );
    // Parent accordion COLLAPSED → the nested accordion is not in the DOM.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer")).toBeNull();

    await act(async () => {
      within(view.baseElement).getByTestId("image-gen-ft-model-settings-header").click();
    });
    const adHeader = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-adetailer-header");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Nesting pin: the adetailer header lives inside the samplers body.
    const parentBody = within(view.baseElement).getByTestId("image-gen-ft-model-settings-body");
    expect(parentBody.contains(adHeader)).toBe(true);

    await act(async () => {
      adHeader.click();
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-adetailer-body")).toBeTruthy(),
    );
    const toggle = within(view.baseElement).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0].settings).toEqual({ adetailer: true });

    // Toggle ON reveals the face-model dropdown; picking writes merged.
    await pickOption("image-gen-ft-adetailer-model", "face_yolov8s.pt");
    await waitFor(() => expect(upsertCalls.length).toBe(2));
    expect(upsertCalls[1].settings).toEqual({ adetailer: true, adetailerModel: "face_yolov8s.pt" });
  });
});
