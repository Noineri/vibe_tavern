import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProviderProfileRecord } from "../../api/types.js";

useDomEnv();

let ProviderModal: typeof import("./ProviderModal.js").ProviderModal;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useModalStore: typeof import("../../stores/modal-store.js").useModalStore;

beforeAll(async () => {
  ({ ProviderModal } = await import("./ProviderModal.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useModalStore } = await import("../../stores/modal-store.js"));
});

afterAll(() => useModalStore.setState({ isProviderModalOpen: false }));

function profile(): ProviderProfileRecord {
  return {
    id: "provider_1", name: "Primary", providerPreset: "openai", coauthorTransport: "chat_completions", endpoint: "https://api.example/v1",
    defaultModel: "model_1", visionModel: null, temperature: 1, topP: 1, minP: 0, topK: 0, topA: 0,
    typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: [], xtcThreshold: 0.1,
    xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1, maxTokens: 2048,
    contextBudget: 16000, pinContextBudget: false, bindPerModel: false, modelFreeOnly: false, modelGroupByOwner: false,
    stopSequences: [], logitBias: [], seed: null, reasoningEffort: "auto", showReasoning: false, streamResponse: true,
    customSamplers: false, proxyMode: "inherit", proxyId: null, isActive: true, hasStoredApiKey: true,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

describe("ProviderModal proxy selectors", () => {
  beforeEach(() => useModalStore.setState({ isProviderModalOpen: true, providerModalOrigin: null }));

  test("keeps the global selector in the stable footer and sends changed policy through the draft test boundary", async () => {
    const draftCalls: unknown[][] = [];
    const defaultCalls: Array<string | null> = [];
    const view = render(
      <TooltipProvider><ProviderModal
        providerProfiles={[profile()]}
        activeProviderProfileId="provider_1"
        onCreateProfile={async () => null}
        onDuplicateProfile={async () => null}
        onDeleteProfile={async () => {}}
        onActivateProfile={async () => {}}
        onSaveProfile={async () => null}
        onTestDraft={async (...args) => { draftCalls.push(args); return { success: true }; }}
        onTestProfile={async () => ({ success: true })}
        onTestChat={async () => ({ success: true })}
        onFetchModels={async () => []}
        onFetchModelsForProfile={async () => []}
        favoriteModelsByProfile={{}}
        onToggleFavoriteModel={async () => {}}
        onRefreshProfiles={async () => {}}
        proxies={[{ id: "proxy_1", name: "Office", url: "https://proxy.example", username: null, hasStoredPassword: false, sortOrder: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]}
        defaultProxyId={null}
        onSetDefaultProxy={async (proxyId) => { defaultCalls.push(proxyId); }}
      /></TooltipProvider>, 
    );
    await waitFor(() => expect(view.getByText("default_proxy")).toBeTruthy());
    fireEvent.click(view.getByText("proxy_direct"));
    await waitFor(() => expect(view.getByText("Office")).toBeTruthy());
    fireEvent.click(view.getByText("Office"));
    await waitFor(() => expect(defaultCalls).toEqual(["proxy_1"]));

    fireEvent.click(view.getByText("edit_settings_btn"));
    await waitFor(() => expect(view.getByText("provider_proxy")).toBeTruthy());
    const body = view.baseElement.textContent ?? "";
    expect(body.indexOf("api_key_label")).toBeLessThan(body.indexOf("provider_proxy"));
    expect(body.indexOf("provider_proxy")).toBeLessThan(body.indexOf("test_connection"));

    fireEvent.click(view.getByText("proxy_use_global"));
    await waitFor(() => expect(view.getByText("Office")).toBeTruthy());
    fireEvent.click(view.getByText("Office"));
    fireEvent.click(view.getByText("test_connection"));
    await waitFor(() => expect(draftCalls).toHaveLength(1));
    expect(draftCalls[0]?.slice(3)).toEqual(["proxy", "proxy_1", "provider_1"]);
  });
});
