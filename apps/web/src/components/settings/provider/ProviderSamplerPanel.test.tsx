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
    repeatLastN: -1,
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
});
