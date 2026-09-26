import { describe, expect, it, mock, afterEach, afterAll, beforeEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import type { AppMessage, ProviderProfileRecord } from "../../api/types.js";

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
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");

mock.module("../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  fetchProviderModelsAction: async () => ({ models: [{ id: "model-a", label: "Model A" }] }),
}));

type ProfileRecord = import("../../api/image-gen-api.js").ImageGenProfileRecord;
type ModelEntry = import("../../api/image-gen-api.js").ImageGenModelEntry;
type SamplerEntry = import("@vibe-tavern/api-contracts").ImageGenSamplerInfoValue;

type Caps = ProfileRecord["capabilities"];

type LoraEntry = import("@vibe-tavern/api-contracts").ImageGenLoraInfoValue;

function fullCaps(): Caps {
  return {
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    supportsSteps: true,
    supportsCfgScale: true,
    supportsClipSkip: true,
    supportsLoras: true,
    supportsHiresFix: true,
    sizeSupport: { kind: "free" },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
  };
}

function noCaps(): Caps {
  return {
    ...fullCaps(),
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    supportsSteps: false,
    supportsCfgScale: false,
    supportsClipSkip: false,
    supportsLoras: false,
    supportsHiresFix: false,
  };
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
    defaultParamsSetId: null,
    modeSizePresets: {},
    llmAssistEnabled: false,
    familySource: "none",
    qualityLayerEnabled: false,
    capabilities,
    isDefault: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let profilesStore: ProfileRecord[] = [];
let promptCapsStore: Array<{ backend: string; modelId: string; maxPromptChars: number }> = [];
let modelsStore: Record<string, ModelEntry[]> = {};
let samplersStore: Record<string, SamplerEntry[]> = {};
let schedulersStore: Record<string, import("@vibe-tavern/api-contracts").ImageGenSchedulerInfoValue[]> = {};
let extensionsStore: Record<string, string[]> = {};
let faceDetectorsStore: Record<string, string[]> = {};
const faceDetectorsFailFor = new Set<string>();
const faceDetectorCalls: string[] = [];
let overlayStore: Record<string, import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue> = {};
let lorasStore: Record<string, LoraEntry[]> = {};
const lorasFailFor = new Set<string>();
let upscalersStore: Record<string, import("../../api/image-gen-api.js").ImageGenUpscaler[]> = {};
const upscalersFailFor = new Set<string>();
let sidecarsStore: Record<string, import("@vibe-tavern/api-contracts").ImageGenDitSidecarsValue> = {};
const sidecarsFailFor = new Set<string>();
const sidecarsCalls: string[] = [];
const generateCalls: Array<[string, import("@vibe-tavern/api-contracts").GenerateImageGenInput]> = [];
const draftPromptCalls: Array<{
  chatId: string;
  body: import("@vibe-tavern/api-contracts").DraftImageGenPromptInput;
  signal: AbortSignal | undefined;
}> = [];
let draftPromptImplementation: (
  chatId: string,
  body: import("@vibe-tavern/api-contracts").DraftImageGenPromptInput,
  signal?: AbortSignal,
) => Promise<import("@vibe-tavern/api-contracts").DraftImageGenPromptResponseValue> = async () => ({ prompt: "drafted prompt" });
const updateProfileCalls: Array<{ id: string; body: import("@vibe-tavern/api-contracts").UpdateImageGenProfileInput }> = [];
const upsertCalls: Array<{
  profileId: string;
  modelId: string;
  settings: import("@vibe-tavern/api-contracts").ImageGenModelSettingsOverlayValue;
}> = [];

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  // FT-A3: the generate call is PARKED (never settles) so the chip's fire
  // path is observable without the downstream chat refresh ever running.
  generateImageGen: (chatId: string, input: import("@vibe-tavern/api-contracts").GenerateImageGenInput) => {
    generateCalls.push([chatId, input]);
    return new Promise<void>(() => {});
  },
  draftImageGenPrompt: (
    chatId: string,
    body: import("@vibe-tavern/api-contracts").DraftImageGenPromptInput,
    signal?: AbortSignal,
  ) => {
    draftPromptCalls.push({ chatId, body, signal });
    return draftPromptImplementation(chatId, body, signal);
  },
  updateImageGenProfile: (id: string, body: import("@vibe-tavern/api-contracts").UpdateImageGenProfileInput) => {
    updateProfileCalls.push({ id, body });
    const current = profilesStore.find((profile) => profile.id === id);
    if (!current) return Promise.reject(new Error("profile missing"));
    return Promise.resolve(current);
  },
  listAllImageGenProfiles: () => Promise.resolve([...profilesStore]),
  // IF-10: the learned prompt-cap table (advisory counter data).
  listImageGenPromptCaps: () => Promise.resolve([...promptCapsStore]),
  listImageGenModels: (id: string) => Promise.resolve([...(modelsStore[id] ?? [])]),
  listImageGenSamplers: (id: string) => Promise.resolve([...(samplersStore[id] ?? [])]),
  listImageGenSchedulers: (id: string) => Promise.resolve([...(schedulersStore[id] ?? [])]),
  listImageGenExtensions: (id: string) => Promise.resolve([...(extensionsStore[id] ?? [])]),
  listImageGenFaceDetectors: (id: string) => {
    faceDetectorCalls.push(id);
    return faceDetectorsFailFor.has(id)
      ? Promise.reject(new Error("detector probe boom"))
      : Promise.resolve([...(faceDetectorsStore[id] ?? [])]);
  },
  listImageGenLoras: (id: string) =>
    lorasFailFor.has(id)
      ? Promise.reject(new Error("lora list boom"))
      : Promise.resolve([...(lorasStore[id] ?? [])]),
  listImageGenUpscalers: (id: string) =>
    upscalersFailFor.has(id)
      ? Promise.reject(new Error("upscaler list boom"))
      : Promise.resolve([...(upscalersStore[id] ?? [])]),
  listImageGenDitSidecars: (id: string) => {
    sidecarsCalls.push(id);
    return sidecarsFailFor.has(id)
      ? Promise.reject(new Error("sidecar list boom"))
      : Promise.resolve(
          sidecarsStore[id]
            ? { encoders: [...sidecarsStore[id].encoders], vaes: [...sidecarsStore[id].vaes] }
            : null,
        );
  },
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

/** Open the chip and pick a concrete model — the model-settings body renders
 *  directly, so every settings field is reachable without a click. */
async function openAccordion(chatId: string, modelLabel = "SDXL Base") {
  const view = renderChip(<ImageGenFineTuningChip chatId={chatId} />);
  openChip();
  await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
  await pickOption("image-gen-ft-model-select", modelLabel);
  await waitFor(() =>
    expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings-body")).toBeTruthy(),
  );
  return view;
}

afterEach(() => {
  cleanup();
  profilesStore = [];
  promptCapsStore = [];
  modelsStore = {};
  samplersStore = {};
  schedulersStore = {};
  extensionsStore = {};
  faceDetectorsStore = {};
  faceDetectorsFailFor.clear();
  faceDetectorCalls.length = 0;
  overlayStore = {};
  lorasStore = {};
  lorasFailFor.clear();
  upscalersStore = {};
  upscalersFailFor.clear();
  sidecarsStore = {};
  sidecarsFailFor.clear();
  sidecarsCalls.length = 0;
  upsertCalls.length = 0;
  mobileOverride = false;
  generateCalls.length = 0;
  draftPromptCalls.length = 0;
  draftPromptImplementation = async () => ({ prompt: "drafted prompt" });
  updateProfileCalls.length = 0;
  useProviderDataStore.setState({ profiles: [], favoritesByProfile: {}, coauthorFavoritesByProfile: {}, copilotFavoritesByProfile: {} });
  // The store is a module singleton shared across files in this worker —
  // leave every map pristine.
  useImageGenChatStore.setState({
    fineTuningByChat: {},
    fineTuningDraftByChat: {},
    activeProfileIdByChat: {},
    runningByChat: {},
  });
  clipboardCalls.length = 0;
});

// Clipboard seam for the CG-C3 trigger-copy test (R3: patch between tests,
// restore the captured original in afterAll — navigator is global).
const clipboardCalls: string[] = [];
const realClipboard: Clipboard | undefined = navigator.clipboard;
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (text: string) => {
        clipboardCalls.push(text);
        return Promise.resolve();
      },
    },
    configurable: true,
  });
});
afterAll(() => {
  if (realClipboard === undefined) {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  } else {
    Object.defineProperty(navigator, "clipboard", { value: realClipboard, configurable: true });
  }
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

function providerProfile(): ProviderProfileRecord {
  return {
    id: "llm-p1", name: "Prompt writer", providerPreset: "openai", coauthorTransport: "chat_completions", generationMode: "chat", endpoint: "https://api.example.test/v1",
    defaultModel: "model-a", visionModel: null, temperature: 1, topP: 1, minP: 0, topK: 0, topA: 0,
    typicalP: 1, tfsZ: 1, adaptiveTarget: -1, adaptiveDecay: 0.9, dynatempRange: 0, dynatempExponent: 1, topNSigma: 0, smoothingFactor: 0, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1, drySequenceBreakers: [], bannedStrings: [], xtcThreshold: 0.1,
    xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, maxTokens: 2048,
    contextBudget: 16000, pinContextBudget: false, tokenPadding: 0, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false,
    stopSequences: [], logitBias: [], seed: null, reasoningEffort: "auto", showReasoning: false, streamResponse: true,
    customSamplers: false, proxyMode: "inherit", proxyId: null, samplerSetId: null, generationFormat: null, isActive: true, hasStoredApiKey: true,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

describe("ImageGenFineTuningChip — AI quick pill (FT-B1)", () => {
  it("renders the two pill zones; its gear opens the profile's assist pick and saves changes through the profile PATCH seam", async () => {
    profilesStore = [{
      ...profile("p1", "Image profile", noCaps()),
      llmAssistEnabled: true,
      llmProviderProfileId: "llm-p1",
      llmModelId: "model-a",
    }];
    useProviderDataStore.setState({ profiles: [providerProfile()] });
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-b1" />);
    act(() => armChat("chat-b1"));
    openChip();
    const promptRow = await waitFor(() => within(view.baseElement).getByTestId("image-gen-ft-prompt").parentElement as HTMLElement);
    const pillButtons = within(promptRow).getAllByRole("button");
    expect(pillButtons).toHaveLength(2);

    await act(async () => { fireEvent.click(pillButtons[1]!); });
    await waitFor(() => expect(within(view.baseElement).getByText("Prompt writer")).toBeTruthy());

    await act(async () => { fireEvent.click(within(view.baseElement).getByText("done_btn")); });
    await waitFor(() => expect(updateProfileCalls).toEqual([{
      id: "p1",
      body: { llmAssistEnabled: true, llmProviderProfileId: "llm-p1", llmModelId: "model-a" },
    }]));
  });
});

describe("ImageGenFineTuningChip — AI prompt draft (FT-B2)", () => {
  it("star drafts into the positive field and writes a negative only when the profile supports it", async () => {
    profilesStore = [{
      ...profile("p1", "Image profile", fullCaps()),
      llmAssistEnabled: true,
      llmProviderProfileId: "llm-p1",
      llmModelId: "model-a",
    }];
    draftPromptImplementation = async () => ({ prompt: "English portrait prompt", negativePrompt: "blurry" });
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-b2-fill" />);
    act(() => armChat("chat-b2-fill"));
    act(() => useImageGenChatStore.getState().setFineTuningDraft("chat-b2-fill", { target: "portrait" }));
    openChip();
    const promptRow = await waitFor(() => within(view.baseElement).getByTestId("image-gen-ft-prompt").parentElement as HTMLElement);
    await act(async () => { fireEvent.click(within(promptRow).getAllByRole("button")[0]!); });
    await waitFor(() => expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-b2-fill"]).toEqual({
      prompt: "English portrait prompt",
      negative: "blurry",
      target: "portrait",
    }));
    expect(draftPromptCalls).toHaveLength(1);
    expect(draftPromptCalls[0]!.body).toEqual({ profileId: "p1", mode: "portrait" });

    cleanup();
    profilesStore = [{ ...profile("p2", "No negative", noCaps()), llmAssistEnabled: true, llmProviderProfileId: "llm-p1", llmModelId: "model-a" }];
    draftPromptImplementation = async () => ({ prompt: "Only positive", negativePrompt: "ignored negative" });
    const noNegative = renderChip(<ImageGenFineTuningChip chatId="chat-b2-no-negative" />);
    act(() => armChat("chat-b2-no-negative"));
    act(() => useImageGenChatStore.getState().setFineTuningDraft("chat-b2-no-negative", { target: "portrait" }));
    openChip();
    const noNegativeRow = await waitFor(() => within(noNegative.baseElement).getByTestId("image-gen-ft-prompt").parentElement as HTMLElement);
    await act(async () => { fireEvent.click(within(noNegativeRow).getAllByRole("button")[0]!); });
    await waitFor(() => expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-b2-no-negative"]).toEqual({
      prompt: "Only positive",
      negative: "",
      target: "portrait",
    }));
  });

  it("a second star click aborts the in-flight draft", async () => {
    profilesStore = [{ ...profile("p1", "Image profile", noCaps()), llmAssistEnabled: true, llmProviderProfileId: "llm-p1", llmModelId: "model-a" }];
    draftPromptImplementation = async (_chatId, _body, signal) => await new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-b2-cancel" />);
    act(() => armChat("chat-b2-cancel"));
    act(() => useImageGenChatStore.getState().setFineTuningDraft("chat-b2-cancel", { target: "portrait" }));
    openChip();
    const promptRow = await waitFor(() => within(view.baseElement).getByTestId("image-gen-ft-prompt").parentElement as HTMLElement);
    const star = within(promptRow).getAllByRole("button")[0]!;
    await act(async () => { fireEvent.click(star); });
    await waitFor(() => expect(draftPromptCalls).toHaveLength(1));
    const cancel = within(promptRow).getAllByRole("button")[0]!;
    await act(async () => { fireEvent.click(cancel); });
    await waitFor(() => expect(draftPromptCalls[0]!.signal?.aborted).toBe(true));
  });
});

describe("ImageGenFineTuningChip — editor body (IG-17)", () => {
  it("profile/model/prompt render; the negative row is capability-gated OFF for a no-caps profile", async () => {
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
    // No-caps profile: the gated row never renders.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-negative-row")).toBeNull();
    // FT-A1: the one-shot sampler row is gone everywhere (the model-settings
    // accordion is the only sampler surface).
    expect(within(view.baseElement).queryByTestId("image-gen-ft-sampler-row")).toBeNull();
  });

  it("IF-10: the learned-cap counter renders for the effective model only — advisory, red past the cap, absent without a row", async () => {
    profilesStore = [profile("p1", "Cloud main", noCaps(), "qwen-image")];
    modelsStore = { p1: [{ id: "qwen-image", label: "Qwen Image" }, { id: "other", label: "Other" }] };

    // No learned row (or a row for a DIFFERENT model) → no counter at all.
    promptCapsStore = [{ backend: "openrouter", modelId: "unrelated-model", maxPromptChars: 900 }];
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-cap" />);
    act(() => armChat("chat-cap"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-prompt")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-prompt-cap")).toBeNull();
    cleanup();

    // A learned row for the effective model → the live counter appears.
    promptCapsStore = [{ backend: "openrouter", modelId: "qwen-image", maxPromptChars: 1200 }];
    const armed = renderChip(<ImageGenFineTuningChip chatId="chat-cap2" />);
    act(() => armChat("chat-cap2"));
    await waitFor(() => expect(armed.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(armed.baseElement).getByTestId("image-gen-ft-prompt-cap")).toBeTruthy());
    const counter = within(armed.baseElement).getByTestId("image-gen-ft-prompt-cap");
    expect(counter.textContent).toBe("0 / 1200");
    expect(counter.className).not.toContain("text-danger");

    // Typing past the cap → the counter goes red (advisory — the send stays
    // enabled; the counter is a warning, never a gate).
    fireEvent.change(within(armed.baseElement).getByTestId("image-gen-ft-prompt"), {
      target: { value: "x".repeat(1300) },
    });
    await waitFor(() => {
      expect(within(armed.baseElement).getByTestId("image-gen-ft-prompt-cap").textContent).toBe("1300 / 1200");
    });
    expect(within(armed.baseElement).getByTestId("image-gen-ft-prompt-cap").className).toContain("text-danger");
  });

  it("a caps profile renders the negative row; edits write the per-chat draft (FT-A1: no one-shot sampler row)", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }, { id: "pony-v6", label: "Pony V6" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-edit" />);
    act(() => armChat("chat-edit"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-negative-row")).toBeTruthy());
    // FT-A1 pin: even a full-samplers profile renders NO one-shot row.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-sampler-row")).toBeNull();

    fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-prompt"), {
      target: { value: "a castle at dawn" },
    });
    fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-negative"), {
      target: { value: "blurry, lowres" },
    });
    await pickOption("image-gen-ft-model-select", "Pony V6");

    const draft = useImageGenChatStore.getState().fineTuningDraftByChat["chat-edit"];
    expect(draft).toEqual({
      prompt: "a castle at dawn",
      negative: "blurry, lowres",
      model: "pony-v6",
    });
  });

  it("switching profiles clears the picked model and returns the trigger to its default entry", async () => {
    profilesStore = [
      profile("p1", "First profile", fullCaps(), "first-default"),
      profile("p2", "Second profile", fullCaps(), "second-default"),
    ];
    modelsStore = {
      p1: [
        { id: "first-default", label: "First default" },
        { id: "foreign-picked", label: "Foreign picked model" },
      ],
      p2: [{ id: "second-default", label: "Second default" }],
    };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-profile-switch" />);
    act(() => armChat("chat-profile-switch"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await pickOption("image-gen-ft-model-select", "Foreign picked model");
    expect(within(view.baseElement).getByTestId("image-gen-ft-model-select").textContent).toContain(
      "Foreign picked model",
    );

    await pickOption("image-gen-ft-profile-select", "Second profile");

    await waitFor(() => {
      expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-profile-switch"]?.model).toBeUndefined();
      const modelTrigger = within(view.baseElement).getByTestId("image-gen-ft-model-select");
      expect(modelTrigger.textContent).toContain("image_gen_chip_model_default");
      expect(modelTrigger.textContent).not.toContain("Foreign picked model");
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

describe("ImageGenFineTuningChip — target + resolution (FT-A2)", () => {
  it("target selector lists the six registry modes with Free as the display default; switching preselects the profile's per-mode preset", async () => {
    profilesStore = [
      {
        ...profile("p1", "A1111 local", fullCaps(), "sdxl-base"),
        modeSizePresets: { portrait: { width: 832, height: 1216 } },
      },
    ];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-t2a" />);
    act(() => armChat("chat-t2a"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-target-select")).toBeTruthy());
    // Display default = Free; nothing committed to the draft yet.
    expect(within(view.baseElement).getByTestId("image-gen-ft-target-select").textContent).toContain("image_gen_mode_free");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2a"]).toBeUndefined();

    // The six registry modes ride the opened list (the message popover's
    // list — no new names).
    await pickOption("image-gen-ft-target-select", "image_gen_mode_portrait");
    const draft = useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2a"];
    expect(draft?.target).toBe("portrait");
    // The mode's profile preset preselected (changeable — the dropdown is
    // free to overwrite it below).
    expect(draft?.width).toBe(832);
    expect(draft?.height).toBe(1216);
  });

  it("resolution: a bucket pick writes W/H, Auto clears, Custom reveals the steppers", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-t2b" />);
    act(() => armChat("chat-t2b"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-resolution-select")).toBeTruthy());
    // Custom steppers hidden while a bucket is not custom.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-custom-size")).toBeNull();

    // Square bucket (unique label under the key-mock t) — the 1:1 pair.
    await pickOption("image-gen-ft-resolution-select", "image_gen_preset_square");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2b"]).toEqual({
      prompt: "",
      negative: "",
      width: 1024,
      height: 1024,
    });

    // Custom reveals the W/H steppers — and STAYS custom even though the
    // seeded pair equals the square bucket (the explicit-mode pin).
    await pickOption("image-gen-ft-resolution-select", "image_gen_size_custom");
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-custom-size")).toBeTruthy());
    expect((within(view.baseElement).getByTestId("image-gen-ft-width").querySelector("input") as HTMLInputElement).value).toBe("1024");

    // A stepper click commits the new width to the draft (the PLUS button —
    // minus renders first in the DOM).
    const steppers = within(view.baseElement).getByTestId("image-gen-ft-width").querySelectorAll("button");
    fireEvent.click(steppers[steppers.length - 1]!);
    await waitFor(() =>
      expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2b"]?.width).toBe(1088),
    );
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2b"]?.customSize).toBe(true);

    // Auto clears the pair entirely (server-side mode preset resolves).
    await pickOption("image-gen-ft-resolution-select", "image_gen_size_auto");
    const draft = useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2b"];
    expect(draft?.width).toBeUndefined();
    expect(draft?.height).toBeUndefined();
    expect(draft?.customSize).toBeUndefined();
  });

  it("vendor-set profile: the announced grid ∪ user sizes, NO Custom entry", async () => {
    profilesStore = [
      {
        ...profile("p1", "Cloud vendor", { ...fullCaps(), sizeSupport: { kind: "vendor-set", sizes: ["1024x1024", "768x1344"] } }, "flux-1"),
        userSizes: [{ width: 512, height: 512 }],
      },
    ];
    modelsStore = { p1: [{ id: "flux-1", label: "Flux 1" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-t2c" />);
    act(() => armChat("chat-t2c"));
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-resolution-select")).toBeTruthy());

    await pickOption("image-gen-ft-resolution-select", "512×512");
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-t2c"]).toEqual({
      prompt: "",
      negative: "",
      width: 512,
      height: 512,
    });
    // The custom stepper pair never renders for vendor-set dialects.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-custom-size")).toBeNull();
  });
});

describe("ImageGenFineTuningChip — Generate button (FT-A3)", () => {
  // Two messages in the REAL snapshot store (the tail = m2) — captured
  // before, restored in afterAll (the store is a module singleton across
  // files in this worker).
  const snapshotBefore = useSnapshotStore.getState();
  // Distinct chat ids per test: the parked generate promise keeps the
  // runGeneration guard armed for THAT chat (controllers map is module-level).
  const chatA = "chat-ft3a";
  const chatB = "chat-ft3b";
  const createdAt = "2026-09-19T00:00:00.000Z";
  function message(id: string, position: number): AppMessage {
    const messageId = brandId<MessageId>(id);
    return {
      chatId: brandId<ChatId>(chatA),
      branchId: brandId<ChatBranchId>("branch_ft3"),
      modelId: null,
      sceneTracker: null,
      state: "complete",
      createdAt,
      updatedAt: createdAt,
      id: messageId,
      role: "assistant",
      authorType: "assistant",
      position,
      content: `message ${id}`,
      variants: [
        {
          id: brandId<MessageVariantId>(`${id}_v1`),
          messageId,
          variantIndex: 0,
          content: `message ${id}`,
          isSelected: true,
          finishReason: null,
          createdAt,
        },
      ],
      selectedVariantIndex: 0,
    };
  }
  beforeEach(() => {
    useSnapshotStore.setState({
      messageOrder: ["ft3_m1", "ft3_m2"],
      messagesById: { ft3_m1: message("ft3_m1", 0), ft3_m2: message("ft3_m2", 1) },
    });
  });
  afterAll(() => {
    useSnapshotStore.setState(snapshotBefore);
  });

  it("fires the shared fold: target mode, tail anchor, prompt verbatim, size overrides — and closes the editor", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }] };
    act(() => armChat(chatA));
    useImageGenChatStore.getState().setFineTuningDraft(chatA, {
      prompt: "  a castle at dawn  ",
      width: 832,
      height: 1216,
    });
    // FT-A5: enabled loras ride the SAME fold — draft chain order, strength
    // verbatim (the backend stamps the <lora:…> tags from this payload).
    useImageGenChatStore.getState().setFineTuningLoraEnabled(chatA, "nijireol_krea2_v1_ep5", true);
    useImageGenChatStore.getState().setFineTuningLoraStrength(chatA, "nijireol_krea2_v1_ep5", 0.7);
    // FT-A6: the hires block rides capability-gated — enabled + only the
    // SET knobs (denoise unset here: absent in the payload, the FT-A4
    // server-defaults rule).
    useImageGenChatStore.getState().setFineTuningHires(chatA, {
      enabled: true,
      upscaler: "Latent",
      steps: 18,
      scale: 1.5,
    });
    const view = renderChip(<ImageGenFineTuningChip chatId={chatA} />);
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    const button = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-generate");
      expect((el as HTMLButtonElement).disabled).toBe(false);
      return el as HTMLButtonElement;
    });
    act(() => {
      fireEvent.click(button);
    });
    expect(generateCalls.length).toBe(1);
    const [calledChat, input] = generateCalls[0]!;
    expect(calledChat).toBe(chatA);
    // Default target = free; prompt verbatim (IG-14); anchor = the TAIL
    // message; the FT-A2 resolution + the FT-A5 lora chain ride the overrides.
    expect(input.mode).toBe("free");
    expect(input.prompt).toBe("a castle at dawn");
    expect(input.anchorMessageId).toBe("ft3_m2");
    expect(input.overrides).toEqual({
      width: 832,
      height: 1216,
      loras: [{ name: "nijireol_krea2_v1_ep5", strength: 0.7 }],
      hires: { upscaler: "Latent", steps: 18, scale: 1.5 },
    });
    // The editor closes after firing (the chip's own onDone twin).
    await waitFor(() => expect(within(view.baseElement).queryByTestId("image-gen-ft-body")).toBeNull());
  });

  it("an empty Free chip prompt fires the active profile template path", async () => {
    profilesStore = [profile("p1", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { p1: [{ id: "sdxl-base", label: "SDXL Base" }] };
    act(() => armChat(chatB));
    useImageGenChatStore.getState().setFineTuningDraft(chatB, { target: "free" });
    const view = renderChip(<ImageGenFineTuningChip chatId={chatB} />);
    await waitFor(() => expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1));
    openChip();
    const button = await waitFor(() => within(view.baseElement).getByTestId("image-gen-ft-generate") as HTMLButtonElement);
    expect(button.disabled).toBe(false);
    act(() => {
      fireEvent.click(button);
    });
    expect(generateCalls.length).toBe(1);
    expect(generateCalls[0]![1].mode).toBe("free");
    expect(generateCalls[0]![1].prompt).toBeUndefined();
  });
});

describe("ImageGenFineTuningChip — LoRA section (CG-C3)", () => {
  function comfyProfile(chatId: string): void {
    profilesStore = [{ ...profile("cg1", "Comfy local", fullCaps(), "krea2ray"), backend: "comfyui" }];
    act(() => armChat(chatId));
  }

  function seedLoras(): void {
    lorasStore = {
      cg1: [
        { name: "nijireol_krea2_v1_ep5.safetensors", family: "Krea 2", triggerWords: ["Nijireol"] },
        { name: "kreaDraw_v2.safetensors", family: "Krea 2", triggerWords: [] },
        { name: "arden_il.safetensors", family: null, triggerWords: [] },
        { name: "dragonPony.safetensors", family: "SDXL", triggerWords: ["Dragon", "dragon lord"] },
      ],
    };
  }

  async function openSection(chatId: string) {
    const view = renderChip(<ImageGenFineTuningChip chatId={chatId} />);
    openChip();
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-loras-header")).toBeTruthy(),
    );
    await act(async () => {
      within(view.baseElement).getByTestId("image-gen-ft-loras-header").click();
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-loras-body")).toBeTruthy(),
    );
    return view;
  }

  function rows(view: ReturnType<typeof renderChip>): HTMLElement[] {
    return within(view.baseElement).getAllByTestId("image-gen-ft-lora-row");
  }

  it("renders ONLY for a supportsLoras profile — false hides, absent (= false) hides too", async () => {
    comfyProfile("chat-lr0");
    seedLoras();
    let view = await openSection("chat-lr0");
    expect(within(view.baseElement).getByTestId("image-gen-ft-loras")).toBeTruthy();
    cleanup();

    profilesStore = [{ ...profile("cg2", "Cloud", noCaps()), backend: "openrouter" }];
    act(() => armChat("chat-lr0"));
    view = renderChip(<ImageGenFineTuningChip chatId="chat-lr0" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-loras")).toBeNull();
    cleanup();

    // Absent key = false (optional flag semantics — the registry grades it).
    const caps = fullCaps();
    delete caps.supportsLoras;
    profilesStore = [{ ...profile("cg3", "Snapshot", caps), backend: "comfyui" }];
    view = renderChip(<ImageGenFineTuningChip chatId="chat-lr0" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-loras")).toBeNull();
  });

  it("family filter AUTO-PRESELECTS the effective model's family; «Неизвестно» and search narrow", async () => {
    comfyProfile("chat-lr1");
    seedLoras();
    modelsStore = {
      cg1: [
        { id: "krea2ray", label: "Ray Krea", family: "Krea 2" },
        { id: "pony", label: "Pony", family: "Pony" },
      ],
    };

    const view = await openSection("chat-lr1");
    // The profile's model is krea2ray → family "Krea 2" auto-preselected:
    // only the two Krea loras render (dragonPony is SDXL, arden unknown).
    await waitFor(() => expect(rows(view).length).toBe(2));
    expect(rows(view).map((r) => r.dataset.lora)).toEqual([
      "nijireol_krea2_v1_ep5.safetensors",
      "kreaDraw_v2.safetensors",
    ]);

    // «Неизвестно» — the null-family bucket only.
    await pickOption("image-gen-ft-loras-family", "image_gen_loras_family_unknown");
    await waitFor(() => expect(rows(view).length).toBe(1));
    expect(rows(view)[0]!.dataset.lora).toBe("arden_il.safetensors");

    // Back to all + search narrows by name substring.
    await pickOption("image-gen-ft-loras-family", "image_gen_loras_family_all");
    await waitFor(() => expect(rows(view).length).toBe(4));
    await act(async () => {
      fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-loras-search"), {
        target: { value: "nij" },
      });
    });
    await waitFor(() => expect(rows(view).length).toBe(1));
    expect(rows(view)[0]!.dataset.lora).toBe("nijireol_krea2_v1_ep5.safetensors");
  });

  it("enable → strength → disable write the draft; a lora without triggers shows NO trigger button", async () => {
    comfyProfile("chat-lr2");
    seedLoras();
    modelsStore = { cg1: [{ id: "krea2ray", label: "Ray Krea", family: "Krea 2" }] };

    const view = await openSection("chat-lr2");
    await waitFor(() => expect(rows(view).length).toBe(2));
    const nijiRow = rows(view).find((r) => r.dataset.lora === "nijireol_krea2_v1_ep5.safetensors")!;
    // No-trigger lora renders no button at all.
    expect(within(nijiRow.parentElement as HTMLElement).getAllByTestId("image-gen-ft-lora-row").length).toBe(2);
    const kreaRow = rows(view).find((r) => r.dataset.lora === "kreaDraw_v2.safetensors")!;
    expect(kreaRow.querySelector('[data-testid="image-gen-ft-lora-triggers"]')).toBeNull();

    const toggle = within(nijiRow).getByRole("switch", { name: "nijireol_krea2_v1_ep5.safetensors" });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-lr2"]?.loras).toEqual([
      { name: "nijireol_krea2_v1_ep5.safetensors", strength: 1 },
    ]);

    // Enabled → the strength slider appears IN the row; 1.2 writes in place.
    const slider = within(nijiRow).getByRole("slider");
    await act(async () => {
      fireEvent.change(slider, { target: { value: "1.2" } });
    });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-lr2"]?.loras).toEqual([
      { name: "nijireol_krea2_v1_ep5.safetensors", strength: 1.2 },
    ]);

    // Disable removes the entry (emptied chain stays []).
    await act(async () => {
      fireEvent.click(within(nijiRow).getByRole("switch", { name: "nijireol_krea2_v1_ep5.safetensors" }));
    });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-lr2"]?.loras).toEqual([]);
  });

  it("trigger click COPIES the joined words and NEVER touches the prompt (no auto-insert)", async () => {
    comfyProfile("chat-lr3");
    seedLoras();
    modelsStore = { cg1: [{ id: "krea2ray", label: "Ray Krea", family: "Krea 2" }] };

    const view = await openSection("chat-lr3");
    await waitFor(() => expect(rows(view).length).toBe(2));
    const nijiRow = rows(view).find((r) => r.dataset.lora === "nijireol_krea2_v1_ep5.safetensors")!;
    await act(async () => {
      within(nijiRow).getByTestId("image-gen-ft-lora-triggers").click();
    });
    expect(clipboardCalls).toEqual(["Nijireol"]);
    // The owner's no-auto-insert ruling: the prompt stays untouched.
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-lr3"]?.prompt ?? "").toBe("");

    // Multi-word join: the SDXL dragon lora (family filter → all first).
    await pickOption("image-gen-ft-loras-family", "image_gen_loras_family_all");
    await waitFor(() => expect(rows(view).length).toBe(4));
    const dragonRow = rows(view).find((r) => r.dataset.lora === "dragonPony.safetensors")!;
    // Truncation contract: the row may clip the chip, but the FULL joined
    // words stay reachable in the tooltip.
    const dragonBtn = within(dragonRow).getByTestId("image-gen-ft-lora-triggers");
    expect(dragonBtn.title).toBe("Dragon, dragon lord");
    await act(async () => {
      dragonBtn.click();
    });
    expect(clipboardCalls).toEqual(["Nijireol", "Dragon, dragon lord"]);
  });

  it("a failed lora fetch shows the failed hint, not a crash", async () => {
    comfyProfile("chat-lr4");
    lorasFailFor.add("cg1");
    const view = await openSection("chat-lr4");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-loras-failed")).toBeTruthy(),
    );
    expect(within(view.baseElement).queryByTestId("image-gen-ft-loras-list")).toBeNull();
  });
});

describe("ImageGenFineTuningChip — hires-fix block (FT-A6)", () => {
  function forgeProfile(chatId: string): void {
    profilesStore = [{ ...profile("a1", "Forge local", fullCaps()), backend: "a1111" }];
    act(() => armChat(chatId));
  }

  function seedUpscalers(): void {
    upscalersStore = { a1: [{ name: "Latent" }, { name: "4x-UltraSharp" }, { name: "R-ESRGAN 4x+" }] };
  }

  it("renders ONLY for a supportsHiresFix profile — false hides, absent (= false) hides too", async () => {
    forgeProfile("chat-hr0");
    let view = renderChip(<ImageGenFineTuningChip chatId="chat-hr0" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-hires")).toBeTruthy());
    cleanup();

    profilesStore = [{ ...profile("a2", "No hires", { ...fullCaps(), supportsHiresFix: false }), backend: "a1111" }];
    view = renderChip(<ImageGenFineTuningChip chatId="chat-hr0" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-hires")).toBeNull();
    cleanup();

    // Absent key = false (optional flag semantics — the supportsLoras twin).
    const caps = fullCaps();
    delete caps.supportsHiresFix;
    profilesStore = [{ ...profile("a3", "Snapshot", caps), backend: "a1111" }];
    view = renderChip(<ImageGenFineTuningChip chatId="chat-hr0" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-hires")).toBeNull();
  });

  it("collapsed when off; the toggle reveals the knobs; the four SEPARATE knobs write the draft and persist through toggle-off", async () => {
    forgeProfile("chat-hr1");
    seedUpscalers();
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-hr1" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-hires")).toBeTruthy());
    // Collapsed when off (the plan's acceptance line).
    expect(within(view.baseElement).queryByTestId("image-gen-ft-hires-body")).toBeNull();

    await act(async () => {
      fireEvent.click(within(view.baseElement).getByRole("switch", { name: "image_gen_hires_label" }));
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-hires-body")).toBeTruthy(),
    );
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-hr1"]?.hires).toEqual({
      enabled: true,
    });

    // Upscaler pick writes the draft (Auto = the {id:""} entry → unset).
    await pickOption("image-gen-ft-hires-upscaler", "4x-UltraSharp");
    await waitFor(() =>
      expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-hr1"]?.hires).toEqual({
        enabled: true,
        upscaler: "4x-UltraSharp",
      }),
    );
    // The three sliders commit on interaction (display anchors are server
    // defaults — untouched knobs stay unset).
    await act(async () => {
      fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-hires-steps"), {
        target: { value: "18" },
      });
    });
    await act(async () => {
      fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-hires-scale"), {
        target: { value: "1.5" },
      });
    });
    await act(async () => {
      fireEvent.change(within(view.baseElement).getByTestId("image-gen-ft-hires-denoise"), {
        target: { value: "0.6" },
      });
    });
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-hr1"]?.hires).toEqual({
      enabled: true,
      upscaler: "4x-UltraSharp",
      steps: 18,
      scale: 1.5,
      denoisingStrength: 0.6,
    });

    // Toggle off: collapsed again, but the knobs PERSIST in the draft
    // (draft-level like every chip field — nothing is thrown away).
    await act(async () => {
      fireEvent.click(within(view.baseElement).getByRole("switch", { name: "image_gen_hires_label" }));
    });
    expect(within(view.baseElement).queryByTestId("image-gen-ft-hires-body")).toBeNull();
    expect(useImageGenChatStore.getState().fineTuningDraftByChat["chat-hr1"]?.hires).toEqual({
      enabled: false,
      upscaler: "4x-UltraSharp",
      steps: 18,
      scale: 1.5,
      denoisingStrength: 0.6,
    });
  });

  it("wire fields per FT-A4: enabled + no knobs fires plain enable_hr ({}); a no-caps profile strips the block", async () => {
    forgeProfile("chat-hr2");
    useImageGenChatStore.getState().setFineTuningDraft("chat-hr2", { prompt: "a keep on a cliff" });
    useImageGenChatStore.getState().setFineTuningHires("chat-hr2", { enabled: true });
    let view = renderChip(<ImageGenFineTuningChip chatId="chat-hr2" />);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1),
    );
    openChip();
    const fire1 = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-generate");
      expect((el as HTMLButtonElement).disabled).toBe(false);
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(fire1);
    });
    expect(generateCalls.length).toBe(1);
    // Presence alone = plain enable_hr — every unset knob stays unset so
    // server defaults fill (the FT-A4 presence rule).
    expect(generateCalls[0]![1].overrides).toEqual({ hires: {} });
    cleanup();

    // A profile without the flag never sees the block on the wire (the
    // capability gate at the fold — the loras strip twin). The phase-1 run
    // is PARKED forever by the mock (R5) — the store's controllers map
    // still holds chat-hr2, so a second fire NEEDS a different chatId (the
    // FT-A3 module-map mechanism), and the running map is reset to keep
    // the button enabled.
    profilesStore = [{ ...profile("a4", "Cloud", noCaps()), backend: "openrouter" }];
    useImageGenChatStore.setState({ runningByChat: {} });
    act(() => armChat("chat-hr2b"));
    useImageGenChatStore.getState().setFineTuningDraft("chat-hr2b", { prompt: "a keep on a cliff" });
    useImageGenChatStore.getState().setFineTuningHires("chat-hr2b", {
      enabled: true,
      steps: 18,
      denoisingStrength: 0.6,
    });
    view = renderChip(<ImageGenFineTuningChip chatId="chat-hr2b" />);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="image-gen-ft-chip"]').length).toBe(1),
    );
    openChip();
    const fire2 = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-generate");
      expect((el as HTMLButtonElement).disabled).toBe(false);
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(fire2);
    });
    expect(generateCalls.length).toBe(2);
    // No overrides key at all — the block never rides for an unsupported profile.
    expect(generateCalls[1]![1].overrides).toBeUndefined();
  });

  it("a failed upscaler fetch degrades to the failed hint beside the Auto dropdown — no crash", async () => {
    forgeProfile("chat-hr3");
    upscalersFailFor.add("a1");
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-hr3" />);
    openChip();
    const toggle = await waitFor(() =>
      within(view.baseElement).getByRole("switch", { name: "image_gen_hires_label" }),
    );
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-hires-failed")).toBeTruthy(),
    );
    // The knob rows still render (the loras-failed precedent).
    expect(within(view.baseElement).getByTestId("image-gen-ft-hires-steps")).toBeTruthy();
    expect(within(view.baseElement).getByTestId("image-gen-ft-hires-scale")).toBeTruthy();
    expect(within(view.baseElement).getByTestId("image-gen-ft-hires-denoise")).toBeTruthy();
  });
});

describe("ImageGenFineTuningChip — model settings (IG-CF15 15d)", () => {
  it("renders ONLY when a concrete model is picked — the default-model state has no settings block", async () => {
    profilesStore = [profile("ig1", "Local Forge", fullCaps())];
    modelsStore["ig1"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    armChat("chat-ms1");

    const view = renderChip(<ImageGenFineTuningChip chatId="chat-ms1" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
    expect(within(view.baseElement).queryByTestId("image-gen-ft-model-settings")).toBeNull();

    await pickOption("image-gen-ft-model-select", "SDXL Base");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings-body")).toBeTruthy(),
    );
    const header = within(view.baseElement).getByTestId("image-gen-ft-model-settings-header");
    expect(header.tagName).toBe("DIV");
    expect(header.textContent).toBe("image_gen_model_settings");
  });

  it("overlay edits merge over the loaded row and persist through upsert (one truth, two surfaces)", async () => {
    profilesStore = [profile("ig1", "Local Forge", fullCaps())];
    modelsStore["ig1"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    overlayStore["ig1/sdxl-base"] = { sampler: "Euler a", steps: 20 };
    armChat("chat-ms2");

    const view = await openAccordion("chat-ms2");
    // The sampler trigger and scalar slider are directly reachable after the
    // model pick; no model-settings toggle is required.
    expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-sampler")).toBeTruthy();
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

  it("T4/T5 (TWIN_UNIFICATION step 3): sliders honor the caps MIRROR ranges; seed garbage commits NOTHING", async () => {
    profilesStore = [
      {
        ...profile("mr1", "Mirror Forge", { ...fullCaps(), supportsClipSkip: false, paramRanges: { steps: { min: 2, max: 60, step: 2 } } }, "m-alpha"),
        backend: "a1111",
      },
    ];
    modelsStore["mr1"] = [{ id: "m-alpha", label: "Mirror Alpha" }];
    armChat("chat-mirror");
    const view = await openAccordion("chat-mirror", "Mirror Alpha");

    // T4: the steps slider rides the MIRROR override — the chip's old
    // global-only read (the silent drift) is dead; cfg (absent from the
    // mirror) still anchors at the global default.
    const steps = within(view.baseElement).getByTestId("image-gen-range-overlay-steps") as HTMLInputElement;
    expect(steps.getAttribute("min")).toBe("2");
    expect(steps.getAttribute("max")).toBe("60");
    expect(steps.getAttribute("step")).toBe("2");
    const cfg = within(view.baseElement).getByTestId("image-gen-range-overlay-cfg") as HTMLInputElement;
    expect(cfg.getAttribute("min")).toBe("1");
    expect(cfg.getAttribute("max")).toBe("30");
    expect(within(view.baseElement).queryByTestId("image-gen-range-overlay-clip")).toBeNull();

    // T5: typing garbage commits NOTHING (the old chip wiped the seed on
    // non-numeric input — the named behavior change of this step); a clean
    // number still commits.
    const seedInput = within(view.baseElement).getByTestId("image-gen-ft-overlay-seed") as HTMLInputElement;
    const before = upsertCalls.length;
    await act(async () => {
      fireEvent.change(seedInput, { target: { value: "12abc" } });
    });
    expect(upsertCalls.length).toBe(before);
    await act(async () => {
      fireEvent.change(seedInput, { target: { value: "42" } });
    });
    await waitFor(() => expect(upsertCalls.length).toBe(before + 1));
    expect(upsertCalls[upsertCalls.length - 1]!.settings).toEqual({ seed: 42 });

    await act(async () => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-ft-random-seed"));
    });
    await waitFor(() => expect(upsertCalls.length).toBe(before + 2));
    const randomSeed = Number(seedInput.value);
    expect(Number.isInteger(randomSeed)).toBe(true);
    expect(randomSeed).toBeGreaterThanOrEqual(0);
    expect(randomSeed).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(upsertCalls[upsertCalls.length - 1]!.settings).toEqual({ seed: randomSeed });
  });

  it("capability gates remove dead scalar controls while retaining only supported seed fields", async () => {
    profilesStore = [
      {
        ...profile("krea-gate", "Krea", { ...noCaps(), supportsSeed: true }, "krea/krea-2/medium"),
        backend: "krea",
      },
    ];
    modelsStore["krea-gate"] = [{ id: "krea/krea-2/medium", label: "Krea 2" }];
    armChat("chat-krea-gate");
    let view = await openAccordion("chat-krea-gate", "Krea 2");
    for (const id of ["image-gen-range-overlay-steps", "image-gen-range-overlay-cfg", "image-gen-range-overlay-clip"]) {
      expect(within(view.baseElement).queryByTestId(id)).toBeNull();
    }
    expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-seed")).toBeTruthy();
    cleanup();

    profilesStore = [{ ...profile("luma-gate", "Luma", noCaps(), "ray-2"), backend: "luma" }];
    modelsStore["luma-gate"] = [{ id: "ray-2", label: "Ray 2" }];
    armChat("chat-luma-gate");
    view = await openAccordion("chat-luma-gate", "Ray 2");
    for (const id of ["image-gen-range-overlay-steps", "image-gen-range-overlay-cfg", "image-gen-range-overlay-clip", "image-gen-ft-overlay-seed"]) {
      expect(within(view.baseElement).queryByTestId(id)).toBeNull();
    }
    cleanup();

    profilesStore = [{ ...profile("comfy-gate", "ComfyUI", fullCaps(), "sdxl"), backend: "comfyui" }];
    modelsStore["comfy-gate"] = [{ id: "sdxl", label: "SDXL" }];
    armChat("chat-comfy-gate");
    view = await openAccordion("chat-comfy-gate", "SDXL");
    for (const id of ["image-gen-range-overlay-steps", "image-gen-range-overlay-cfg", "image-gen-range-overlay-clip", "image-gen-ft-overlay-seed"]) {
      expect(within(view.baseElement).getByTestId(id)).toBeTruthy();
    }
  });

  it("IF-11: Krea 2 controls — krea-2 models only; creativity + sliders commit the overlay krea block; the display inherits the profile BASE", async () => {
    profilesStore = [
      {
        ...profile("kr1", "Krea cloud", noCaps(), "krea/krea-2/medium"),
        backend: "krea",
        defaultParams: { krea: { movement: 20 } },
      },
    ];
    modelsStore["kr1"] = [
      { id: "krea/krea-2/medium", label: "Krea 2 Medium" },
      { id: "google/nano-banana", label: "Nano Banana" },
    ];
    armChat("chat-krea");
    const view = await openAccordion("chat-krea", "Krea 2 Medium");

    // The Krea 2 section header is present — open it.
    await act(async () => {
      within(view.baseElement).getByTestId("image-gen-ft-krea-header").click();
    });
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-krea-body")).toBeTruthy());

    // The display reads the OVERLAY's own block (the CF13/CF15 canon: an
    // empty overlay field shows the anchor default, never the profile
    // base — movement 0 here even though the base carries 20; the
    // GENERATION ladder still inherits the base per-field).
    expect(
      (within(view.baseElement).getByTestId("image-gen-range-krea-movement") as HTMLInputElement).value,
    ).toBe("0");

    // Creativity: pick High (segment labels are the mocked i18n keys). The
    // overlay write carries ONLY its own field — the base's movement is not
    // frozen into the per-model layer.
    await act(async () => {
      within(view.baseElement).getByText("image_gen_krea_creativity_high").click();
    });
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0]!.settings).toEqual({ krea: { creativity: "high" } });

    // The intensity slider rides the SAME merged krea block.
    const range = within(view.baseElement).getByTestId("image-gen-range-krea-intensity") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(range, { target: { value: "40" } });
    });
    await waitFor(() => expect(upsertCalls.length).toBe(2));
    expect(upsertCalls[1]!.settings).toEqual({ krea: { creativity: "high", intensity: 40 } });

    // A third-party model on the same backend — no Krea 2 section at all.
    await pickOption("image-gen-ft-model-select", "Nano Banana");
    await waitFor(() =>
      expect(within(view.baseElement).queryByTestId("image-gen-ft-krea")).toBeNull(),
    );
  });

  it("scheduler dropdown (PG-3/CG-B2): the LOCAL dialect family (a1111 + comfyui), right under the sampler, commits the overlay", async () => {
    profilesStore = [{ ...profile("ig2", "Forge", fullCaps()), backend: "a1111" }];
    modelsStore = { ig2: [{ id: "sdxl-base", label: "SDXL Base" }] };
    schedulersStore = { ig2: [{ name: "karras", label: "Karras" }, { name: "sgm_uniform" }] };
    armChat("chat-sch1");

    const view = await openAccordion("chat-sch1");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-scheduler")).toBeTruthy(),
    );
    await pickOption("image-gen-ft-overlay-scheduler", "Karras");
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0].settings).toEqual({ scheduler: "karras" });

    // ComfyUI dialect (CG-B2): the SAME scheduler surface — the pane's
    // local-family gate (comfy feeds from the KSampler combo, CG-A3).
    cleanup();
    upsertCalls.length = 0;
    profilesStore = [{ ...profile("cg2", "Comfy local", fullCaps()), backend: "comfyui" }];
    modelsStore = { cg2: [{ id: "sdxl-base", label: "SDXL Base" }] };
    schedulersStore = { cg2: [{ name: "simple" }, { name: "karras" }] };
    const viewComfy = await openAccordion("chat-sch1");
    await waitFor(() =>
      expect(within(viewComfy.baseElement).getByTestId("image-gen-ft-overlay-scheduler")).toBeTruthy(),
    );
    await pickOption("image-gen-ft-overlay-scheduler", "simple");
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0].settings).toEqual({ scheduler: "simple" });

    // Cloud dialect: no scheduler surface — the control must not render.
    cleanup();
    upsertCalls.length = 0;
    profilesStore = [profile("ig3", "Cloud", fullCaps())];
    modelsStore = { ig3: [{ id: "m1", label: "SDXL Base" }] };
    const view2 = await openAccordion("chat-sch1");
    expect(within(view2.baseElement).queryByTestId("image-gen-ft-overlay-scheduler")).toBeNull();
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

  it("ADetailer nests INSIDE the model-settings body; toggle + face model write the overlay", async () => {
    profilesStore = [{ ...profile("ig2", "Forge", fullCaps()), backend: "a1111" }];
    modelsStore["ig2"] = [{ id: "sdxl-base", label: "SDXL Base" }];
    extensionsStore["ig2"] = ["adetailer", "sd-webui-controlnet"];
    overlayStore["ig2/sdxl-base"] = { steps: 31 };
    armChat("chat-ms4");

    const view = await openAccordion("chat-ms4");
    const adHeader = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-adetailer-header");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Nesting pin: the ADetailer header lives inside the directly rendered
    // model-settings body, while retaining its own collapsible boundary.
    const parentBody = within(view.baseElement).getByTestId("image-gen-ft-model-settings-body");
    expect(parentBody.contains(adHeader)).toBe(true);

    await act(async () => {
      adHeader.click();
    });
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-adetailer-body")).toBeTruthy(),
    );
    const adBody = within(view.baseElement).getByTestId("image-gen-ft-adetailer-body");
    // Scoped: the chip body now carries its own hires switch (FT-A6) — the
    // ADetailer boundary is its OWN body, not the whole popover.
    const toggle = within(adBody as HTMLElement).getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0].settings).toEqual({ steps: 31, adetailer: true });

    // Toggle ON reveals the face-model dropdown; picking writes merged.
    await pickOption("image-gen-ft-adetailer-model", "face_yolov8s.pt");
    await waitFor(() => expect(upsertCalls.length).toBe(2));
    expect(upsertCalls[1].settings).toEqual({ steps: 31, adetailer: true, adetailerModel: "face_yolov8s.pt" });

    const range = within(adBody as HTMLElement).getByTestId("image-gen-ft-range-adetailer-steps") as HTMLInputElement;
    expect(range.value).toBe("31");
    expect(range.getAttribute("min")).toBe("1");
    expect(range.getAttribute("max")).toBe("150");
    expect(range.getAttribute("step")).toBe("1");
    const steps = within(adBody as HTMLElement).getByTestId("image-gen-ft-adetailer-steps") as HTMLInputElement;
    expect(steps.getAttribute("placeholder")).toBe("31");
    await act(async () => {
      fireEvent.change(range, { target: { value: "17" } });
    });
    await waitFor(() => expect(upsertCalls.length).toBe(3));
    expect(upsertCalls[2].settings).toEqual({ steps: 31, adetailer: true, adetailerModel: "face_yolov8s.pt", adetailerSteps: 17 });
    await act(async () => {
      fireEvent.change(steps, { target: { value: "" } });
    });
    await waitFor(() => expect(upsertCalls.length).toBe(4));
    expect(upsertCalls[3].settings).toEqual({ steps: 31, adetailer: true, adetailerModel: "face_yolov8s.pt", adetailerSteps: undefined });
  });
});

describe("ImageGenFineTuningChip — comfyui dialect (CG-B2)", () => {
  /** A comfy profile with a Krea-2 DiT model, a checkpoint model, and a
   *  plain (no-marker) model — plus live sidecar lists. */
  function armDitChat(chatId: string): void {
    profilesStore = [{ ...profile("cgx", "Comfy local", fullCaps()), backend: "comfyui" }];
    modelsStore = {
      cgx: [
        { id: "ray_dit", label: "Ray DiT", template: "krea2-dit" },
        { id: "flux_ckpt", label: "Flux Checkpoint", template: "checkpoint" },
        { id: "plain", label: "Plain Model" },
      ],
    };
    sidecarsStore = {
      cgx: { encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vaes: ["qwen_image_vae.safetensors"] },
    };
    armChat(chatId);
  }

  it("«Detected: …» readout renders for a picked template model and is absent otherwise", async () => {
    armDitChat("chat-dt1");
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-dt1" />);
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());
    // No pick yet (the profile's own model is not "picked") → no readout.
    expect(within(view.baseElement).queryByTestId("image-gen-ft-model-detected")).toBeNull();

    // A DiT marker → the readout appears under the picker (the pane's line twin).
    await pickOption("image-gen-ft-model-select", "Ray DiT");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-detected")).toBeTruthy(),
    );
    expect(within(view.baseElement).getByTestId("image-gen-ft-model-detected").textContent).toContain(
      "image_gen_detected_template",
    );

    // A checkpoint marker is a template too — both map entries render.
    await pickOption("image-gen-ft-model-select", "Flux Checkpoint");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-detected")).toBeTruthy(),
    );

    // A model without a template marker (and the unpicked state) → nothing.
    await pickOption("image-gen-ft-model-select", "Plain Model");
    await waitFor(() =>
      expect(within(view.baseElement).queryByTestId("image-gen-ft-model-detected")).toBeNull(),
    );
  });

  it("model family rides the OPENED model list as the detail line — never the collapsed trigger", async () => {
    profilesStore = [{ ...profile("cgf", "Comfy local", fullCaps()), backend: "comfyui" }];
    modelsStore = {
      cgf: [
        { id: "ray_dit", label: "Ray DiT", family: "Krea 2" },
        { id: "plain", label: "Plain Model" },
      ],
    };
    armChat("chat-fam");

    const view = renderChip(<ImageGenFineTuningChip chatId="chat-fam" />);
    openChip();
    const trigger = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-model-select");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Collapsed trigger before a pick: the default label only — no family.
    expect(trigger.textContent).not.toContain("Krea 2");

    // The opened list shows the family as the item's detail line (the
    // cmdk item text is label + detail concatenated — pick via the pair).
    await pickOption("image-gen-ft-model-select", "Ray DiTKrea 2");
    // Collapsed trigger after the pick: label only — family stays list-only
    // (triggerDetail={false}; the inline-row gotcha, AGENTS.md).
    await waitFor(() => expect(trigger.textContent).toContain("Ray DiT"));
    expect(trigger.textContent).not.toContain("Krea 2");
  });

  it("encoder/VAE rows render ONLY for comfyui + krea2-dit — checkpoint and a1111 hide them; the sidecar list is fetched ONCE per profile", async () => {
    armDitChat("chat-sc1");
    const view = await openAccordion("chat-sc1", "Ray DiT");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-encoder")).toBeTruthy(),
    );
    expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-vae")).toBeTruthy();
    expect(within(view.baseElement).queryByTestId("image-gen-ft-sidecars-failed")).toBeNull();
    await waitFor(() => expect(sidecarsCalls).toEqual(["cgx"]));

    // Checkpoint template → the DiT rows disappear…
    await pickOption("image-gen-ft-model-select", "Flux Checkpoint");
    await waitFor(() =>
      expect(within(view.baseElement).queryByTestId("image-gen-ft-overlay-encoder")).toBeNull(),
    );
    expect(within(view.baseElement).queryByTestId("image-gen-ft-overlay-vae")).toBeNull();

    // …and flipping back does NOT refetch (once per profile, the pane's rule).
    await pickOption("image-gen-ft-model-select", "Ray DiT");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-encoder")).toBeTruthy(),
    );
    expect(sidecarsCalls).toEqual(["cgx"]);

    // A1111 dialect → never any DiT rows (even for a template-marked model).
    cleanup();
    profilesStore = [{ ...profile("iga", "Forge", fullCaps()), backend: "a1111" }];
    modelsStore = { iga: [{ id: "ray_dit", label: "Ray DiT", template: "krea2-dit" }] };
    const viewA = await openAccordion("chat-sc1", "Ray DiT");
    expect(within(viewA.baseElement).queryByTestId("image-gen-ft-overlay-encoder")).toBeNull();
    expect(within(viewA.baseElement).queryByTestId("image-gen-ft-overlay-vae")).toBeNull();
  });

  it("picking an encoder/VAE writes the overlay upsert; Auto clears the field; a stored value outside the live list stays pickable", async () => {
    armDitChat("chat-sc2");
    const view = await openAccordion("chat-sc2", "Ray DiT");
    await pickOption("image-gen-ft-overlay-encoder", "qwen3vl_4b_fp8_scaled.safetensors");
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0]).toEqual({
      profileId: "cgx",
      modelId: "ray_dit",
      settings: { encoderName: "qwen3vl_4b_fp8_scaled.safetensors" },
    });

    await pickOption("image-gen-ft-overlay-vae", "qwen_image_vae.safetensors");
    await waitFor(() => expect(upsertCalls.length).toBe(2));
    // Merged overlay: the encoder survives the VAE write.
    expect(upsertCalls[1].settings).toEqual({
      encoderName: "qwen3vl_4b_fp8_scaled.safetensors",
      vaeName: "qwen_image_vae.safetensors",
    });

    // Auto clears ONLY the encoder — the merged overlay keeps the VAE.
    await pickOption("image-gen-ft-overlay-encoder", "image_gen_sidecar_auto");
    await waitFor(() => expect(upsertCalls.length).toBe(3));
    expect(upsertCalls[2].settings).toEqual({ vaeName: "qwen_image_vae.safetensors" });

    // A stored value outside the live list keeps its own pickable entry
    // (the since-removed-files rule — the pane's encoder-field clone).
    cleanup();
    upsertCalls.length = 0;
    overlayStore["cgx/ray_dit"] = { encoderName: "gone_encoder.safetensors" };
    const view2 = await openAccordion("chat-sc2", "Ray DiT");
    await pickOption("image-gen-ft-overlay-encoder", "gone_encoder.safetensors");
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0].settings).toEqual({ encoderName: "gone_encoder.safetensors" });
  });

  it("a failed sidecar fetch degrades to the failed hint — rows render, no crash (the loras-failed precedent)", async () => {
    armDitChat("chat-sc3");
    sidecarsFailFor.add("cgx");
    const view = await openAccordion("chat-sc3", "Ray DiT");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-sidecars-failed")).toBeTruthy(),
    );
    // The rows still render (Auto + any stored value) — a hint, not a teardown.
    expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-encoder")).toBeTruthy();
    expect(within(view.baseElement).getByTestId("image-gen-ft-overlay-vae")).toBeTruthy();
  });
});

describe("ImageGenFineTuningChip — comfyui ADetailer (IF-6)", () => {
  /** A comfy profile + models + the fine-tuning toggle — the CG-B2 arm
   *  twin, checkpoint-template model so no sidecar rows render. */
  function armComfyChat(chatId: string, detectors: string[]): void {
    profilesStore = [{ ...profile("cfa", "Comfy local", fullCaps()), backend: "comfyui" }];
    modelsStore = { cfa: [{ id: "flux_ckpt", label: "Flux Checkpoint", template: "checkpoint" }] };
    faceDetectorsStore = { cfa: detectors };
    armChat(chatId);
  }

  it("a discovered chain lights the ADetailer block with the LIVE model picker (the a1111 preset twin); a1111 never touches the probe", async () => {
    armComfyChat("chat-if6a", ["bbox/face_yolov8m.pt", "bbox/face_yolov8n.pt"]);
    const view = await openAccordion("chat-if6a", "Flux Checkpoint");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-adetailer")).toBeTruthy(),
    );
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer-missing")).toBeNull();

    // Open the nested block, enable the toggle, and pin the LIVE picker
    // vocabulary: a comfy-only entry is pickable (the a1111 static presets
    // would not carry it — one code path per dialect); picking writes the
    // merged overlay exactly like the a1111 twin.
    await act(async () => {
      within(view.baseElement).getByTestId("image-gen-ft-adetailer-header").click();
    });
    const adBody = await waitFor(() => {
      const el = within(view.baseElement).getByTestId("image-gen-ft-adetailer-body");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(within(adBody).getByRole("switch"));
    });
    await waitFor(() => expect(upsertCalls.length).toBe(1));
    expect(upsertCalls[0]!.settings).toEqual({ adetailer: true });

    await pickOption("image-gen-ft-adetailer-model", "bbox/face_yolov8n.pt");
    await waitFor(() => expect(upsertCalls.length).toBe(2));
    expect(upsertCalls[1]!.settings).toEqual({ adetailer: true, adetailerModel: "bbox/face_yolov8n.pt" });

    // The probe runs ONLY for comfy dialects — the a1111 path (extensions
    // probe) never calls the face-detectors endpoint (dialect separation).
    expect(faceDetectorCalls).toEqual(["cfa"]);
  });

  it("an ANSWERED empty chain renders the disabled label + install hint (the plan's honest-unavailable ruling)", async () => {
    armComfyChat("chat-if6b", []);
    const view = await openAccordion("chat-if6b", "Flux Checkpoint");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-adetailer-missing")).toBeTruthy(),
    );
    expect(within(view.baseElement).getByTestId("image-gen-ft-adetailer").textContent).toContain(
      "image_gen_adetailer_missing_hint",
    );
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer-header")).toBeNull();
  });

  it("a FAILED probe hides the block entirely (the extensions precedent)", async () => {
    armComfyChat("chat-if6c", ["bbox/face_yolov8m.pt"]);
    faceDetectorsFailFor.add("cfa");
    const view = await openAccordion("chat-if6c", "Flux Checkpoint");
    // Give the rejected probe a tick to settle before the absence pin.
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer")).toBeNull();
    expect(within(view.baseElement).queryByTestId("image-gen-ft-adetailer-missing")).toBeNull();
  });
});

describe("ImageGenFineTuningChip — IF-5 two-column body", () => {
  it("advanced content present: the body root is the container and the grid contract arms — base column holds the prompt pair, advanced column holds the tuning blocks, the footer spans both", async () => {
    profilesStore = [profile("if5a", "A1111 local", fullCaps(), "sdxl-base")];
    modelsStore = { if5a: [{ id: "sdxl-base", label: "SDXL Base" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-if5a" />);
    act(() => armChat("chat-if5a"));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());

    // Pick a concrete model → the settings block renders → the advanced
    // column has its flagship block (hasAdvanced is true even before the
    // pick via supportsLoras, but the settings block needs the pick).
    await pickOption("image-gen-ft-model-select", "SDXL Base");
    await waitFor(() =>
      expect(within(view.baseElement).getByTestId("image-gen-ft-model-settings")).toBeTruthy(),
    );

    // The body root is the Tailwind container (one root, both surfaces —
    // desktop popover AND mobile sheet switch together).
    const body = within(view.baseElement).getByTestId("image-gen-ft-body");
    expect(body.className).toContain("@container");

    // The grid wrapper: two columns at a comfortable container width.
    // happy-dom computes no container-query layout — the pin is the class
    // contract the component owns; the geometry budget is paper-verified
    // (IF-5 execution note, 2026-09-24).
    const grid = body.firstElementChild as HTMLElement;
    expect(grid.className).toContain("@min-[480px]:grid");
    expect(grid.className).toContain("@min-[480px]:grid-cols-2");

    // Grouping: base column first (prompt pair inside), advanced column
    // second (settings block inside), footer last with the col-span (inert in
    // single-column flex — no dead half-column without advanced content).
    const advanced = within(view.baseElement).getByTestId("image-gen-ft-advanced-col");
    const base = grid.firstElementChild as HTMLElement;
    expect(base).not.toBe(advanced);
    expect(base.contains(within(view.baseElement).getByTestId("image-gen-ft-prompt"))).toBe(true);
    expect(advanced.contains(within(view.baseElement).getByTestId("image-gen-ft-model-settings"))).toBe(
      true,
    );
    const footerRow = within(view.baseElement).getByTestId("image-gen-ft-generate").closest("div");
    expect(footerRow?.className).toContain("@min-[480px]:col-span-2");
  });

  it("no advanced content (cloud no-caps profile, nothing picked): the single column stays — no grid classes, no empty half column", async () => {
    profilesStore = [profile("if5b", "OpenRouter main", noCaps())];
    modelsStore = { if5b: [{ id: "flux-1", label: "Flux 1" }] };
    const view = renderChip(<ImageGenFineTuningChip chatId="chat-if5b" />);
    act(() => armChat("chat-if5b"));
    openChip();
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-body")).toBeTruthy());
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-ft-model-select")).toBeTruthy());

    const body = within(view.baseElement).getByTestId("image-gen-ft-body");
    expect(body.className).toContain("@container");
    const grid = body.firstElementChild as HTMLElement;
    expect(grid.className).not.toContain("@min-[480px]:grid");
    expect(within(view.baseElement).queryByTestId("image-gen-ft-advanced-col")).toBeNull();
  });
});
