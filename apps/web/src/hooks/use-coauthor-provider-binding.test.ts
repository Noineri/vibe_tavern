/**
 * Behavior contracts for useCoauthorProviderBinding after CG-2 moved the
 * Co-Author generation model to the per-connection row
 * (`coauthor_connection_settings.model_name`):
 *
 *  - the displayed/active model READS the row (profile default only when the
 *    row has no model — the same fallback as the backend boundary);
 *  - modal save (saveBinding) and the star quick-switch (quickSwitchModel)
 *    WRITE the row's model via a read-modify-write — the PUT replaces the
 *    whole record, so the row's other generation settings are re-sent
 *    unchanged, and ui_settings keeps only the connection binding
 *    (`coauthorProviderId`), never the model;
 *  - a connection with no row yet gets the domain defaults
 *    (`resolveCoauthorGenerationSettings` / COAUTHOR_GENERATION_DEFAULTS)
 *    plus the chosen model.
 *
 * Doubles sit at the API seam (provider-api / settings-api): the real store
 * actions run, so the seeded row cache is exactly what the read-modify-write
 * reads. The `...real` spread keeps every other export genuine for later
 * files sharing the worker.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { CoauthorConnectionSettingsRecord, ProviderProfileRecord, UiSettingsRecord } from "../api/types.js";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { renderHook } = await import("@testing-library/react");

const patchUiSettingsAction = mock(async () => ({}));
const getCoauthorConnectionSettings = mock(async (_profileId: string): Promise<unknown> => null);
const upsertCoauthorConnectionSettings = mock(async (_profileId: string, _body: unknown) => ({}));
const listFavoriteProviderModels = mock(async (_profileId: string) => []);
const realProviderApi = await import("../api/provider-api.js");
const realBootstrapActions = await import("../stores/api-actions/bootstrap-actions.js");

mock.module("../api/provider-api.js", () => {
  return {
    ...realProviderApi,
    getCoauthorConnectionSettings,
    upsertCoauthorConnectionSettings,
    listFavoriteProviderModels,
  };
});

mock.module("../stores/api-actions/bootstrap-actions.js", () => {
  return {
    ...realBootstrapActions,
    patchUiSettingsAction,
  };
});

const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useBootstrapStore } = await import("../stores/api-actions/bootstrap-actions.js");
const { COAUTHOR_GENERATION_DEFAULTS } = await import("@vibe-tavern/domain");
const { useCoauthorProviderBinding } = await import("./use-coauthor-provider-binding.js");

/** A stored connection row — `settings` partial like the CG-1 seed writes. */
function makeRow(modelName: string | null, settings: ModelSettingsOverlay = {}): CoauthorConnectionSettingsRecord {
  return {
    providerProfileId: "p1",
    modelName,
    settings,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function makeUiSettings(): UiSettingsRecord {
  return {
    id: "default", theme: "dark", chatFontSize: 15, uiFontSize: 14, messageWidth: 700, language: "en",
    activePromptPresetId: null, aiAssistantProviderId: null, aiAssistantModelName: null,
    coauthorProviderId: "p1", updatedAt: "2026-01-01",
  } as unknown as UiSettingsRecord;
}

function seedBinding(row: CoauthorConnectionSettingsRecord | null | undefined, defaultModel: string | null = "profile-default") {
  useBootstrapStore.setState({
    data: {
      initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [],
      uiSettings: makeUiSettings(),
      isArmServer: false,
    },
  });
  useProviderDataStore.setState({
    profiles: [
      {
        id: "p1",
        isActive: false,
        defaultModel,
        // cachedModels keeps useProviderModels on its cache path (no network).
        cachedModels: { models: [{ id: "row-model", label: "Row Model", contextLength: 32000 }] },
      } as unknown as ProviderProfileRecord,
    ],
    // Pre-seeding the row cache keeps the mount loader silent and makes the
    // seeded row exactly what quickSwitch/saveBinding read back.
    coauthorSettingsByProfile: row === undefined ? {} : { p1: row },
  });
}

describe("useCoauthorProviderBinding — model source = connection row (CG-2)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("active model reads the row, not the profile defaultModel or ui_settings", async () => {
    seedBinding(makeRow("row-model"));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    expect(result.current.profileId).toBe("p1");
    expect(result.current.model).toBe("row-model");
  });

  it("row with no model falls back to the profile defaultModel (backend CG-2 fallback)", async () => {
    seedBinding(makeRow(null));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    expect(result.current.model).toBe("profile-default");
  });

  it("quick switch writes the row's model and keeps the row's other settings; ui_settings untouched", async () => {
    seedBinding(makeRow("row-model", { temperature: 0.7, maxTokens: 1234, contextBudget: 5000, pinContextBudget: true }));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.quickSwitchModel("switched-model");
    expect(upsertCoauthorConnectionSettings).toHaveBeenCalledWith("p1", {
      modelName: "switched-model",
      settings: expect.objectContaining({
        temperature: 0.7,
        maxTokens: 1234,
        contextBudget: 5000,
        pinContextBudget: true,
        topP: 1,
      }),
    });
    expect(patchUiSettingsAction).not.toHaveBeenCalled();
  });

  it("quick switch auto-fills the selected model's known context length", async () => {
    seedBinding(makeRow("old-model", { contextBudget: 128_000, pinContextBudget: false }));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.quickSwitchModel("row-model");
    expect(upsertCoauthorConnectionSettings).toHaveBeenCalledWith("p1", {
      modelName: "row-model",
      settings: expect.objectContaining({ contextBudget: 32_000 }),
    });
  });

  it("quick switch with unknown model context keeps the row's set budget (report step 3)", async () => {
    // "unlisted-model" is absent from cachedModels → no LIVE context length.
    // The row's own 5 000 budget is set, so the switch must not clobber it
    // with the Co-Author unknown-context fallback (128 000).
    seedBinding(makeRow("old-model", { contextBudget: 5_000, pinContextBudget: false }));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.quickSwitchModel("unlisted-model");
    expect(upsertCoauthorConnectionSettings).toHaveBeenCalledWith("p1", {
      modelName: "unlisted-model",
      settings: expect.objectContaining({ contextBudget: 5_000 }),
    });
  });

  it("modal save writes the row first, then binds ONLY the connection in ui_settings", async () => {
    seedBinding(makeRow("row-model", { temperature: 0.7, maxTokens: 1234, contextBudget: 5000, pinContextBudget: true }));
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.saveBinding("p1", "chosen-model");
    expect(upsertCoauthorConnectionSettings).toHaveBeenCalledWith("p1", {
      modelName: "chosen-model",
      settings: expect.objectContaining({ temperature: 0.7, maxTokens: 1234 }),
    });
    // Exact-match: the model must NOT be written to the retired ui_settings global.
    expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorProviderId: "p1" });
  });

  it("a connection with no row yet gets the domain defaults plus the chosen model", async () => {
    seedBinding(undefined);
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.quickSwitchModel("first-model");
    expect(upsertCoauthorConnectionSettings).toHaveBeenCalledWith("p1", {
      modelName: "first-model",
      settings: COAUTHOR_GENERATION_DEFAULTS,
    });
  });

  it("quick switch is a no-op when no binding resolves a profile", async () => {
    useBootstrapStore.setState({
      data: {
        initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [],
        uiSettings: { ...makeUiSettings(), coauthorProviderId: null },
        isArmServer: false,
      },
    });
    useProviderDataStore.setState({ profiles: [], coauthorSettingsByProfile: {} });
    const { result } = renderHook(() => useCoauthorProviderBinding());
    await result.current.quickSwitchModel("any");
    expect(upsertCoauthorConnectionSettings).not.toHaveBeenCalled();
  });
});
