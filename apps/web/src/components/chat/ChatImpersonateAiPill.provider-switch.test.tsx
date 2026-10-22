/**
 * AI_PILL_MODEL_CROSS_PROVIDER_REPORT step 1 — the impersonation pill never
 * pairs a provider with another provider's model.
 *
 * Unlike ChatImpersonateAiPill.test.tsx (which stubs AiQuickPill), this file
 * renders the REAL pill, settings modal and DropdownSelect (cmdk items) and
 * drives the owner's path: switch provider, pick the list's first row (the
 * provider default, labelled with the default model's NAME), apply, generate.
 * Only the network boundary is mocked (stream, settings write, model list).
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { wireProviderProfile, wireUiSettings } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import type { AiAssistantRequestBody, UiSettingsRecord } from "../../api/types.js";

useDomEnv();

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");

const calls = { requests: [] as AiAssistantRequestBody[] };
// The server echoes the full record; the mock merges the patch into the live
// store record the same way.
let savedRecord: UiSettingsRecord = wireUiSettings();

const realAiApi = await import("../../api/ai-assistant-api.js");
const realSettingsApi = await import("../../api/settings-api.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");
const realI18n = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

const MODELS_BY_PROVIDER: Record<string, Array<{ id: string; label: string }>> = {
  prov_a: [{ id: "ma", label: "ma" }, { id: "ma2", label: "ma2" }],
  prov_b: [{ id: "mb", label: "mb" }, { id: "mb2", label: "mb2" }],
};

mock.module("../../api/ai-assistant-api.js", () => ({
  ...realAiApi,
  streamAiAssistant: mock(async function* (request: AiAssistantRequestBody) {
    calls.requests.push(request);
    yield { type: "text" as const, text: "Generated" };
    yield { type: "done" as const };
  }),
}));
mock.module("../../api/settings-api.js", () => ({
  ...realSettingsApi,
  updateUiSettings: mock(async (patch: Partial<UiSettingsRecord>) => {
    savedRecord = { ...savedRecord, ...patch };
    return savedRecord;
  }),
}));
mock.module("../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  fetchProviderModelsAction: mock(async (providerId: string) => ({ models: MODELS_BY_PROVIDER[providerId] ?? [] })),
}));
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));

let ChatImpersonateAiPill: typeof import("./ChatImpersonateAiPill.js").ChatImpersonateAiPill;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useBootstrapStore: typeof import("../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;
let useProviderDataStore: typeof import("../../stores/provider-data-store.js").useProviderDataStore;

beforeAll(async () => {
  ({ ChatImpersonateAiPill } = await import("./ChatImpersonateAiPill.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js"));
  ({ useProviderDataStore } = await import("../../stores/provider-data-store.js"));
});

beforeEach(() => {
  calls.requests = [];
  savedRecord = {
    ...wireUiSettings(),
    aiAssistantProviderId: "prov_a",
    aiAssistantModelName: "ma",
    chatImpersonateEnhanceDraft: false,
  };
  useProviderDataStore.setState({
    profiles: [
      { ...wireProviderProfile(), id: "prov_a", name: "Provider A", defaultModel: "a-default", isActive: true },
      { ...wireProviderProfile(), id: "prov_b", name: "Provider B", defaultModel: "b-default" },
    ],
    favoritesByProfile: {},
  });
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: savedRecord,
      agentKindSettings: {},
      isArmServer: false,
    },
  });
});

const EMPTY_ROW = "__dropdown_select_empty__";

function renderPill() {
  return render(
    <TooltipProvider>
      <ChatImpersonateAiPill activeChatId="chat_1" characterId="char_1" personaId={null} draft="" setDraft={() => {}} />
    </TooltipProvider>,
  );
}

/** The pill is [star | gear]; the gear is its second button. */
async function openSettings(view: ReturnType<typeof renderPill>) {
  const gear = view.container.querySelectorAll("button")[1];
  await act(async () => { fireEvent.click(gear); });
  await waitFor(() => expect(triggerWithText("Provider A") ?? triggerWithText("Provider B")).toBeTruthy());
}

function triggerWithText(text: string): HTMLButtonElement | null {
  return (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined) ?? null;
}

/** Open the dropdown whose trigger shows `triggerText` and click the cmdk item
 *  carrying `itemValue` (cmdk exposes the Command.Item value as data-value). */
async function pickFrom(triggerText: string, itemValue: string) {
  const trigger = triggerWithText(triggerText);
  if (!trigger) throw new Error(`no dropdown trigger "${triggerText}"`);
  await act(async () => { fireEvent.click(trigger); });
  const item = await waitFor(() => {
    const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find((i) => i.getAttribute("data-value") === itemValue);
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
  await act(async () => { fireEvent.click(item); });
  await waitFor(() => expect(document.body.querySelector("[cmdk-list]")).toBeNull());
}

async function apply() {
  const done = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "done_btn");
  if (!done) throw new Error("no apply button");
  await act(async () => { fireEvent.click(done); });
  await waitFor(() => expect(triggerWithText("done_btn")).toBeNull());
}

async function generate(view: ReturnType<typeof renderPill>) {
  const before = calls.requests.length;
  const star = view.container.querySelectorAll("button")[0];
  await act(async () => { fireEvent.click(star); });
  await waitFor(() => expect(calls.requests.length).toBe(before + 1));
  return calls.requests[calls.requests.length - 1];
}

describe("ChatImpersonateAiPill — provider switch (real settings modal + DropdownSelect)", () => {
  test("provider switch + the provider's default row: the request carries the new provider and NO model", async () => {
    const view = renderPill();
    await openSettings(view);

    await pickFrom("Provider A", "prov_b");
    // Model field falls back to the new provider's default label, not "ma".
    await waitFor(() => expect(triggerWithText("b-default")).toBeTruthy());
    await pickFrom("b-default", EMPTY_ROW);
    await apply();

    const request = await generate(view);
    expect(request.providerProfileId).toBe("prov_b");
    expect(request.model).toBeUndefined();
  });

  test("reopening after the switch shows the new provider with its default, never the old model", async () => {
    const view = renderPill();
    await openSettings(view);
    await pickFrom("Provider A", "prov_b");
    await pickFrom("b-default", EMPTY_ROW);
    await apply();

    await openSettings(view);
    expect(triggerWithText("Provider B")).toBeTruthy();
    expect(triggerWithText("b-default")).toBeTruthy();
    expect(triggerWithText("ma")).toBeNull();
  });

  test("picking a concrete model on the new provider sends provider + that model, and the bootstrap store holds the pair", async () => {
    const view = renderPill();
    await openSettings(view);
    await pickFrom("Provider A", "prov_b");
    await waitFor(() => expect(triggerWithText("b-default")).toBeTruthy());
    await pickFrom("b-default", "mb");
    await apply();

    const request = await generate(view);
    expect(request.providerProfileId).toBe("prov_b");
    expect(request.model).toBe("mb");

    await waitFor(() => {
      const saved = useBootstrapStore.getState().data?.uiSettings;
      expect(saved?.aiAssistantProviderId).toBe("prov_b");
      expect(saved?.aiAssistantModelName).toBe("mb");
    });
  });

  test("a remounted pill seeds from the pair that was saved, not the page-load one", async () => {
    const first = renderPill();
    await openSettings(first);
    await pickFrom("Provider A", "prov_b");
    await pickFrom("b-default", "mb");
    await apply();
    await waitFor(() => expect(useBootstrapStore.getState().data?.uiSettings.aiAssistantModelName).toBe("mb"));
    first.unmount();

    const second = renderPill();
    const request = await generate(second);
    expect(request.providerProfileId).toBe("prov_b");
    expect(request.model).toBe("mb");
  });

  test("a pill with nothing of its own still seeds the persisted pair whole (fresh mount)", async () => {
    const view = renderPill();
    const request = await generate(view);
    expect(request.providerProfileId).toBe("prov_a");
    expect(request.model).toBe("ma");
  });
});
