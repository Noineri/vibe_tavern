/**
 * CS-22 — CoauthorInputArea render (smoke) test.
 *
 * Pins the surface's PRESENCE contract vs. the RP InputArea: the quick module
 * switch + tool-filtered favorites pill render, and the RP-only affordances
 * (persona switch, AI-impersonation pill, prompt-preset switcher, image
 * attachment clip) are ABSENT. This is the layer the DOM can reliably assert.
 *
 * The two BEHAVIOURAL contracts — "selecting a module calls the action" and
 * "only tool-capable favorites are offered" — live in use-coauthor-input-area.test.ts,
 * pinned at the hook level (useModuleSwitch.handleSelect + toolFilteredFavorites).
 * They were formerly driven here through the Select UI, but Radix Select.Content
 * does not mount under happy-dom (no layout → Presence/Portal never appears; the
 * same limitation for which shared/DropdownSelect.test is `.skip`'d). The Select
 * is plumbing; the contracts belong to the data hook, so that is where they are
 * pinned now. See overlay-primitive-audit.md execution log.
 *
 * Mocking follows CoauthorTopBar.test / CoauthorModuleModal.test: capture real
 * modules first, spread `...real` in every factory (mock.module is
 * process-global — AGENTS.md gotcha). The data stores (chat-store,
 * provider-store, snapshot-store) are left REAL and seeded via `setState`
 * (same pattern CoauthorModuleModal.test uses) instead of being replaced —
 * replacing `useChatStore` breaks `useIsSending`, which reads nested state the
 * a mock would have to re-implement wholesale. `use-mobile` is NOT mocked
 * (collides with VibeMdView.test process-globally; happy-dom's desktop viewport
 * already yields useIsMobile()=false, exercising the desktop branch).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { useChatStore } from "../../stores/chat-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";

// Capture real modules BEFORE registering mocks (AGENTS.md mock.module gotcha).
const realI18n = await import("../../i18n/context.js");
const realProviderProfiles = await import("../../hooks/use-provider-profiles.js");
const realTooltip = await import("../shared/Tooltip.js");
const realChatController = await import("../../hooks/use-chat-controller.js");

vi.mock("../../i18n/context.js", () => ({
	...realI18n,
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// Provider profiles: one active profile with two favorites — one tool-capable,
// one not. The tool-only filtering is what the test pins.
vi.mock("../../hooks/use-provider-profiles.js", () => ({
	...realProviderProfiles,
	useProviderProfiles: () => ({
		activeProviderProfile: { id: "p1", name: "OpenAI Pro", defaultModel: "gpt-4o" },
		providerProfiles: [],
		favoriteModelsByProfile: {
			p1: [
				{ modelId: "gpt-4o", label: "GPT-4o", contextLength: 128000 },
				{ modelId: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000 },
			],
		},
		handleSelectFavoriteProviderModel: vi.fn(async (_profileId: string, _modelId: string) => {}),
	}),
}));

// useToolCapableModels is NOT mocked — it is exercised for real against a
// seeded provider-data-store cache (see seedStores). Mocking the hook leaks
// process-globally and clobbers useToolCapableModels.test.ts (AGENTS.md
// mock.module gotcha); driving it through its real cache path tests the
// component + hook integration AND keeps the suite leak-free.

// Send/cancel: the co-author box reuses the chat pipeline, but we don't want a
// real send here — stub the two methods the component calls.
vi.mock("../../hooks/use-chat-controller.js", () => ({
	...realChatController,
	useChatController: () => ({
		handleSend: vi.fn(async () => {}),
		handleCancelGeneration: vi.fn(() => {}),
	}),
}));

// CustomTooltip (Radix) needs a TooltipProvider ancestor the isolated render
// lacks; passthrough keeps the box's children under test. Same pattern as
// CoauthorTopBar.test.
vi.mock("../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Chat-actions: only the two the module switch calls are needed. List returns
// two seed modules so the switch dropdown has rows to render + select.
const MODULES: CoauthorModule[] = [
	{ id: "default", name: "Default Co-Author", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 5, isBuiltIn: true },
	{ id: "profile-editor", name: "Profile Editor", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 3, isBuiltIn: true },
];
const listCoauthorModulesAction = vi.fn(() => Promise.resolve(MODULES));
const setCoauthorModuleAction = vi.fn(async (_chatId: string, _moduleId: string | null) => {});
vi.mock("../../stores/api-actions/chat-actions.js", () => ({
	listCoauthorModulesAction,
	setCoauthorModuleAction,
}));

const { CoauthorInputArea } = await import("./CoauthorInputArea.js");

/** Seed the real stores so the box sees a connected provider + an active chat.
 * The provider-data-store cache carries the two test models (gpt-4o tool-capable,
 * gpt-3.5 not) so the REAL useToolCapableModels hook filters without a fetch. */
function seedStores() {
	useChatStore.setState({ activeChatId: "chat1", draft: "" } as never);
	useProviderStore.setState({
		connection: { ...useProviderStore.getState().connection, status: "connected", model: "gpt-4o" },
	});
	useSnapshotStore.setState({
		activeChat: {
			id: "chat1",
			characterId: "char1",
			mode: "coauthor",
			coauthorModuleId: null,
			coauthorLorebookIds: [],
		} as never,
	});
	// Cache two models on profile p1: gpt-4o advertises tools, gpt-3.5 does not.
	// The hook reads profile.cachedModels.models and keeps only tool-capable ones.
	useProviderDataStore.setState({
		profiles: [
			{
				id: "p1",
				cachedModels: {
					models: [
						{ id: "gpt-4o", label: "GPT-4o", contextLength: 128000, capabilities: { tools: true } },
						{ id: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000, capabilities: { tools: false } },
					],
				},
			} as never,
		],
	});
}

describe("CoauthorInputArea", () => {

	beforeEach(() => {
		listCoauthorModulesAction.mockReturnValue(Promise.resolve(MODULES));
		setCoauthorModuleAction.mockClear();
		seedStores();
	});

	it("renders the quick module switch + favorites pill, not the RP affordances", async () => {
		const { getByTestId, queryByText } = render(<CoauthorInputArea />);
		// Module switch + favorites pill present.
		expect(getByTestId("coauthor-module-switch")).toBeDefined();
		expect(getByTestId("coauthor-favorites-pill")).toBeDefined();
		// RP-only affordances absent: persona switch, AI impersonation, preset, attachments.
		expect(queryByText("speak_as")).toBeNull();
		expect(queryByText("multi_persona_tooltip")).toBeNull();
		expect(queryByText("topbar_prompt_preset")).toBeNull();
		// No attachment paperclip (RP InputArea's only file input is the clip).
		expect(queryByText("attach_image")).toBeNull();
		// useModuleSwitch fires an async module-list load on mount; drain its
		// trailing setModules/setLoading so they don't warn about a state update
		// outside act(). One macrotask flushes the whole .then/.finally chain.
		await act(async () => { await new Promise((r) => setTimeout(r)); });
	});
});
