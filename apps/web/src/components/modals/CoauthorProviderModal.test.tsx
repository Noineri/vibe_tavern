import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import type { CoauthorConnectionSettingsRecord, ProviderProfileRecord as ClientProviderProfileRecord } from "../../api/types.js";

useDomEnv();

const { render, fireEvent, waitFor, within } = await import("@testing-library/react");

const patchUiSettingsAction = mock(async (_patch: never) => ({} as never));
const loadFavoriteModelsAction = mock(async (_profileId: string) => {});
const loadCoauthorConnectionSettingsAction = mock(async (_profileId: string): Promise<CoauthorConnectionSettingsRecord | null> => null);
const upsertCoauthorConnectionSettingsAction = mock(async (_profileId: string, _body: unknown) => ({}));
const updateProviderProfileAction = mock(async (_profileId: string, patch: { coauthorTransport?: "chat_completions" | "responses" }) => ({ coauthorTransport: patch.coauthorTransport ?? "chat_completions" }) as never);
const realBootstrapActions = await import("../../stores/api-actions/bootstrap-actions.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");
const realI18n = await import("../../i18n/context.js");
mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({ ...realBootstrapActions, patchUiSettingsAction }));
mock.module("../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  loadFavoriteModelsAction,
  updateProviderProfileAction,
  loadCoauthorConnectionSettingsAction,
  upsertCoauthorConnectionSettingsAction,
}));
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { useProviderDataStore } = await import("../../stores/provider-data-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let CoauthorProviderModal: typeof import("./CoauthorProviderModal.js").CoauthorProviderModal;
beforeAll(async () => {
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ CoauthorProviderModal } = await import("./CoauthorProviderModal.js"));
});

function makeProfile(id: string, name: string, over: Record<string, unknown> = {}): ClientProviderProfileRecord {
  return {
    id, name, providerPreset: "openai", coauthorTransport: "chat_completions", endpoint: "https://api.test/v1",
    defaultModel: null, isActive: false,
    cachedModels: { models: [{ id: "tool-model", label: "Tool Model", contextLength: 32_000, capabilities: { tools: true } }] },
    ...over,
  } as ClientProviderProfileRecord;
}

function makeRow(profileId: string, modelName: string, settings: Record<string, unknown> = {}): CoauthorConnectionSettingsRecord {
  return {
    providerProfileId: profileId,
    modelName,
    settings: { temperature: 0.42, maxTokens: 8_000, contextBudget: 128_000, pinContextBudget: false, ...settings },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  } as CoauthorConnectionSettingsRecord;
}

function setBinding(coauthorProviderId: string | null) {
  useBootstrapStore.setState({
    data: {
      initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [],
      uiSettings: {
        id: "default", theme: "dark", chatFontSize: 15, uiFontSize: 14, messageWidth: 700, language: "en",
        activePromptPresetId: null, aiAssistantProviderId: null, aiAssistantModelName: null,
        coauthorProviderId, coauthorModelName: null, updatedAt: "2026-01-01",
      } as never,
      isArmServer: false,
    } as never,
  });
}

function renderModal(onClose = () => {}, onOpenProviderModal = () => {}) {
  return render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={onClose} onOpenProviderModal={onOpenProviderModal} /></TooltipProvider>);
}

describe("CoauthorProviderModal", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    loadCoauthorConnectionSettingsAction.mockImplementation(async () => null);
    useProviderDataStore.setState({ profiles: [], favoritesByProfile: {}, coauthorFavoritesByProfile: {}, coauthorSettingsByProfile: {} });
    useBootstrapStore.setState({ data: null });
  });

  it("renders the fork title + manage-connections action", async () => {
    const view = renderModal();
    await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.title"));
    expect(view.getByText("coauthor.provider.title")).toBeTruthy();
    expect(view.getByText("coauthor.provider.manage_connections")).toBeTruthy();
  });

  it("shows the selection-only profile list with the bound profile marked active", async () => {
    setBinding("bound-profile");
    useProviderDataStore.setState({
      profiles: [
        makeProfile("bound-profile", "Bound Profile"),
        makeProfile("other-profile", "Other Profile"),
      ],
    });
    const view = renderModal();
    await waitFor(() => expect(view.getByText("★ Bound Profile")).toBeTruthy());
    const profileList = view.getByText("profiles_label").parentElement!;
    expect(within(profileList).getAllByText("★ Bound Profile")).toHaveLength(1);
    expect(within(profileList).getAllByText("Other Profile")).toHaveLength(1);
    expect(within(profileList).queryByText("new_profile_btn")).toBeNull();
  });

  it("manage-connections calls onOpenProviderModal + onClose", async () => {
    let providerOpened = false;
    let closed = false;
    const view = renderModal(() => { closed = true; }, () => { providerOpened = true; });
    await waitFor(() => expect(view.getByText("coauthor.provider.manage_connections")).toBeTruthy());
    fireEvent.click(view.getByText("coauthor.provider.manage_connections"));
    expect(providerOpened).toBe(true);
    expect(closed).toBe(true);
  });

  it("keeps the connection and transport cards, but replaces inherited token limits and the flat list with the selector + sampler panel", async () => {
    setBinding("p1");
    loadCoauthorConnectionSettingsAction.mockImplementation(async (id) => makeRow(id, "tool-model"));
    useProviderDataStore.setState({ profiles: [makeProfile("p1", "Alpha", { maxTokens: 2_000, contextBudget: 16_000 })] });
    const view = renderModal();
    await waitFor(() => expect(view.baseElement.textContent).toContain("sampler_basic_settings"));
    expect(view.getByText("Alpha")).toBeTruthy();
    expect(view.getByText("coauthor.provider.transport_label")).toBeTruthy();
    expect(view.getByText("coauthor.provider.model_label")).toBeTruthy();
    expect(view.baseElement.textContent).not.toContain("coauthor.provider.tokens_label");
    expect(view.baseElement.querySelector("[data-testid='coauthor-model-list']")).toBeNull();
  });

  it("loads each connection's own set and restores it after switching back", async () => {
    setBinding("p1");
    const rows = {
      p1: makeRow("p1", "one-model", { temperature: 0.11, contextBudget: 32_000 }),
      p2: makeRow("p2", "two-model", { temperature: 0.88, contextBudget: 64_000 }),
    };
    loadCoauthorConnectionSettingsAction.mockImplementation(async (id) => rows[id as keyof typeof rows] ?? null);
    useProviderDataStore.setState({ profiles: [makeProfile("p1", "Alpha"), makeProfile("p2", "Beta")] });
    const view = renderModal();
    await waitFor(() => expect(view.baseElement.textContent).toContain("one-model"));
    fireEvent.pointerDown(within(view.baseElement).getAllByText("openai")[1]!.closest(".cursor-pointer")!);
    await waitFor(() => expect(view.baseElement.textContent).toContain("two-model"));
    fireEvent.pointerDown(within(view.baseElement).getAllByText("openai")[0]!.closest(".cursor-pointer")!);
    await waitFor(() => expect(view.baseElement.textContent).toContain("one-model"));
  });

  it("uses the Co-Author row limits rather than RP profile limits", async () => {
    setBinding("p1");
    loadCoauthorConnectionSettingsAction.mockImplementation(async (id) => makeRow(id, "tool-model", { maxTokens: 8_000, contextBudget: 128_000 }));
    useProviderDataStore.setState({ profiles: [makeProfile("p1", "Alpha", { maxTokens: 111, contextBudget: 222 })] });
    const view = renderModal();
    await waitFor(() => expect(view.baseElement.textContent).toContain("sampler_basic_settings"));
    const inputValues = Array.from(view.baseElement.querySelectorAll("input")).map((input) => (input as HTMLInputElement).value);
    expect(inputValues).toContain("8000");
    expect(inputValues).toContain("128000");
    expect(inputValues).not.toContain("111");
    expect(inputValues).not.toContain("222");
  });

  it("persists the selected connection's complete set before binding it", async () => {
    setBinding(null);
    const row = makeRow("p1", "tool-model", { temperature: 0.42, maxTokens: 1234, contextBudget: 5000, pinContextBudget: true });
    loadCoauthorConnectionSettingsAction.mockImplementation(async () => row);
    useProviderDataStore.setState({ profiles: [makeProfile("p1", "Alpha")] });
    const view = renderModal();
    fireEvent.pointerDown(within(view.baseElement).getByText("openai").closest(".cursor-pointer")!);
    await waitFor(() => expect(view.baseElement.textContent).toContain("Tool Model"));
    fireEvent.click(within(view.baseElement).getByText("coauthor.provider.use_for_coauthor"));
    await waitFor(() => expect(upsertCoauthorConnectionSettingsAction).toHaveBeenCalledWith("p1", {
      modelName: "tool-model",
      settings: expect.objectContaining({ temperature: 0.42, maxTokens: 1234, contextBudget: 5000, pinContextBudget: true }),
    }));
    expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorProviderId: "p1" });
  });

  it("keeps the Responses transport behavior unchanged", async () => {
    setBinding("p1");
    useProviderDataStore.setState({ profiles: [makeProfile("p1", "OpenAI")] });
    const view = renderModal();
    await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.transport_responses"));
    fireEvent.click(within(view.baseElement).getByText("coauthor.provider.transport_responses"));
    await waitFor(() => expect(updateProviderProfileAction).toHaveBeenCalledWith("p1", { coauthorTransport: "responses" }));
  });
});
