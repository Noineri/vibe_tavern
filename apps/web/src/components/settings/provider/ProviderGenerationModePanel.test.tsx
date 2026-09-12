import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { FormState } from "../../modals/ProviderModal.js";
import { GENERATION_MODE } from "@vibe-tavern/domain";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");

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

// The format block (always-rendered for kobold) carries CustomTooltip
// actions; the app root provides the provider at runtime — bare panel renders
// mock the module (the ProviderSamplerPanel.test pattern).
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let ProviderGenerationModePanel: typeof import("./ProviderGenerationModePanel.js").ProviderGenerationModePanel;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ProviderGenerationModePanel } = await import("./ProviderGenerationModePanel.js"));
});

/** Minimal FormState factory — only the fields the panel reads/writes. */
function form(over: Partial<FormState> = {}): FormState {
  return {
    id: "prov-1",
    name: "Provider",
    providerPreset: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "",
    hasStoredApiKey: false,
    model: "qwen-local",
    visionModel: "",
    generationMode: GENERATION_MODE.chat,
    editingModelId: null,
    ...over,
  } as FormState;
}

describe("ProviderGenerationModePanel (LS-2a «Формат генерации»)", () => {
  it("renders for a TC-capable preset (lmstudio) with both options and the chat default selected", () => {
    const { getByText, getByRole } = render(
      <ProviderGenerationModePanel form={form()} updateForm={mock()} tcTemplateSource="default" />,
    );
    expect(getByText("generation_format")).toBeTruthy();
    const chat = getByRole("radio", { name: "generation_mode_chat" });
    expect(chat.getAttribute("aria-checked")).toBe("true");
    expect(getByRole("radio", { name: "generation_mode_completion" }).getAttribute("aria-checked")).toBe("false");
  });

  it("is hidden for presets without a completion endpoint (cloud openai preset — owner: toggle is local-only)", () => {
    const { queryByText } = render(
      <ProviderGenerationModePanel form={form({ providerPreset: "openai" })} updateForm={mock()} tcTemplateSource="default" />,
    );
    expect(queryByText("generation_format")).toBeNull();
  });

  // LS-10: the mode switch stays hidden for koboldcpp (native TC — a toggle
  // is meaningless), but the FORMAT BLOCK now renders ALWAYS there (owner
  // option A — the one always-TC provider gets a live format surface).

  it("renders the format block (not the switch) for koboldcpp — native TC, always visible (LS-10)", () => {
    const { queryByText, getByTestId } = render(
      <ProviderGenerationModePanel form={form({ providerPreset: "koboldcpp" })} updateForm={mock()} tcTemplateSource="native" />,
    );
    expect(queryByText("generation_format")).toBeNull();
    expect(getByTestId("provider-format-panel")).toBeTruthy();
  });

  it("switching to Text completion writes the mode through updateForm (the silent flip)", () => {
    const updateForm = mock(<K extends keyof FormState>(k: K, v: FormState[K]) => {});
    const { getByRole } = render(
      <ProviderGenerationModePanel form={form()} updateForm={updateForm} tcTemplateSource="default" />,
    );
    fireEvent.click(getByRole("radio", { name: "generation_mode_completion" }));
    expect(updateForm).toHaveBeenCalledWith("generationMode", GENERATION_MODE.completion);
  });
});
// ═══ (debug block removed) ═══
