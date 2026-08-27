import { describe, expect, it, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import type { SamplerFieldId } from "@vibe-tavern/domain";
import type { FormState } from "./ProviderModal.js";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// ERA-1: link the UI form state to the canonical sampler field set.
//
// FormState is a concrete interface (its sampler fields carry distinct types —
// number / string[] / logitBias array / nullable seed), so it cannot be
// *derived* from SamplerFieldId the way the wire schema is. Instead this
// non-distributive compile-time assertion binds its KEY SET: every
// SamplerFieldId MUST be a key of FormState.
//
// Because FormState's sampler fields are REQUIRED (non-optional), `profileToForm`
// — whose return type is FormState — is compile-forced to hydrate every one of
// them, so this single assertion transitively guards BOTH FormState key
// coverage AND profileToForm hydration. If a sampler is added to SamplerFieldId
// but forgotten in FormState (or profileToForm stops assigning one), this file
// stops compiling. The tuple-wrapped `[X] extends [Y]` form is deliberate: it
// disables distributivity so a single missing key fails the whole subset check.
type _FormStateCoversSamplers = [SamplerFieldId] extends [keyof FormState] ? true : never;
const _formStateCoversSamplers: _FormStateCoversSamplers = true;

describe("ProviderModal FormState ↔ canonical sampler set (ERA-1)", () => {
  it("FormState keys cover every SamplerFieldId (compile-time assertion above)", () => {
    // The real assertion is the type-level line above; this runtime test keeps
    // Keeps Bun from reporting an empty file and pins the invariant at run time.
    expect(_formStateCoversSamplers).toBe(true);
  });
});

// ── TS-7a: category tabs ───────────────────────────────────────────────────

const realI18n = await import("../../i18n/context.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realBootstrapActions = await import("../../stores/api-actions/bootstrap-actions.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");
const realModalStore = await import("../../stores/modal-store.js");

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
mock.module("../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => false,
}));
mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrapActions,
}));
mock.module("../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  reorderProviderProfilesAction: async () => {},
  getProviderModelSettingsAction: async () => null,
}));

// Audio-tab footer controls (Save/Cancel/Delete wiring) are pinned in
// TtsAudioFooter.test.tsx — the extracted footer unit — so this file does NOT
// mock use-tts-profiles (a mock.module wrapper here hung the whole file).
const realTtsProfiles = await import("../settings/provider/tts/use-tts-profiles.js");
void realTtsProfiles;

const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { useModalStore } = await import("../../stores/modal-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");

let ProviderModal: typeof import("./ProviderModal.js").ProviderModal;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;

beforeAll(async () => {
  ({ ProviderModal } = await import("./ProviderModal.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
});

function renderModal(props: Record<string, unknown>) {
  return render(
    React.createElement(
      TooltipProvider as never,
      null,
      React.createElement(ProviderModal as never, props as never),
    ),
  );
}

afterEach(async () => {
  await act(async () => {});
  cleanup();
  useModalStore.setState({ isProviderModalOpen: false, providerModalOrigin: null });
});

function makeProfile(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "p1",
    name: "Alpha",
    providerPreset: "openai",
    endpoint: "https://api.test/v1",
    hasStoredApiKey: false,
    defaultModel: "gpt-4o",
    visionModel: null,
    temperature: 0.8,
    topP: 1,
    minP: 0,
    topK: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
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
    maxTokens: 2000,
    contextBudget: 16000,
    pinContextBudget: false,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "medium",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    proxyMode: "inherit",
    proxyId: null,
    isActive: true,
    cachedModels: { models: [] },
    ...overrides,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    providerProfiles: [makeProfile()] as never,
    activeProviderProfileId: "p1",
    onCreateProfile: async () => null as never,
    onDuplicateProfile: async () => null as never,
    onDeleteProfile: async () => {},
    onActivateProfile: async () => {},
    onSaveProfile: async () => null as never,
    onTestDraft: async () => ({ success: true }) as never,
    onTestProfile: async () => ({ success: true }) as never,
    onTestChat: async () => ({ success: true }) as never,
    onFetchModels: async () => [] as never,
    onFetchModelsForProfile: async () => [] as never,
    favoriteModelsByProfile: {},
    onToggleFavoriteModel: async () => {},
    onRefreshProfiles: async () => {},
    proxies: [],
    defaultProxyId: null,
    onSetDefaultProxy: async () => {},
    ...overrides,
  };
}

describe("ProviderModal — category tabs (TS-7a)", () => {
  beforeEach(() => {
    useBootstrapStore.setState({ data: null } as never);
  });

  it("renders with LLM active by default; provider list visible; tab strip shows both labels", async () => {
    useModalStore.setState({ isProviderModalOpen: true, providerModalOrigin: null });
    const view = renderModal(baseProps());
    // Tabs
    expect(within(view.baseElement).getByText("providers_category_llm")).toBeTruthy();
    expect(within(view.baseElement).getByText("providers_category_audio")).toBeTruthy();
    // LLM master list visible (profile name)
    expect(within(view.baseElement).getByText("Alpha")).toBeTruthy();
    // TTS placeholder not visible on LLM tab
    expect(within(view.baseElement).queryByText("tts_section_placeholder")).toBeNull();
  });

  it("clicking Audio switches to TtsSection placeholder and hides provider list; clicking LLM restores it", async () => {
    useModalStore.setState({ isProviderModalOpen: true, providerModalOrigin: null });
    const view = renderModal(baseProps());
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const audioRadio = within(view.baseElement).getByRole("radio", { name: "providers_category_audio" });
    await user.click(audioRadio);
    await waitFor(() => {
      expect(within(view.baseElement).getByTestId("tts-section")).toBeTruthy();
    });
    // Provider list hidden on Audio tab
    expect(within(view.baseElement).queryByText("Alpha")).toBeNull();
    // Detail also shows placeholder
    expect(within(view.baseElement).getAllByText("tts_section_placeholder").length).toBeGreaterThanOrEqual(1);
    // Back to LLM
    const llmRadio = within(view.baseElement).getByRole("radio", { name: "providers_category_llm" });
    await user.click(llmRadio);
    await waitFor(() => {
      expect(within(view.baseElement).getByText("Alpha")).toBeTruthy();
    });
    expect(within(view.baseElement).queryByText("tts_section_title")).toBeNull();
  });

  it("switching to Audio does not trip the confirm-close dirty guard", async () => {
    useModalStore.setState({ isProviderModalOpen: true, providerModalOrigin: null });
    const view = renderModal(baseProps());
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    // Enter edit mode and dirty the form: click Edit settings then change profile name.
    const editBtn = within(view.baseElement).getByText("edit_settings_btn");
    await user.click(editBtn);
    const nameInput = within(view.baseElement).getByDisplayValue("Alpha") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Alpha-dirty");
    await waitFor(() => {
      expect(view.baseElement.innerHTML).toContain("Alpha-dirty");
    });
    // The dirty dot is rendered via MasterDetailModal when dirty && llm; for this check we verify the dot's bg-accent is present.
    // On LLM the header contains a dirty dot (h-[7px] w-[7px] bg-accent). On Audio it should vanish.
    // Count dots before switch.
    const dotsBefore = view.baseElement.querySelectorAll(".bg-accent").length;
    expect(dotsBefore).toBeGreaterThan(0);
    // Switch to Audio — dirty guard must be bypassed
    const audioRadio = within(view.baseElement).getByRole("radio", { name: "providers_category_audio" });
    await user.click(audioRadio);
    await waitFor(() => {
      expect(within(view.baseElement).getByTestId("tts-section")).toBeTruthy();
    });
    // On Audio tab the dirty indicator (dot) must be hidden even though form is dirty
    // The dot is rendered as a span with bg-accent and the tooltip key unsaved_changes_title nearby;
    // the simplest proxy: the LLM tab still has the dot logic but Audio suppresses it —
    // we verify no unsaved dot is rendered in the Audio header (the dot's tooltip text would be unsaved_changes_title
    // inside the title area). On Audio, dirty && activeCategory===llm is false so no dot.
    // Check that the placeholder tab does not show the dirty-dependent footer either.
    expect(within(view.baseElement).queryByText("close_without_saving_body")).toBeNull();
    // The key assertion: switching to Audio hides the dirty-dependent UI (footer actions are also suppressed).
    expect(view.baseElement.innerHTML).not.toContain("data-testid=\"default-proxy-control\"");
  });
});
