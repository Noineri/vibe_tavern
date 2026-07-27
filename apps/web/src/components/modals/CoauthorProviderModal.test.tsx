import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProviderProfileRecord as ClientProviderProfileRecord } from "../../api/types.js";

useDomEnv();

// Mock patchUiSettingsAction so saveBinding doesn't hit the network.
const patchUiSettingsAction = mock(async (_patch: never) => ({}) as never);
const loadFavoriteModelsAction = mock(async (_profileId: string) => {});
const updateProviderProfileAction = mock(async (_profileId: string, patch: { coauthorTransport?: "chat_completions" | "responses" }) => ({ coauthorTransport: patch.coauthorTransport ?? "chat_completions" }) as never);
const realBootstrapActions = await import("../../stores/api-actions/bootstrap-actions.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");
const realI18n = await import("../../i18n/context.js");
mock.module("../../stores/api-actions/bootstrap-actions.js", () => {
  return {
    ...realBootstrapActions,
    patchUiSettingsAction,
  };
});

// Mock loadFavoriteModelsAction so the binding hook doesn't fire network calls.
mock.module("../../stores/api-actions/provider-actions.js", () => {
  return {
    ...realProviderActions,
    loadFavoriteModelsAction,
    updateProviderProfileAction,
  };
});

// useT must return a stable t() — the modal builds labels off it.
mock.module("../../i18n/context.js", () => {
  return {
    ...realI18n,
    useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
  };
});

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
    cachedModels: { models: [{ id: "tool-model", label: "Tool Model", contextLength: 32000, capabilities: { tools: true } }] },
    ...over,
  } as ClientProviderProfileRecord;
}

function setBinding(coauthorProviderId: string | null, coauthorModelName: string | null) {
  useBootstrapStore.setState({
    data: {
      initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [],
      uiSettings: {
        id: "default", theme: "dark", chatFontSize: 15, uiFontSize: 14, messageWidth: 700, language: "en",
        activePromptPresetId: null, aiAssistantProviderId: null, aiAssistantModelName: null,
        coauthorProviderId, coauthorModelName, updatedAt: "2026-01-01",
      } as never,
      isArmServer: false,
    } as never,
  });
}

describe("CoauthorProviderModal", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    useProviderDataStore.setState({ profiles: [], favoritesByProfile: {} });
    useBootstrapStore.setState({ data: null });
  });

	it("renders the fork title + manage-connections action", async () => {
		setBinding(null, null);
		const view = render(<CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} />);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.title"));
		const { getByText } = within(view.baseElement);
		expect(getByText("coauthor.provider.title")).toBeTruthy();
		expect(getByText("coauthor.provider.manage_connections")).toBeTruthy();
  });

	it("shows the selection-only profile list with the bound profile marked active", async () => {
    setBinding("prof_coauthor", "model-a");
    useProviderDataStore.setState({
      profiles: [
        makeProfile("prof_coauthor", "Bound Profile"),
        makeProfile("prof_other", "Other Profile"),
      ],
      favoritesByProfile: {},
    });
		const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("Bound Profile"));
		const { getByText, queryByText } = within(view.baseElement);
		// Both profiles render in the master list
		expect(getByText("Bound Profile")).toBeTruthy();
		expect(getByText("Other Profile")).toBeTruthy();
		// No "+ New" button (selectionOnly)
		expect(queryByText("new_profile_btn")).toBeNull();
  });

	it("manage-connections calls onOpenProviderModal + onClose", async () => {
    setBinding(null, null);
    let providerOpened = false;
    let closed = false;
		const view = render(
      <TooltipProvider><CoauthorProviderModal
        isOpen={true}
        onClose={() => { closed = true; }}
        onOpenProviderModal={() => { providerOpened = true; }}
      /></TooltipProvider>,
		);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.manage_connections"));
		const { getByText } = within(view.baseElement);
		fireEvent.click(getByText("coauthor.provider.manage_connections"));
    expect(providerOpened).toBe(true);
    expect(closed).toBe(true);
  });

	it("shows custom-ID guidance and an explicit model refresh action", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha")], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("Alpha"));
		const { getByPlaceholderText, getByText } = within(view.baseElement);
    expect(getByPlaceholderText("coauthor.provider.model_search")).toBeTruthy();
    expect(getByText("refresh_models")).toBeTruthy();
  });

  it("persists a permitted Responses selection without changing the binding", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "OpenAI")], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.transport_responses"));
		const { getByText } = within(view.baseElement);
    fireEvent.click(getByText("coauthor.provider.transport_responses"));
    await waitFor(() => expect(updateProviderProfileAction).toHaveBeenCalledWith("prof_1", { coauthorTransport: "responses" }));
  });

  it("hides Responses for native profiles but permits an explicit attempt for every OpenAI-compatible profile", async () => {
    setBinding("native", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("native", "Claude", { providerPreset: "anthropic" }), makeProfile("tabby", "Tabby", { providerPreset: "tabby" })], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.transport_native"));
		const { getByText, queryByText } = within(view.baseElement);
    expect(getByText("coauthor.provider.transport_native")).toBeTruthy();
    expect(queryByText("coauthor.provider.transport_responses")).toBeNull();
    fireEvent.pointerDown(getByText("Tabby"));
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.transport_responses"));
    expect(getByText("coauthor.provider.transport_may_not_be_supported")).toBeTruthy();
  });

  it("renders a fixed-height model viewport that scrolls internally, with a stable footer", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha", { maxTokens: 2_000, contextBudget: 32_000 })], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.tokens_label"));
		const { getByText, getByTestId } = within(view.baseElement);
    expect(getByText("coauthor.provider.tokens_label")).toBeTruthy();
    expect(getByText("coauthor.provider.max_tokens")).toBeTruthy();
    expect(getByText("coauthor.provider.context_budget")).toBeTruthy();
    // The model viewport is a FIXED height (~250px, ~5 rows) and must NEVER grow
    // with model count, so the Hi button sits immediately below it regardless of
    // how many models load. Scrolling is delegated inside (overflow-hidden box).
    const list = getByTestId("coauthor-model-list");
    expect(list.className).toContain("h-[250px]");
    expect(list.className).toContain("shrink-0");
    expect(list.className).toContain("overflow-hidden");
    expect(list.className).not.toContain("flex-1");
    // The wrapping model section must not grow either — flex-1 on the section
    // would shove the Hi button to the bottom and tie content height to count.
    const modelSection = list.parentElement;
    expect(modelSection?.className).not.toContain("flex-1");
    // Stable footer: Cancel/Use live in the MasterDetailModal footer slot, which
    // renders OUTSIDE the scrollable detail pane, so they never overlay content
    // or scroll away. The footer is a sibling of the scroll region, not inside it.
    const footer = getByTestId("coauthor-modal-footer");
    expect(footer.textContent).toContain("cancel");
    expect(footer.textContent).toContain("coauthor.provider.use_for_coauthor");
    let scrollPane: Element | null = list.parentElement;
    while (scrollPane && !scrollPane.className.includes("overflow-y-auto")) {
      scrollPane = scrollPane.parentElement;
    }
    expect(scrollPane).not.toBeNull();
    expect(scrollPane!.contains(footer)).toBe(false);
  });

  it("renders the inherited -1 (unlimited) max-output sentinel as ∞, never as -1", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha", { maxTokens: -1 })], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("∞"));
		const { getByText, queryAllByRole } = within(view.baseElement);
    // The internal -1 sentinel must not leak as a raw numeric value into the editor.
    expect(getByText("∞")).toBeTruthy();
    const leakingSentinel = queryAllByRole("textbox").some((el) => (el as HTMLInputElement).value === "-1");
    expect(leakingSentinel).toBe(false);
  });

  it("converts an inherited unlimited max-output into a concrete override on demand", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha", { maxTokens: -1 })], favoritesByProfile: {} });
    const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("∞"));
		const { getByText } = within(view.baseElement);
    fireEvent.click(getByText("∞"));
    await waitFor(() => expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorMaxTokens: 2_000 }));
  });

	it("save button is disabled when a profile is selected but no model chosen", async () => {
    setBinding(null, null);
    useProviderDataStore.setState({
      profiles: [makeProfile("prof_1", "Alpha")],
      favoritesByProfile: {},
    });
		const view = render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
		await waitFor(() => expect(view.baseElement.textContent).toContain("Alpha"));
		const { getByText } = within(view.baseElement);
		// Select a profile first — the save button only renders in the detail pane.
		fireEvent.pointerDown(getByText("Alpha"));
		const saveBtn = getByText("coauthor.provider.use_for_coauthor");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
