import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { FormState } from "../../modals/ProviderModal.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let ProviderSamplerPanel: typeof import("./ProviderSamplerPanel.js").ProviderSamplerPanel;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ProviderSamplerPanel } = await import("./ProviderSamplerPanel.js"));
});

function form(): FormState {
  return {
    id: "provider-1",
    name: "Provider",
    providerPreset: "openaiCompat",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    hasStoredApiKey: false,
    model: "model-a",
    visionModel: "",
    temperature: 0.7,
    topP: 1,
    minP: 0,
    topK: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    adaptiveTarget: -1,
    adaptiveDecay: 0.9,
    dynatempRange: 0,
    dynatempExponent: 1,
    topNSigma: 0,
    smoothingFactor: 0,
    repeatLastN: -1,
    dryPenaltyLastN: -1,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 4096,
    contextBudget: 8192,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    editingModelId: null,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "medium",
    showReasoning: true,
    streamResponse: true,
    customSamplers: true,
    proxyMode: "inherit",
    proxyId: null,
  };
}

describe("ProviderSamplerPanel advanced disclosure", () => {
  it("opens the real advanced sampler body from its collapsed header", () => {
    const { getByText, queryByText } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} />,
    );
    expect(queryByText("sampler_top_p")).toBeNull();

    fireEvent.click(getByText("samplers_advanced"));

    expect(getByText("sampler_top_p")).toBeTruthy();
  });

  it("shows adaptive-p fields only for providers whose sampler set includes them (llamacpp_native / koboldcpp_native)", async () => {
    const { resolveSamplerCapabilities } = await import("@vibe-tavern/domain");
    const llamaCaps = resolveSamplerCapabilities(null, "llamacpp");
    const { getByText, queryByText, unmount } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: llamaCaps }} />,
    );
    fireEvent.click(getByText("samplers_advanced"));
    expect(getByText("sampler_adaptive_target")).toBeTruthy();
    expect(getByText("sampler_adaptive_decay")).toBeTruthy();
    // B2 llama-server numeric tail
    expect(getByText("sampler_dynatemp_range")).toBeTruthy();
    expect(getByText("sampler_dynatemp_exponent")).toBeTruthy();
    expect(getByText("sampler_top_n_sigma")).toBeTruthy();
    expect(getByText("sampler_smoothing_factor")).toBeTruthy();
    expect(getByText("sampler_dry_penalty_last_n")).toBeTruthy();
    unmount();

    const openaiCaps = resolveSamplerCapabilities("openai", "openai_compat");
    const { getByText: get2, queryByText: query2 } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: openaiCaps }} />,
    );
    fireEvent.click(get2("samplers_advanced"));
    expect(query2("sampler_adaptive_target")).toBeNull();
    expect(query2("sampler_adaptive_decay")).toBeNull();
    expect(query2("sampler_dynatemp_range")).toBeNull();
    expect(query2("sampler_top_n_sigma")).toBeNull();
    expect(query2("sampler_smoothing_factor")).toBeNull();
    expect(query2("sampler_dry_penalty_last_n")).toBeNull();
  });
});
