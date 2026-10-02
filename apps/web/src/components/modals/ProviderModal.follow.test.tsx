import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, render, waitFor } = await import("@testing-library/react");
/**
 * ProviderModal per-model binding — follow-the-active-model (owner ruling
 * 2026-09-27) and the React #310 regression pin.
 *
 * The follow block (bindingFollowKeyRef + follow useEffect) must live ABOVE
 * `if (!isOpen) return null;` — a hook after a conditional return made the
 * closed→open transition throw "Rendered more hooks than during the previous
 * render" (#310) and RootErrorBoundary swallowed the whole settings pane
 * (700c7e15). Test 1 pins the closed→open transition itself; tests 2-3 pin
 * the follow semantics (favorited active model → overlay fetch + merge +
 * "Editing" badge; non-favorite → base values, base badge, no fetch, and the
 * manual binding dropdown rendered nowhere).
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import React from "react";
import type { ReactNode } from "react";
import type {
  FavoriteProviderModelRecord,
  ProviderModelSettingsRecord,
  ProviderProfileRecord,
} from "../../api/types.js";
import type { ProviderProbeResponse } from "@vibe-tavern/domain";

const realI18n = await import("../../i18n/context.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realTooltip = await import("../shared/Tooltip.js");
const realProviderActions = await import("../../stores/api-actions/provider-actions.js");

// Controllable overlay map: `${profileId}::${modelId}` -> overlay settings (null = none saved).
const overlayStore = new Map<string, Record<string, unknown> | null>();
const overlayFetchLog: Array<{ profileId: string; modelId: string }> = [];
const getProviderModelSettingsAction = mock(async (profileId: string, modelId: string): Promise<ProviderModelSettingsRecord | null> => {
  overlayFetchLog.push({ profileId, modelId });
  const settings = overlayStore.get(`${profileId}::${modelId}`);
  if (settings == null) return null;
  return { id: `pms_${modelId}`, providerProfileId: profileId, modelId, settings: settings as ProviderModelSettingsRecord["settings"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
});
const loadFavoriteModelsAction = mock(async (_profileId: string): Promise<void> => {});
const reorderProviderProfilesAction = mock(async (_ids: string[]): Promise<ProviderProfileRecord[]> => []);

mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars && "model" in vars ? `${key} ${vars.model}` : key),
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
mock.module("../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  getProviderModelSettingsAction,
  loadFavoriteModelsAction,
  reorderProviderProfilesAction,
}));

const { useModalStore } = await import("../../stores/modal-store.js");
let ProviderModal: typeof import("./ProviderModal.js").ProviderModal;

beforeAll(async () => {
  ({ ProviderModal } = await import("./ProviderModal.js"));
});

function makeProfile(over: Record<string, unknown> = {}): ProviderProfileRecord {
  return {
    id: "prof1",
    name: "Follow Test Profile",
    providerPreset: "openai",
    endpoint: "https://api.test/v1",
    apiKey: null,
    hasStoredApiKey: false,
    defaultModel: "m-fav",
    visionModel: null,
    isActive: true,
    bindPerModel: true,
    samplerSetId: "sset_base",
    temperature: 0.7,
    topP: 1, minP: 0, topK: 0, topA: 0, typicalP: null, tfsZ: null,
    contextBudget: 16000, maxTokens: null, pinContextBudget: false,
    tokenPadding: 0, generationMode: "chat",
    cachedModels: { models: [] },
    ...over,
  } as unknown as ProviderProfileRecord;
}

function makeFavorites(ids: string[]): FavoriteProviderModelRecord[] {
  return ids.map((modelId) => ({ modelId, label: null, contextLength: null, scope: "rp" })) as FavoriteProviderModelRecord[];
}

function makeProps(profile: ProviderProfileRecord, favorites: FavoriteProviderModelRecord[]) {
  return {
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
    onCreateProfile: async (): Promise<ProviderProfileRecord | null> => null,
    onDuplicateProfile: async (): Promise<ProviderProfileRecord | null> => null,
    onDeleteProfile: async (): Promise<void> => {},
    onActivateProfile: async (): Promise<void> => {},
    onSaveProfile: async (): Promise<ProviderProfileRecord | null> => null,
    onTestDraft: async (): Promise<ProviderProbeResponse> => ({ success: true }) as ProviderProbeResponse,
    onTestProfile: async (): Promise<ProviderProbeResponse> => ({ success: true }) as ProviderProbeResponse,
    onTestChat: async (): Promise<{ success: boolean; reply?: string; error?: string }> => ({ success: true }),
    onFetchModels: async (): Promise<never[]> => [],
    onFetchModelsForProfile: async (): Promise<never[]> => [],
    favoriteModelsByProfile: { [profile.id]: favorites },
    onToggleFavoriteModel: async (): Promise<void> => {},
    onRefreshProfiles: async (): Promise<void> => {},
    proxies: [],
    defaultProxyId: null,
    onSetDefaultProxy: async (): Promise<void> => {},
  };
}

describe("ProviderModal follow-the-active-model", () => {
  beforeEach(() => {
    overlayStore.clear();
    overlayFetchLog.length = 0;
    useModalStore.setState({ isProviderModalOpen: false });
  });

  test("closed -> open transition renders without a hook-order crash (React #310 regression)", async () => {
    // The mine was a hook AFTER `if (!isOpen) return null;`: the closed modal
    // skipped it, the open render ran it -> #310 -> the settings pane died.
    const props = makeProps(makeProfile(), makeFavorites(["m-fav"]));
    const view = render(<ProviderModal {...props} />);
    expect(view.container.textContent ?? "").not.toContain("Follow Test Profile");
    act(() => useModalStore.setState({ isProviderModalOpen: true }));
    await waitFor(() => expect(view.getByText("Follow Test Profile")).toBeTruthy());
  });

  test("favorited active model: overlay fetched, merged into the form, 'Editing' badge shown", async () => {
    overlayStore.set("prof1::m-fav", { temperature: 0.123, samplerSetId: "sset_x" });
    const props = makeProps(makeProfile(), makeFavorites(["m-fav"]));
    const view = render(<ProviderModal {...props} />);
    act(() => useModalStore.setState({ isProviderModalOpen: true }));
    await waitFor(() => expect(view.getByText("Follow Test Profile")).toBeTruthy());
    await waitFor(() => expect(overlayFetchLog).toContainEqual({ profileId: "prof1", modelId: "m-fav" }));
    // The overlay's temperature reached the temperature control (the field
    // label interpolates the live value).
    await waitFor(() => expect(view.queryByText("sampler_temperature (0.123)")).not.toBeNull());
    // Honest badge: "Editing: <model>".
    expect(view.getByText(/editing_model_badge m-fav/)).toBeTruthy();
  });

  test("non-favorite active model: no overlay fetch, base values, base badge, no binding dropdown", async () => {
    const props = makeProps(makeProfile({ defaultModel: "m-plain" }), makeFavorites(["m-fav"]));
    const view = render(<ProviderModal {...props} />);
    act(() => useModalStore.setState({ isProviderModalOpen: true }));
    await waitFor(() => expect(view.getByText("Follow Test Profile")).toBeTruthy());
    // Base badge appears; nothing was fetched for the non-favorite.
    await waitFor(() => expect(view.getByText(/binding_base_badge/)).toBeTruthy());
    expect(overlayFetchLog.some((e) => e.modelId === "m-plain")).toBe(false);
    // Base temperature (0.7) shows — the form hydrates from the base profile.
    await waitFor(() => expect(view.queryByText("sampler_temperature (0.7)")).not.toBeNull());
    // The manual binding dropdown is GONE (owner ruling): its label key renders nowhere.
    expect(view.queryByText(/binding_dropdown_label/)).toBeNull();
  });
});
