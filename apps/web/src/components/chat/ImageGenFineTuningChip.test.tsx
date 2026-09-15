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

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: () => Promise.resolve([...profilesStore]),
  listImageGenModels: (id: string) => Promise.resolve([...(modelsStore[id] ?? [])]),
  listImageGenSamplers: (id: string) => Promise.resolve([...(samplersStore[id] ?? [])]),
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
  // The store is a module singleton shared across files in this worker —
  // leave every map pristine.
  useImageGenChatStore.setState({
    fineTuningByChat: {},
    fineTuningDraftByChat: {},
    activeProfileIdByChat: {},
    runningByChat: {},
  });
});

describe("ImageGenFineTuningChip — the IG-16 gate (IG-17)", () => {
  it("renders nothing while the chat's Fine-tuning toggle is off; appears when it flips on", async () => {
    profilesStore = [profile("p1", "OpenRouter main", noCaps())];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-gate" variant="desktop" />);
    expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(0);
    act(() => armChat("chat-gate"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    // …and the summary label resolves to the effective profile's name.
    await waitFor(() => {
      const chip = view.container.querySelector('[data-testid="image-gen-ft-chip"]');
      expect(chip?.textContent).toContain("OpenRouter main");
    });
  });

  it("the mobile variant shows the same chip when the toggle is on", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-mob" variant="mobile" />);
    act(() => armChat("chat-mob"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    await waitFor(() => {
      const chip = view.container.querySelector('[data-testid="image-gen-ft-chip"]');
      expect(chip?.textContent).toContain("A1111 local");
      // The profile's saved model shows in the summary while no override is set.
      expect(chip?.textContent).toContain("sdxl-base");
    });
  });
});

describe("ImageGenFineTuningChip — editor body (IG-17)", () => {
  it("profile/model/sampler/prompt render; negative + sampler rows are capability-gated OFF for a no-caps profile", async () => {
    profilesStore = [profile("p1", "OpenRouter main", noCaps(), "flux-1")];
    modelsStore = { p1: [{ id: "flux-1", label: "Flux 1" }, { id: "sdxl", label: "SDXL" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-body" variant="desktop" />);
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
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-edit" variant="desktop" />);
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

    const first = renderChip(<ImageGenFineTuningChip chatId="chat-persist" variant="desktop" />);
    await waitFor(() => expect(first.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(first.baseElement).getByTestId("image-gen-ft-prompt")).toBeTruthy());
    expect((within(first.baseElement).getByTestId("image-gen-ft-prompt") as HTMLTextAreaElement).value).toBe("keep me");

    // Remount (same chat, toggle still on) — the value survives.
    first.unmount();
    const second = renderChip(<ImageGenFineTuningChip chatId="chat-persist" variant="desktop" />);
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
