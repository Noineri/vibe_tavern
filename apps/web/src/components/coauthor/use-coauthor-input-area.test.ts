/**
 * Hook-level contracts for the co-author input area's shared data layer
 * (`use-coauthor-input-area.ts`), extracted alongside the viewport fork
 * (3cb7f060) so the two formerly-UI-coupled assertions of
 * CoauthorInputArea.test.tsx — "selecting a module calls the action" and
 * "only tool-capable favorites are offered" — are pinned at the layer that
 * actually owns them. The Select/BottomSheet is plumbing; the contracts live
 * in `useModuleSwitch.handleSelect` and the hook's decorated Co-Author favorites.
 *
 * Rendering the Select open/select interaction under happy-dom is a documented
 * Radix limitation (Select.Content does not mount without layout — same root
 * cause for which DropdownSelect.test is `.skip`'d; see overlay-primitive-audit
 * execution log). The hook path is environment-agnostic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import {
	listCoauthorModulesAction,
	setCoauthorModuleAction,
} from "../../stores/api-actions/chat-actions.js";

// Mock the two chat-actions the switch calls. `listCoauthorModulesAction` is
// read by useModuleSwitch on mount; `setCoauthorModuleAction` is what
// handleSelect must fire.
const MODULES: CoauthorModule[] = [
	{ id: "default", name: "Default Co-Author", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 5, isBuiltIn: true },
	{ id: "profile-editor", name: "Profile Editor", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 3, isBuiltIn: true },
];

vi.mock("../../stores/api-actions/chat-actions.js", () => ({
	listCoauthorModulesAction: vi.fn(() => Promise.resolve(MODULES)),
	setCoauthorModuleAction: vi.fn(async (_chatId: string, _moduleId: string | null) => {}),
}));

// useT must return a stable t(); the hook builds labels off it.
vi.mock("../../i18n/context.js", async (importOriginal) => {
	const realI18n = await importOriginal() as typeof import("../../i18n/context.js");
	return {
		...realI18n,
		useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
	};
});

const { useModuleSwitch, useCoauthorInputArea } = await import("./use-coauthor-input-area.js");

// The favorites/tool-filter path goes through two hooks the data hook composes.
// Stub them to deterministic inputs so the test pins the COMPOSITION (favorite
// ∩ tool-capable), not the hooks' own internals (covered in
// useToolCapableModels.test.ts).
vi.mock("../../hooks/use-provider-profiles.js", async (importOriginal) => {
	const realProviderProfiles = await importOriginal() as typeof import("../../hooks/use-provider-profiles.js");
	return {
		...realProviderProfiles,
		useProviderProfiles: () => ({
			activeProviderProfile: { id: "p1", name: "OpenAI Pro", defaultModel: "gpt-4o", contextBudget: 128000, maxTokens: 4096 },
			providerProfiles: [],
			favoriteModelsByProfile: {
				p1: [
					{ modelId: "gpt-4o", label: "GPT-4o", contextLength: 128000 },
					{ modelId: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000 },
				],
			},
			handleSelectFavoriteProviderModel: vi.fn(async (_profileId: string, _modelId: string) => {}),
		}),
	};
});

// useToolCapableModels is NOT mocked — mocking it leaks process-globally and
// clobbers useToolCapableModels.test.ts (AGENTS.md mock.module gotcha). Instead
// we seed the provider-data-store cache (see beforeEach in the favorites
// describe block) with capabilities.tools flags, driving the REAL hook through
// its cache path. This pins the COMPOSITION (favorites ∩ tool-capable) the
// coauthor box actually ships.

// Mock patchUiSettingsAction so quickSwitchModel doesn't hit the network.
vi.mock("../../stores/api-actions/bootstrap-actions.js", async (importOriginal) => {
	const real = await importOriginal() as typeof import("../../stores/api-actions/bootstrap-actions.js");
	return {
		...real,
		patchUiSettingsAction: vi.fn(async (_patch: never) => ({}) as never),
	};
});

// Mock loadFavoriteModelsAction so the hook doesn't fire a network request.
vi.mock("../../stores/api-actions/provider-actions.js", async (importOriginal) => {
	const real = await importOriginal() as typeof import("../../stores/api-actions/provider-actions.js");
	return {
		...real,
		loadFavoriteModelsAction: vi.fn(async (_profileId: string) => {}),
	};
});


describe("useModuleSwitch", () => {
	beforeEach(() => {
		(listCoauthorModulesAction as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve(MODULES));
		(setCoauthorModuleAction as ReturnType<typeof vi.fn>).mockClear();
	});

	it("handleSelect fires setCoauthorModuleAction with the active chat id + module id", async () => {
		// Seed the snapshot store's active chat — that's where handleSelect reads chatId.
		useSnapshotStore.setState({
			activeChat: { id: "chat1", characterId: "char1", mode: "coauthor", coauthorModuleId: null, coauthorContextLinks: [] } as never,
		});
		const { result } = renderHook(() => useModuleSwitch());
		// Wait for the registry list to load so modules/activeLabel are populated.
		await waitFor(() => expect(result.current.modules).toHaveLength(2));

		await result.current.handleSelect("profile-editor");

		await waitFor(() => expect(setCoauthorModuleAction).toHaveBeenCalledTimes(1));
		const [chatId, moduleId] = (setCoauthorModuleAction as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(moduleId).toBe("profile-editor");
		expect(chatId).toBe("chat1");
	});

	it("handleSelect is a no-op when no active chat is set", async () => {
		useSnapshotStore.setState({ activeChat: null } as never);
		const { result } = renderHook(() => useModuleSwitch());
		await waitFor(() => expect(result.current.modules).toHaveLength(2));

		await result.current.handleSelect("default");
		expect(setCoauthorModuleAction).not.toHaveBeenCalled();
	});
});

describe("useCoauthorInputArea — tool-filtered favorites", () => {
	beforeEach(() => {
		// Seed the bootstrap store with a Co-Author binding pointing at p1.
		useBootstrapStore.setState({
			data: {
				initialChatId: null,
				snapshot: null,
				isFirstRun: false,
				allCharacters: [],
				promptPresets: [],
				uiSettings: {
					id: "default",
					theme: "dark",
					chatFontSize: 15,
					uiFontSize: 14,
					messageWidth: 700,
					language: "en",
					activePromptPresetId: null,
					aiAssistantProviderId: null,
					aiAssistantModelName: null,
					coauthorProviderId: "p1",
					coauthorModelName: "gpt-4o",
					updatedAt: "2026-01-01",
				},
				isArmServer: false,
			} as never,
		});
		// Seed the provider-data-store: profile p1 with tool-capable cache + favorites.
		useProviderDataStore.setState({
			profiles: [
				{
					id: "p1",
					isActive: false,
					defaultModel: "gpt-4o",
					contextBudget: 128000,
					maxTokens: 4096,
					cachedModels: {
						models: [
							{ id: "gpt-4o", label: "GPT-4o", contextLength: 128000, capabilities: { tools: true } },
							{ id: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000, capabilities: { tools: false } },
						],
					},
				} as never,
			],
			coauthorFavoritesByProfile: {
				p1: [
					{ id: "f1", profileId: "p1", modelId: "gpt-4o", label: "GPT-4o", sortOrder: 0 } as never,
					{ id: "f2", profileId: "p1", modelId: "gpt-3.5", label: "GPT-3.5 (no tools)", sortOrder: 1 } as never,
				],
			},
		});
	});

	it("offers every Co-Author favorite and marks only explicit unsupported models", () => {
		const { result } = renderHook(() => useCoauthorInputArea());
		const favorites = result.current.favorites;
		expect(favorites.map((favorite) => favorite.modelId)).toEqual(["gpt-4o", "gpt-3.5"]);
		expect(favorites.map((favorite) => favorite.toolSupport)).toEqual(["supported", "unsupported"]);
	});

	it("active model and profile come from the Co-Author binding, not RP active", () => {
		const { result } = renderHook(() => useCoauthorInputArea());
		expect(result.current.activeProfileId).toBe("p1");
		expect(result.current.activeModelId).toBe("gpt-4o");
	});

	it("handleSelectModel calls quickSwitchModel (updates coauthorModelName, not RP defaultModel)", async () => {
		const { patchUiSettingsAction } = await import("../../stores/api-actions/bootstrap-actions.js");
		const { result } = renderHook(() => useCoauthorInputArea());
		result.current.handleSelectModel("gpt-4o-mini");
		await waitFor(() => expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorModelName: "gpt-4o-mini" }));
	});
});
