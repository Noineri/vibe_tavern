/**
 * AgentProfileChip (DIRECTOR_MODE_PLAN DR-6, mockup §2) tests.
 *
 * Pins:
 *   - the label is HIDDEN while the effective profile is the kind's first
 *     built-in (the seed) — for a chat-target host (no chat choice, no kind
 *     default) and for a script-target host (nothing assigned) — and SHOWN
 *     for every other effective profile (a second built-in, a user profile,
 *     and a chat choice under no default), rendering the profile's name;
 *   - the menu rows carry the origin tags
 *     (agent_profile_chip_tag_builtin / agent_profile_chip_tag_own keys) and
 *     a check on the effective row, which is a non-interactive indicator;
 *   - choosing a row writes EXACTLY what the settings summary's profile
 *     dropdown writes today: chat-target hosts PATCH the (chat, kind) row
 *     with the selected id
 *     verbatim (the seed pins the "builtin" sentinel), script-target hosts
 *     write setCopilotProfile(id | null); the label follows a successful
 *     write (and the seed choice hides the chip again);
 *   - the edit-profiles row (agent_settings_edit_profiles) hands off
 *     through onOpenProfiles.
 *
 * The controlled Radix popover never mounts its content under happy-dom —
 * the shared seam is registered with `stubAllRoots: true` so the menu rows
 * are queryable at rest (this file's registration is live for its own run
 * only; the popover parts ride the seam's deterministic stub).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { installRadixPopoverSeam } from "../../../../test/radix-popover-seam.js";

useDomEnv();
// Controlled `<Popover.Root open={…}>` — stub controlled roots too so the
// menu renders inline at rest (see the file header).
installRadixPopoverSeam({ stubAllRoots: true });
// Identity `t`: the tag assertions pin WHICH keys the menu reads.
installI18nContextSeam();

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";

// ── SAFE module mocks (capture real first, spread `...real`) ───────────────
const realProfileApi = await import("../../../api/copilot-profile-api.js");
const realChatSettingsApi = await import("../../../api/agent-chat-settings-api.js");

/** The kind's seed — its id IS the BUILTIN_PROFILE_ID sentinel. */
const SEED: CopilotProfile = {
	id: "builtin",
	name: "Out of character",
	isBuiltIn: true,
	basePrompt: "You chat out of character.",
	toolSet: {},
	agentKind: "dr6-chat",
};
/** A second built-in (the director, DR-1's shape). */
const DIRECTOR: CopilotProfile = {
	id: "builtin-director",
	name: "Director",
	isBuiltIn: true,
	basePrompt: "You direct the story.",
	toolSet: { propose_plan: true },
	agentKind: "dr6-chat",
};
const USER: CopilotProfile = {
	id: "cprof_1",
	name: "My grim director",
	isBuiltIn: false,
	basePrompt: "You direct, grimly.",
	toolSet: {},
	agentKind: "dr6-chat",
};
const ALL_PROFILES = [SEED, DIRECTOR, USER];

const listCopilotProfiles = mock(() => Promise.resolve(ALL_PROFILES));
const setCopilotProfile = mock(async (_scriptId: string, _profileId: string | null) => undefined);
mock.module("../../../api/copilot-profile-api.js", () => ({
	...realProfileApi,
	listCopilotProfiles,
	setCopilotProfile,
}));

// The (chat, kind) row the hook reads on mount and the write arm asserts.
const getAgentChatSettings = mock(async (_chatId: string, _kind: string) => ({
	chatId: _chatId,
	agentKind: _kind,
	profileId: null as string | null,
	updatedAt: null as string | null,
}));
const patchAgentChatSettings = mock(async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
	chatId: _chatId,
	agentKind: _kind,
	profileId: _patch.profileId ?? null,
	updatedAt: "",
}));
mock.module("../../../api/agent-chat-settings-api.js", () => ({
	...realChatSettingsApi,
	getAgentChatSettings,
	patchAgentChatSettings,
}));

// DR-6 has no production chat-owned host yet (SC-13 registers the first) —
// the chat branch rides a fixture descriptor whose profileAssignment
// targets "chat" (the SC-0g fixture pattern; nothing kind-specific is
// hardcoded in the chip — the variant renders purely from this field).
const CHAT_KIND = "dr6-chat";
const CHAT_ID = "chat-1";

let AgentProfileChip: typeof import("./AgentProfileChip.js").AgentProfileChip;
let LocaleProvider: typeof import("../../../i18n/context.js").LocaleProvider;
beforeAll(async () => {
	// The real experience host registers the script-target variant (and the
	// shared transport the fixture borrows).
	await import("../../build/editors/copilot/experience-agent-host.js");
	const { getAgentHost, registerAgentHost } = await import("../../../lib/agent-host-registry.js");
	registerAgentHost({
		kind: CHAT_KIND,
		i18n: {
			title: "agent_title",
			kindLabel: "agent_kind_sidechat",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		starterPromptKeys: [
			"agent_starter_sidechat_recap",
			"agent_starter_sidechat_feelings",
			"agent_starter_sidechat_twists",
			"agent_starter_sidechat_pacing",
		],
		toolKeys: ["ask_user"],
		profileAssignment: { target: "chat" },
		messageMarkup: "plain",
		bufferSpecs: [],
		transport: getAgentHost("experience").transport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
	});
	({ AgentProfileChip } = await import("./AgentProfileChip.js"));
});

function resetStores(): void {
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useBootstrapStore.setState({ data: null, personas: null, isLoading: false });
}

beforeEach(() => {
	listCopilotProfiles.mockReset();
	listCopilotProfiles.mockResolvedValue(ALL_PROFILES);
	setCopilotProfile.mockReset();
	setCopilotProfile.mockResolvedValue(undefined);
	getAgentChatSettings.mockReset();
	getAgentChatSettings.mockResolvedValue({
		chatId: CHAT_ID,
		agentKind: CHAT_KIND,
		profileId: null,
		updatedAt: null,
	});
	patchAgentChatSettings.mockReset();
	patchAgentChatSettings.mockImplementation(async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
		chatId: _chatId,
		agentKind: _kind,
		profileId: _patch.profileId ?? null,
		updatedAt: "",
	}));
	resetStores();
});

afterEach(() => {
	resetStores();
});

interface RenderChipOver {
	agentKind?: string;
	scriptId?: string;
	chatId?: string;
	assignedProfileId?: string | null;
}

function renderChip(over: RenderChipOver = {}) {
	const onOpenProfiles = mock(() => undefined);
	const utils = render(
		<AgentProfileChip
			agentKind={over.agentKind ?? CHAT_KIND}
			scriptId={over.scriptId}
			chatId={over.chatId ?? CHAT_ID}
			assignedProfileId={over.assignedProfileId ?? null}
			onOpenProfiles={onOpenProfiles}
		/>,
	);
	return { ...utils, onOpenProfiles };
}

describe("AgentProfileChip — label visibility (mockup §2)", () => {
	it("is hidden while the chat resolves to the kind's first built-in (seed)", async () => {
		// No chat choice, no kind default → the resolver chain lands on the seed.
		const { queryByTestId } = renderChip();
		// The read + list load settle; the chip must stay absent.
		await waitFor(() => expect(listCopilotProfiles).toHaveBeenCalled());
		await waitFor(() => expect(getAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND));
		expect(queryByTestId("agent-profile-chip")).toBeNull();
		expect(queryByTestId("agent-profile-menu-edit")).toBeNull();
	});

	it("is hidden before the profiles list loads, then appears for a chat choice", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "cprof_1",
			updatedAt: "",
		});
		const { queryByTestId, getByTestId } = renderChip();
		expect(queryByTestId("agent-profile-chip")).toBeNull();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My grim director"));
	});

	it("shows a second built-in's name when the chat resolves to it", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("Director"));
	});

	it("script-target host: hidden when nothing is assigned, shown for the assigned profile", async () => {
		const hidden = renderChip({ agentKind: "experience", scriptId: "script-1", chatId: undefined, assignedProfileId: null });
		await waitFor(() => expect(listCopilotProfiles).toHaveBeenCalledWith("experience"));
		expect(hidden.queryByTestId("agent-profile-chip")).toBeNull();
		hidden.unmount();

		const shown = renderChip({ agentKind: "experience", scriptId: "script-1", chatId: undefined, assignedProfileId: "cprof_1" });
		await waitFor(() => expect(shown.getByTestId("agent-profile-chip").textContent).toContain("My grim director"));
	});
});

describe("AgentProfileChip — menu rows (tags + check)", () => {
	it("tags built-ins and user profiles; the effective row carries the check and is not a switch target", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("Director"));

		const active = getByTestId("agent-profile-menu-row-builtin-director");
		expect(active.getAttribute("data-active")).toBe("true");
		// The switcher's active-row rule: a non-interactive indicator.
		expect(active.tagName).not.toBe("BUTTON");

		const seed = getByTestId("agent-profile-menu-row-builtin");
		const user = getByTestId("agent-profile-menu-row-cprof_1");
		expect(seed.getAttribute("data-active")).toBe("false");
		expect(user.getAttribute("data-active")).toBe("false");
		expect(seed.tagName).toBe("BUTTON");
		expect(user.tagName).toBe("BUTTON");

		// Origin tags (identity `t` — the raw keys): both built-ins tagged
		// built-in, the user one own.
		expect(active.textContent).toContain("agent_profile_chip_tag_builtin");
		expect(seed.textContent).toContain("agent_profile_chip_tag_builtin");
		expect(user.textContent).toContain("agent_profile_chip_tag_own");
		expect(seed.textContent).not.toContain("agent_profile_chip_tag_own");
	});

	it("the profile list scrolls on the thin ScrollArea lane; the edit row stays docked (CNR-8h)", async () => {
		// The 8d DropdownSelect popup idiom (the same wiring as
		// AgentSessionSwitcher, whose popover chrome this menu clones): the
		// max-h cap moved onto the ScrollArea root, the p-1 row padding
		// scrolls with the content, and the edit-profiles dock stays OUTSIDE
		// the scroller. Choose/edit callbacks untouched (pinned above).
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip")).toBeTruthy());
		const area = getByTestId("agent-profile-menu-row-builtin").closest<HTMLElement>("[data-scroll-area]")!;
		expect(area.getAttribute("data-scroll-area")).toBe("thin");
		expect(area.className).toContain("max-h-[280px]");
		expect(area.querySelector("[data-scroll-content]")!.className).toContain("p-1");
		expect(area.querySelector("[data-scroll-viewport]")!.classList.contains("scrollbar-hide")).toBe(true);
		expect(getByTestId("agent-profile-menu-edit").closest("[data-scroll-area]")).toBeNull();
		// Fake an overflowing list (happy-dom has no layout) → the vertical lane mounts.
		const viewport = area.querySelector<HTMLElement>("[data-scroll-viewport]")!;
		Object.defineProperties(viewport, {
			clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
			clientWidth: { value: 200 }, scrollWidth: { value: 200 },
		});
		await act(async () => {
			viewport.scrollTop = 200;
			fireEvent.scroll(viewport);
		});
		await waitFor(() => expect(area.querySelector("[data-scroll-thumb]")).not.toBeNull());
		expect(area.querySelector("[data-scroll-track]")?.getAttribute("data-orientation")).toBe("vertical");
	});
});

describe("AgentProfileChip — writes (the settings profile-row surface)", () => {
	it("choosing a user profile PATCHes the (chat, kind) row with the id verbatim", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("Director"));

		fireEvent.click(getByTestId("agent-profile-menu-row-cprof_1"));
		// Exactly what the settings dropdown / the profile modal's «Use
		// here» write for a chat-target host.
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND, { profileId: "cprof_1" }));
		// The label follows the write through the hook's own instance.
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My grim director"));
	});

	it("choosing the seed pins the literal sentinel (the chat runs the seed even under a default)", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "cprof_1",
			updatedAt: "",
		});
		const { getByTestId, queryByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My grim director"));

		fireEvent.click(getByTestId("agent-profile-menu-row-builtin"));
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND, { profileId: "builtin" }));
		// Back on the seed → the chip disappears again.
		await waitFor(() => expect(queryByTestId("agent-profile-chip")).toBeNull());
	});

	it("script-target host: choosing the built-in unassigns via null, a user profile writes its id", async () => {
		const { getByTestId } = renderChip({ agentKind: "experience", scriptId: "script-1", chatId: undefined, assignedProfileId: "cprof_1" });
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("My grim director"));

		fireEvent.click(getByTestId("agent-profile-menu-row-builtin"));
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", null));

		fireEvent.click(getByTestId("agent-profile-menu-row-builtin-director"));
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", "builtin-director"));
	});

	it("a failed write unparks the choice — re-choosing the same profile retries", async () => {
		patchAgentChatSettings.mockRejectedValue(new Error("write failed"));
		// Effective: a second built-in (so the chip is visible throughout).
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("Director"));

		fireEvent.click(getByTestId("agent-profile-menu-row-cprof_1"));
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledTimes(1));
		// The label keeps the effective profile (the write failed)…
		expect(getByTestId("agent-profile-chip").textContent).toContain("Director");
		// …and the same choice retries (the park was cleared by onFailed).
		patchAgentChatSettings.mockImplementation(async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
			chatId: _chatId,
			agentKind: _kind,
			profileId: _patch.profileId ?? null,
			updatedAt: "",
		}));
		fireEvent.click(getByTestId("agent-profile-menu-row-cprof_1"));
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledTimes(2));
	});
});

describe("AgentProfileChip — the edit-profiles row", () => {
	it("hands off through onOpenProfiles", async () => {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: CHAT_KIND,
			profileId: "builtin-director",
			updatedAt: "",
		});
		const { getByTestId, onOpenProfiles } = renderChip();
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toContain("Director"));

		expect(getByTestId("agent-profile-menu-edit").textContent).toContain("agent_settings_edit_profiles");
		fireEvent.click(getByTestId("agent-profile-menu-edit"));
		expect(onOpenProfiles).toHaveBeenCalledTimes(1);
	});
});

// ─── DR-7: localized built-in names — real RU (consumer surface #1) ─────────
// The two SIDECHAT built-ins render through the ONE display-name derivation
// («Вне роли» / «Режиссёр"); user profiles and other kinds stay raw (their
// pins live above — "Director"/"My grim director" under the fixture kind).
// Real RU via a mounted LocaleProvider (the AgentTimelineSeparator
// precedent — the context seam DELEGATES when a provider is ready);
// provider-less renders in this file keep the identity echo (R13-safe).
describe("AgentProfileChip — localized built-in names (DR-7)", () => {
	/** The REAL sidechat kind's list — the only kind whose built-ins localize. */
	const SIDECHAT_LIST: CopilotProfile[] = [
		{ id: "builtin", name: "Sidechat OOC", isBuiltIn: true, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
		{ id: "builtin-director", name: "Director", isBuiltIn: true, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
		{ id: "cprof_1", name: "My grim director", isBuiltIn: false, basePrompt: "", toolSet: {}, agentKind: "sidechat-ooc" },
	];

	beforeAll(async () => {
		// Real RU resources (bundled — synchronously available after init);
		// the explicit changeLanguage makes this order-independent, the
		// afterAll restores EN (the R13 contract).
		const { initI18n, i18next: i18nInstance } = await import("../../../i18n/i18n.js");
		initI18n("ru");
		await i18nInstance.changeLanguage("ru");
		// The REAL sidechat host registers the kind under test.
		await import("../../chat/sidechat/sidechat-host.js");
		({ LocaleProvider } = await import("../../../i18n/context.js"));
	});

	afterAll(async () => {
		const { i18next } = await import("../../../i18n/i18n.js");
		await i18next.changeLanguage("en");
	});

	function renderRuChip(profileId: string | null) {
		getAgentChatSettings.mockResolvedValue({
			chatId: CHAT_ID,
			agentKind: "sidechat-ooc",
			profileId,
			updatedAt: "",
		});
		listCopilotProfiles.mockResolvedValue(SIDECHAT_LIST);
		return render(
			<LocaleProvider initialLocale="ru">
				<AgentProfileChip agentKind="sidechat-ooc" chatId={CHAT_ID} assignedProfileId={null} onOpenProfiles={mock()} />
			</LocaleProvider>,
		);
	}

	it("the director built-in renders «Режиссёр» in the label and the menu rows localize both built-ins (a user row stays raw)", async () => {
		const { getByTestId } = renderRuChip("builtin-director");
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toBe("Режиссёр"));
		// Menu rows (the popover seam renders them inline at rest): the seed
		// «Вне роли», the director «Режиссёр», the user profile its raw name.
		expect(getByTestId("agent-profile-menu-row-builtin").textContent).toContain("Вне роли");
		expect(getByTestId("agent-profile-menu-row-builtin-director").textContent).toContain("Режиссёр");
		expect(getByTestId("agent-profile-menu-row-cprof_1").textContent).toContain("My grim director");
	});

	it("a user profile effective renders its raw stored name (never localized)", async () => {
		const { getByTestId } = renderRuChip("cprof_1");
		await waitFor(() => expect(getByTestId("agent-profile-chip").textContent).toBe("My grim director"));
	});
});
