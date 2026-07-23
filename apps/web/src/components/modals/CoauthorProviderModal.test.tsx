import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../shared/Tooltip.js";
import { CoauthorProviderModal } from "./CoauthorProviderModal.js";
import type { ProviderProfileRecord as ClientProviderProfileRecord } from "../../api/types.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { updateProviderProfileAction } from "../../stores/api-actions/provider-actions.js";

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
    updateProviderProfileAction: vi.fn(async (_profileId: string, patch: { coauthorTransport?: "chat_completions" | "responses" }) => ({ coauthorTransport: patch.coauthorTransport ?? "chat_completions" }) as never),
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
    vi.clearAllMocks();
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
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
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
      <TooltipProvider><CoauthorProviderModal
        isOpen={true}
        onClose={() => { closed = true; }}
        onOpenProviderModal={() => { providerOpened = true; }}
      /></TooltipProvider>,
    );
    fireEvent.click(screen.getByText("coauthor.provider.manage_connections"));
    expect(providerOpened).toBe(true);
    expect(closed).toBe(true);
  });

  it("shows custom-ID guidance and an explicit model refresh action", () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha")], favoritesByProfile: {} });
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
    expect(screen.getByPlaceholderText("coauthor.provider.model_search")).toBeTruthy();
    expect(screen.getByText("refresh_models")).toBeTruthy();
  });

  it("persists a permitted Responses selection without changing the binding", async () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "OpenAI")], favoritesByProfile: {} });
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
    fireEvent.click(screen.getByText("coauthor.provider.transport_responses"));
    await waitFor(() => expect(vi.mocked(updateProviderProfileAction)).toHaveBeenCalledWith("prof_1", { coauthorTransport: "responses" }));
  });

  it("hides Responses for native profiles but permits an explicit attempt for every OpenAI-compatible profile", () => {
    setBinding("native", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("native", "Claude", { providerPreset: "anthropic" }), makeProfile("tabby", "Tabby", { providerPreset: "tabby" })], favoritesByProfile: {} });
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
    expect(screen.getByText("coauthor.provider.transport_native")).toBeTruthy();
    expect(screen.queryByText("coauthor.provider.transport_responses")).toBeNull();
    fireEvent.pointerDown(screen.getByText("Tabby"));
    expect(screen.getByText("coauthor.provider.transport_responses")).toBeTruthy();
    expect(screen.getByText("coauthor.provider.transport_may_not_be_supported")).toBeTruthy();
  });

  it("shows independent Co-Author token limits and a fixed-height scrolling model list", () => {
    setBinding("prof_1", "tool-model");
    useProviderDataStore.setState({ profiles: [makeProfile("prof_1", "Alpha", { maxTokens: 2_000, contextBudget: 32_000 })], favoritesByProfile: {} });
    render(<TooltipProvider><CoauthorProviderModal isOpen={true} onClose={() => {}} onOpenProviderModal={() => {}} /></TooltipProvider>);
    expect(screen.getByText("coauthor.provider.tokens_label")).toBeTruthy();
    expect(screen.getByText("coauthor.provider.max_tokens")).toBeTruthy();
    expect(screen.getByText("coauthor.provider.context_budget")).toBeTruthy();
    expect(screen.getByTestId("coauthor-model-list").className).toContain("h-[250px]");
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
