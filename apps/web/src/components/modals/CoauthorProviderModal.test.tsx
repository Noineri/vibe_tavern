import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../shared/Tooltip.js";
import { CoauthorProviderModal } from "./CoauthorProviderModal.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";

// Mock patchUiSettingsAction so saveBinding doesn't hit the network.
vi.mock("../../stores/api-actions/bootstrap-actions.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../stores/api-actions/bootstrap-actions.js");
  return {
    ...real,
    patchUiSettingsAction: vi.fn(async (_patch: never) => ({}) as never),
  };
});

// Mock loadFavoriteModelsAction so the binding hook doesn't fire network calls.
vi.mock("../../stores/api-actions/provider-actions.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../../stores/api-actions/provider-actions.js");
  return {
    ...real,
    loadFavoriteModelsAction: vi.fn(async (_profileId: string) => {}),
  };
});

// useT must return a stable t() — the modal builds labels off it.
vi.mock("../../i18n/context.js", async (importOriginal) => {
  const realI18n = await importOriginal() as typeof import("../../i18n/context.js");
  return {
    ...realI18n,
    useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
  };
});

function makeProfile(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id, name, providerPreset: "openaiCompat", endpoint: "https://api.test/v1",
    defaultModel: null, isActive: false,
    cachedModels: { models: [{ id: "tool-model", label: "Tool Model", contextLength: 32000, capabilities: { tools: true } }] },
    ...over,
  };
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

  it("renders the fork title + manage-connections action", () => {
    setBinding(null, null);
    render(<CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} />);
    expect(screen.getByText("coauthor.provider.title")).toBeTruthy();
    expect(screen.getByText("coauthor.provider.manage_connections")).toBeTruthy();
  });

  it("shows the selection-only profile list with the bound profile marked active", () => {
    setBinding("prof_coauthor", "model-a");
    useProviderDataStore.setState({
      profiles: [
        makeProfile("prof_coauthor", "Bound Profile"),
        makeProfile("prof_other", "Other Profile"),
      ],
      favoritesByProfile: {},
    });
    render(<CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} />);
    // Both profiles render in the master list
    expect(screen.getByText("Bound Profile")).toBeTruthy();
    expect(screen.getByText("Other Profile")).toBeTruthy();
    // No "+ New" button (selectionOnly)
    expect(screen.queryByText("new_profile_btn")).toBeNull();
  });

  it("manage-connections calls onOpenProviderModal + onClose", () => {
    setBinding(null, null);
    let providerOpened = false;
    let closed = false;
    render(
      <CoauthorProviderModal
        isOpen={true}
        onClose={() => { closed = true; }}
        onOpenProviderModal={() => { providerOpened = true; }}
      />,
    );
    fireEvent.click(screen.getByText("coauthor.provider.manage_connections"));
    expect(providerOpened).toBe(true);
    expect(closed).toBe(true);
  });

  it("save button is disabled when a profile is selected but no model chosen", () => {
    setBinding(null, null);
    useProviderDataStore.setState({
      profiles: [makeProfile("prof_1", "Alpha")],
      favoritesByProfile: {},
    });
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
    // Select a profile first — the save button only renders in the detail pane.
    fireEvent.pointerDown(screen.getByText("Alpha"));
    const saveBtn = screen.getByText("coauthor.provider.use_for_coauthor");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
