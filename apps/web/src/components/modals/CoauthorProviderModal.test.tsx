import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProviderProfileRecord as ClientProviderProfileRecord } from "../../api/types.js";

useDomEnv();

// Mock patchUiSettingsAction so saveBinding doesn't hit the network.
const patchUiSettingsAction = mock(async (_patch: never) => ({}) as never);
const loadFavoriteModelsAction = mock(async (_profileId: string) => {});
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
    id, name, providerPreset: "openaiCompat", endpoint: "https://api.test/v1",
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
		const view = render(<CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} />);
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
      <CoauthorProviderModal
        isOpen={true}
        onClose={() => { closed = true; }}
        onOpenProviderModal={() => { providerOpened = true; }}
			/>,
		);
		await waitFor(() => expect(view.baseElement.textContent).toContain("coauthor.provider.manage_connections"));
		const { getByText } = within(view.baseElement);
		fireEvent.click(getByText("coauthor.provider.manage_connections"));
    expect(providerOpened).toBe(true);
    expect(closed).toBe(true);
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
