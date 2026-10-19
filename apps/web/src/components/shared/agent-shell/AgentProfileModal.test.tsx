/**
 * Wave 3 / CP-9 — copilot profile manager (MasterDetail) tests.
 *
 * Mirrors `CoauthorModuleModal.test.tsx` but for the copilot profile modal
 * (controlled: `isOpen` is a prop, not the global modal store). Pins:
 *   - lists profiles on open; built-in seed first, read-only (no edit/delete);
 *   - user profiles show edit + delete affordances;
 *   - "+ New profile" opens a blank editor; empty name blocks save (no RPC);
 *   - "Duplicate" on the built-in seed opens a create editor with a copy suffix;
 *   - editing a user profile populates the editor and Save calls update;
 *   - NO skill toggles render and the skill catalog is never fetched (PM-8 —
 *     skills are ungated, so the profile editor has no skill surface);
 *   - assigning a user profile calls setCopilotProfile(scriptId, id); assigning
 *     the built-in seed calls setCopilotProfile(scriptId, null) (unassign);
 *   - deleting a user profile asks for confirmation then calls remove.
 *
 * Input typing is not simulated here (same happy-dom limitation noted in the
 * co-author suite) — buttons → handler → RPC wiring + mode transitions are what
 * is pinned.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useCopilotSkillStore } from "../../../stores/copilot-skill-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import { COPILOT_TOOL_KEYS, SCRIPT_AGENT_TOOL_KEYS, type CopilotProfile, type CopilotProfileCreate, type CopilotProfileUpdate } from "@vibe-tavern/api-contracts";

// ── SAFE module mocks (capture real first, spread `...real`) ───────────────
const realI18nContext = await import("../../../i18n/context.js");
const realProfileApi = await import("../../../api/copilot-profile-api.js");
const realSkillApi = await import("../../../api/copilot-skill-api.js");
const realMasterDetailModal = await import("../MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../destructive-confirm-modal.js");

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const BUILTIN: CopilotProfile = {
	id: "builtin",
	name: "Experience Authoring",
	isBuiltIn: true,
	basePrompt: "You author interactive experiences.",
	toolSet: { write_buffer: true, edit_buffer: true, run_test: true },
	agentKind: "experience",
};

const USER: CopilotProfile = {
	id: "cprof_1",
	name: "Card games",
	isBuiltIn: false,
	basePrompt: "You help author card-game experiences.",
	toolSet: { write_buffer: true, run_test: true },
	agentKind: "experience",
};

const ALL_PROFILES = [BUILTIN, USER];

const SCRIPT_BUILTIN: CopilotProfile = {
	id: "builtin",
	name: "Script Authoring",
	isBuiltIn: true,
	basePrompt: "You author scripts.",
	toolSet: { write_buffer: true, edit_buffer: true, run_script_test: true },
	agentKind: "script",
};

const SCRIPT_USER: CopilotProfile = {
	id: "cprof_script_1",
	name: "Dice helpers",
	isBuiltIn: false,
	basePrompt: "You help author dice scripts.",
	toolSet: { write_buffer: true, run_script_test: true },
	agentKind: "script",
};

const listCopilotProfiles = mock(() => Promise.resolve(ALL_PROFILES));
const createCopilotProfile = mock(async (_input: CopilotProfileCreate) => USER);
const updateCopilotProfile = mock(async (_id: string, _input: CopilotProfileUpdate) => USER);
const deleteCopilotProfile = mock(async (_id: string) => undefined);
const setCopilotProfile = mock(async (_scriptId: string, _profileId: string | null) => undefined);

// SC-0g: the chat-variant wiring — the SC-0f chat-row client and the SC-0d
// kind-default action (both mocked; the modal's two buttons pin their targets).
const getAgentChatSettings = mock(async (_chatId: string, _kind: string) => ({
	chatId: _chatId,
	agentKind: _kind,
	profileId: null as string | null,
	updatedAt: "" as string | null,
}));
const patchAgentChatSettings = mock(async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
	chatId: _chatId,
	agentKind: _kind,
	profileId: _patch.profileId ?? null,
	updatedAt: "",
}));
const patchAgentKindSettingsAction = mock(async (_kind: string, _patch: { defaultProfileId?: string | null }) => ({
	agentKind: _kind,
	providerProfileId: null,
	modelName: null,
	defaultProfileId: _patch.defaultProfileId ?? null,
	updatedAt: "",
}));

mock.module("../../../api/copilot-profile-api.js", () => ({
	...realProfileApi,
	listCopilotProfiles,
	createCopilotProfile,
	updateCopilotProfile,
	deleteCopilotProfile,
	setCopilotProfile,
}));

const realChatSettingsApi = await import("../../../api/agent-chat-settings-api.js");
const realBootstrapActions = await import("../../../stores/api-actions/bootstrap-actions.js");

const SKILL_CATALOG = {
	entries: [
		{ id: "experience-authoring", source: "builtin" as const, name: "Experience Authoring", description: "Craft guidance.", manifestPath: "experience-authoring/SKILL.md", shadowsBuiltin: false },
	],
	errors: [],
};
const listCopilotSkills = mock(() => Promise.resolve(SKILL_CATALOG));
mock.module("../../../api/copilot-skill-api.js", () => ({
	...realSkillApi,
	listCopilotSkills,
	readCopilotSkill: mock(),
	importCopilotSkills: mock(),
	deleteCopilotSkill: mock(),
}));

mock.module("../../../api/agent-chat-settings-api.js", () => ({
	...realChatSettingsApi,
	getAgentChatSettings,
	patchAgentChatSettings,
}));

mock.module("../../../stores/api-actions/bootstrap-actions.js", () => ({
	...realBootstrapActions,
	patchAgentKindSettingsAction,
}));

// MasterDetailModal passthrough (render master + detail + footer + headerActions flat).
mock.module("../MasterDetailModal.js", () => ({
	...realMasterDetailModal,
	MasterDetailModal: ({ isOpen, onClose, masterContent, detailContent, footer, headerActions }: {
		isOpen: boolean;
		onClose: () => void;
		masterContent: unknown;
		detailContent: unknown;
		footer: unknown;
		headerActions: unknown;
	}) => {
		if (!isOpen) return null;
		const resolve = (c: unknown) => (typeof c === "function" ? (c as (ctx: { openDetail: () => void; closeDetail: () => void }) => React.ReactNode)({ openDetail: () => {}, closeDetail: () => {} }) : c);
		return (
			<div data-testid="md-modal">
				<div data-testid="md-header-actions">{headerActions as React.ReactNode}</div>
				<div data-testid="md-master">{resolve(masterContent) as React.ReactNode}</div>
				<div data-testid="md-detail">{resolve(detailContent) as React.ReactNode}</div>
				<div data-testid="md-footer">{footer as React.ReactNode}</div>
				<button type="button" onClick={onClose} data-testid="md-close">close</button>
			</div>
		);
	},
	MasterDetailMobileDrillDown: () => null,
	useMasterDetail: () => ({ isMobile: false, isDetailOpen: true, openDetail: () => {}, closeDetail: () => {} }),
}));

mock.module("../destructive-confirm-modal.js", () => ({
	...realDestructiveConfirmModal,
	DestructiveConfirmModal: ({ title, confirmLabel, onConfirm, onCancel }: {
		title: string; body: React.ReactNode; confirmLabel: string;
		onConfirm: () => void; onCancel: () => void;
	}) => (
		<div data-testid="confirm-modal">
			<div>{title}</div>
			<button type="button" data-testid="confirm-cancel" onClick={onCancel}>cancel</button>
			<button type="button" data-testid="confirm-ok" onClick={onConfirm}>{confirmLabel}</button>
		</div>
	),
}));

// SC-0g: the chat-variant fixture — no production chat-owned host exists yet
// (SC-13 registers the first), so the chat branch is exercised with a fixture
// descriptor whose profileAssignment targets "chat". Nothing chat-kind-
// specific is hardcoded in the modal; the variant renders purely from this field.
const CHAT_KIND = "sc0g-chat";
const CHAT_ID = "chat-1";

const CHAT_BUILTIN: CopilotProfile = {
	id: "builtin",
	name: "Sidechat Authoring",
	isBuiltIn: true,
	basePrompt: "You author sidechat assistants.",
	toolSet: { ask_user: true },
	agentKind: CHAT_KIND,
};

const CHAT_HERE: CopilotProfile = {
	id: "cprof_here",
	name: "Here choice",
	isBuiltIn: false,
	basePrompt: "You help here.",
	toolSet: { ask_user: true },
	agentKind: CHAT_KIND,
};

const CHAT_DEFAULT: CopilotProfile = {
	id: "cprof_default",
	name: "Default choice",
	isBuiltIn: false,
	basePrompt: "You help by default.",
	toolSet: { ask_user: true },
	agentKind: CHAT_KIND,
};

const CHAT_PROFILES = [CHAT_BUILTIN, CHAT_HERE, CHAT_DEFAULT];

function chatSettingsRow(profileId: string | null): {
	chatId: string;
	agentKind: string;
	profileId: string | null;
	updatedAt: string | null;
} {
	return { chatId: CHAT_ID, agentKind: CHAT_KIND, profileId, updatedAt: "" };
}

let AgentProfileModal: typeof import("./AgentProfileModal.js").AgentProfileModal;
beforeAll(async () => {
	// The modal reads the toggleable tool keys from the registered host
	// descriptor; importing the real host modules registers both kinds (this
	// file never unregisters them — the worker isolates the module registry).
	await import("../../build/editors/copilot/experience-agent-host.js");
	await import("../../build/editors/script-agent-host.js");
	// SC-0g: the chat-target fixture host (see above — no production chat
	// host exists yet). Registered once, never unregistered, like the real
	// hosts above.
	const { getAgentHost, registerAgentHost } = await import("../../../lib/agent-host-registry.js");
	registerAgentHost({
		kind: CHAT_KIND,
		i18n: {
			title: "agent_title",
			placeholder: "agent_input_placeholder",
			loading: "agent_loading",
			emptyTitle: "agent_title",
		},
		toolKeys: ["ask_user"],
		profileAssignment: { target: "chat" },
		bufferSpecs: [],
		transport: getAgentHost("experience").transport,
		buildSendOptions: () => ({}),
		recordProposalRenderers: {},
	});
	({ AgentProfileModal } = await import("./AgentProfileModal.js"));
});

beforeEach(() => {
	listCopilotProfiles.mockReset();
	listCopilotProfiles.mockResolvedValue(ALL_PROFILES);
	listCopilotSkills.mockReset();
	listCopilotSkills.mockResolvedValue(SKILL_CATALOG);
	createCopilotProfile.mockReset();
	updateCopilotProfile.mockReset();
	deleteCopilotProfile.mockReset();
	setCopilotProfile.mockReset();
	createCopilotProfile.mockResolvedValue(USER);
	updateCopilotProfile.mockResolvedValue(USER);
	deleteCopilotProfile.mockResolvedValue(undefined);
	setCopilotProfile.mockResolvedValue(undefined);
	// SC-0g: the chat-variant wiring starts empty — no chat-row override, no
	// kind default (the built-in seed is the effective default).
	getAgentChatSettings.mockReset();
	getAgentChatSettings.mockResolvedValue(chatSettingsRow(null));
	patchAgentChatSettings.mockReset();
	patchAgentChatSettings.mockImplementation(async (_chatId: string, _kind: string, _patch: { profileId?: string | null }) => ({
		chatId: _chatId,
		agentKind: _kind,
		profileId: _patch.profileId ?? null,
		updatedAt: "",
	}));
	patchAgentKindSettingsAction.mockReset();
	patchAgentKindSettingsAction.mockImplementation(async (_kind: string, _patch: { defaultProfileId?: string | null }) => ({
		agentKind: _kind,
		providerProfileId: null,
		modelName: null,
		defaultProfileId: _patch.defaultProfileId ?? null,
		updatedAt: "",
	}));
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ catalogs: {}, isLoading: false });
	seedKindDefault(null);
});

afterEach(() => {
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ catalogs: {}, isLoading: false });
	useBootstrapStore.setState({ data: null, personas: null, isLoading: false });
});

// SC-0g: seed the bootstrap kind-settings map's default for the fixture chat
// kind (the modal reads it as the "use by default" state).
function seedKindDefault(defaultProfileId: string | null): void {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: [],
			uiSettings: wireUiSettings(),
			agentKindSettings: {
				[CHAT_KIND]: {
					agentKind: CHAT_KIND,
					providerProfileId: null,
					modelName: null,
					defaultProfileId,
					updatedAt: "",
				},
			},
			isArmServer: false,
		},
	});
}

function renderModal(over: { scriptId?: string; agentKind?: string; assignedProfileId?: string | null; chatId?: string } = {}) {
	const props = {
		scriptId: "script-1",
		agentKind: "experience",
		assignedProfileId: null,
		isOpen: true,
		onClose: mock(),
		...over,
	};
	const utils = render(<AgentProfileModal {...props} />);
	return { ...utils, props };
}

async function flush(getByTestId: (id: string) => HTMLElement) {
	await waitFor(() => expect(getByTestId("copilot-profile-row-builtin")).toBeDefined());
}

describe("CopilotProfileModal — list", () => {
	it("lists the built-in seed + user profiles; built-in is read-only", async () => {
		const { getByTestId, queryByTestId } = renderModal();
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-row-builtin")).toBeDefined();
		expect(getByTestId("copilot-profile-row-cprof_1")).toBeDefined();
		// Built-in has no edit/delete affordances.
		expect(queryByTestId("copilot-profile-edit-btn-builtin")).toBeNull();
		expect(queryByTestId("copilot-profile-delete-btn-builtin")).toBeNull();
		// User profile has both.
		expect(getByTestId("copilot-profile-edit-btn-cprof_1")).toBeDefined();
		expect(getByTestId("copilot-profile-delete-btn-cprof_1")).toBeDefined();
	});

	it("highlights the assigned profile (null assignment → built-in active)", async () => {
		const { getByTestId } = renderModal({ assignedProfileId: null });
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-row-builtin").textContent).toContain("★");
	});

	it("highlights a user assignment", async () => {
		const { getByTestId } = renderModal({ assignedProfileId: "cprof_1" });
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-row-cprof_1").textContent).toContain("★");
	});
});

describe("CopilotProfileModal — duplicate built-in", () => {
	it("opens a create editor pre-filled with the seed + copy suffix", async () => {
		const { getByTestId } = renderModal();
		await flush(getByTestId);
		// Select the built-in seed → the detail view shows the duplicate button.
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-view-duplicate-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-view-duplicate-btn"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		const value = getByTestId("copilot-profile-name-input").getAttribute("value") ?? "";
		expect(value).toContain("Experience Authoring");
		// The suffix key is returned verbatim by the mocked useT.
		expect(value).toContain("copilot_profile_duplicate_suffix");
	});
});

describe("CopilotProfileModal — new profile validation", () => {
	it("blocks saving a blank name (no RPC)", async () => {
		const { getByTestId } = renderModal();
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-new-btn"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		// Save with a blank name → client validation blocks, no create RPC.
		fireEvent.click(getByTestId("copilot-profile-save-btn"));
		await new Promise((r) => setTimeout(r, 0));
		expect(createCopilotProfile).not.toHaveBeenCalled();
	});
});

describe("CopilotProfileModal — edit user profile", () => {
	it("populates the editor and Save calls update", async () => {
		const { getByTestId } = renderModal();
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-edit-btn-cprof_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		expect(getByTestId("copilot-profile-name-input").getAttribute("value")).toBe("Card games");
		fireEvent.click(getByTestId("copilot-profile-save-btn"));
		await waitFor(() => expect(updateCopilotProfile).toHaveBeenCalledTimes(1));
		expect(updateCopilotProfile).toHaveBeenCalledWith("cprof_1", expect.objectContaining({ name: "Card games" }));
	});

	it("renders all eight tool toggles and no step-limit input (TAG-10)", async () => {
		const { getByTestId, queryByRole, getByText } = renderModal();
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-edit-btn-cprof_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		// PM-7 (behavior change, owner ruling 2026-10-11): `todo` is a real
		// toggleable key again — the list pins NINE keys (same boundary as
		// before: every COPILOT_TOOL_KEYS entry renders, read_skill_file never
		// does).
		const toolKeys = ["edit_buffer", "write_buffer", "run_test", "run_simulate", "suggest_visual_binding", "plan", "read_plan", "todo", "ask_user"];
		for (const key of toolKeys) {
			expect(getByText(key)).toBeDefined();
		}
		// No step-limit number input remains.
		expect(queryByRole("spinbutton")).toBeNull();
	});

	it("renders no skill toggles and never fetches the skill catalog (PM-8: skills ungated)", async () => {
		const { getByTestId, getByText, queryByText } = renderModal();
		await flush(getByTestId);
		// Edit mode: no Skills field, no catalog-driven toggle chips (the mocked
		// useT returns keys verbatim, so the Skills label would surface as its
		// i18n key if the section still existed).
		fireEvent.click(getByTestId("copilot-profile-edit-btn-cprof_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		expect(queryByText("copilot_profile_skills")).toBeNull();
		expect(queryByText("experience-authoring")).toBeNull();
		expect(queryByText("copilot_profile_skills_hint")).toBeNull();
		// View mode (built-in seed): no skills row either — only the base prompt
		// and the tool chips render.
		fireEvent.click(getByTestId("copilot-profile-cancel-btn"));
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-view-duplicate-btn")).toBeDefined());
		expect(queryByText("copilot_profile_skills")).toBeNull();
		expect(getByText("copilot_profile_tools")).toBeDefined();
		// The skill catalog RPC was profile-toggle-only wiring — never called.
		expect(listCopilotSkills).not.toHaveBeenCalled();
	});
});

describe("CopilotProfileModal — host-owned tool keys", () => {
	// The tool toggles are the buttons inside the tools field, in render order.
	function renderedToolKeys(getByText: (text: string) => HTMLElement): string[] {
		const field = getByText("copilot_profile_tools").parentElement;
		return Array.from(field?.querySelectorAll("button") ?? []).map((b) => b.textContent ?? "");
	}

	it("an experience modal lists exactly COPILOT_TOOL_KEYS, in order", async () => {
		const { getByTestId, getByText } = renderModal({ agentKind: "experience" });
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-edit-btn-cprof_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		expect(renderedToolKeys(getByText)).toEqual([...COPILOT_TOOL_KEYS]);
	});

	it("a script modal lists the script tool toggles and none of the experience-only ones", async () => {
		listCopilotProfiles.mockResolvedValue([SCRIPT_BUILTIN, SCRIPT_USER]);
		const { getByTestId, getByText } = renderModal({ agentKind: "script" });
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-edit-btn-cprof_script_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-editor")).toBeDefined());
		const keys = renderedToolKeys(getByText);
		expect(keys).toEqual([...SCRIPT_AGENT_TOOL_KEYS]);
		expect(keys).toContain("run_script_test");
		expect(keys).not.toContain("run_simulate");
		expect(keys).not.toContain("suggest_visual_binding");
	});

	it("the read-only view of a script profile projects through the script keys", async () => {
		listCopilotProfiles.mockResolvedValue([SCRIPT_BUILTIN, SCRIPT_USER]);
		const { getByTestId, getByText, queryByText } = renderModal({ agentKind: "script" });
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-view-duplicate-btn")).toBeDefined());
		expect(getByText("run_script_test")).toBeDefined();
		expect(queryByText("run_test")).toBeNull();
	});
});

describe("CopilotProfileModal — assignment", () => {
	it("assigns a user profile by writing its id", async () => {
		const { getByTestId } = renderModal();
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_1"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-btn"));
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", "cprof_1"));
	});

	it("assigning the built-in seed writes null (unassign)", async () => {
		const { getByTestId } = renderModal({ assignedProfileId: "cprof_1" });
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-btn"));
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", null));
	});
});

describe("CopilotProfileModal — delete user profile", () => {
	it("asks for confirmation then removes", async () => {
		const { getByTestId, queryByTestId } = renderModal();
		await flush(getByTestId);
		fireEvent.click(getByTestId("copilot-profile-delete-btn-cprof_1"));
		await waitFor(() => expect(getByTestId("confirm-modal")).toBeDefined());
		expect(queryByTestId("confirm-cancel")).toBeDefined();
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(deleteCopilotProfile).toHaveBeenCalledWith("cprof_1"));
	});
});

describe("CopilotProfileModal — script modal unchanged (SC-0g)", () => {
	it("renders the single action only (no chat buttons)", async () => {
		const { getByTestId, queryByTestId } = renderModal();
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-assign-btn")).toBeDefined();
		expect(queryByTestId("copilot-profile-assign-here-btn")).toBeNull();
		expect(queryByTestId("copilot-profile-assign-default-btn")).toBeNull();
	});
});

describe("CopilotProfileModal — chat-target host (SC-0g)", () => {
	function renderChatModal(chatProfileId: string | null = null, kindDefault: string | null = null) {
		listCopilotProfiles.mockResolvedValue(CHAT_PROFILES);
		getAgentChatSettings.mockResolvedValue(chatSettingsRow(chatProfileId));
		seedKindDefault(kindDefault);
		return renderModal({ agentKind: CHAT_KIND, chatId: CHAT_ID, assignedProfileId: null });
	}

	it("marks the chat row's choice and the kind default", async () => {
		const { getByTestId } = renderChatModal("cprof_here", "cprof_default");
		await flush(getByTestId);
		// The mocked useT returns keys verbatim, so the pills surface as keys.
		expect(getByTestId("copilot-profile-row-cprof_here").textContent).toContain("★");
		expect(getByTestId("copilot-profile-row-cprof_default").textContent).toContain("copilot_profile_default");
		expect(getByTestId("copilot-profile-row-builtin").textContent).not.toContain("copilot_profile_default");
		// The (mocked) chat-row GET ran for this chat + kind.
		await waitFor(() => expect(getAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND));
	});

	it("with no chat-row override the kind default is marked active (null default → the seed)", async () => {
		// SC-0k (was: nothing was marked here when the chat followed the
		// default — basis: owner decision 3, refined 2026-10-19): the active
		// mark sits on the EFFECTIVE profile, so the default row carries it.
		const { getByTestId } = renderChatModal(null, null);
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-row-cprof_here").textContent).not.toContain("★");
		expect(getByTestId("copilot-profile-row-builtin").textContent).toContain("★");
		expect(getByTestId("copilot-profile-row-builtin").textContent).toContain("copilot_profile_default");
	});

	it("each button swaps to its state label when the selection already holds that state", async () => {
		const { getByTestId } = renderChatModal("cprof_here", "cprof_default");
		await flush(getByTestId);
		// Selecting the here-choice: here-button is the state, default-button the action.
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_here"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-here-btn").textContent).toContain("copilot_profile_active_here"));
		expect(getByTestId("copilot-profile-assign-default-btn").textContent).toContain("copilot_profile_use_by_default");
		expect((getByTestId("copilot-profile-assign-here-btn") as HTMLButtonElement).disabled).toBe(true);
		// Selecting the kind default: the labels flip.
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_default"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-default-btn").textContent).toContain("copilot_profile_default"));
		expect(getByTestId("copilot-profile-assign-here-btn").textContent).toContain("copilot_profile_use_here");
		expect((getByTestId("copilot-profile-assign-default-btn") as HTMLButtonElement).disabled).toBe(true);
	});

	it("Use here writes the chat row (user id)", async () => {
		const { getByTestId, props } = renderChatModal(null, null);
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_here"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-here-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-here-btn"));
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND, { profileId: "cprof_here" }));
		// The script write is never touched by the chat variant.
		expect(setCopilotProfile).not.toHaveBeenCalled();
		expect(props.onClose).toHaveBeenCalled();
	});

	it("Use here on the built-in seed pins the built-in sentinel", async () => {
		// SC-0k (was: the built-in write cleared the chat row with null, so a
		// chat could never run the built-in under a custom default — basis:
		// owner decision 3, refined 2026-10-19).
		const { getByTestId } = renderChatModal("cprof_here", null);
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-here-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-here-btn"));
		await waitFor(() => expect(patchAgentChatSettings).toHaveBeenCalledWith(CHAT_ID, CHAT_KIND, { profileId: "builtin" }));
		expect(setCopilotProfile).not.toHaveBeenCalled();
	});

	it("Use by default writes the kind default (user id; built-in clears)", async () => {
		const { getByTestId } = renderChatModal(null, null);
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_default"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-default-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-default-btn"));
		await waitFor(() => expect(patchAgentKindSettingsAction).toHaveBeenCalledWith(CHAT_KIND, { defaultProfileId: "cprof_default" }));
		expect(setCopilotProfile).not.toHaveBeenCalled();
		expect(patchAgentChatSettings).not.toHaveBeenCalled();
	});

	it("Use by default on the built-in seed clears the kind default", async () => {
		const { getByTestId } = renderChatModal(null, "cprof_default");
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-default-btn")).toBeDefined());
		fireEvent.click(getByTestId("copilot-profile-assign-default-btn"));
		await waitFor(() => expect(patchAgentKindSettingsAction).toHaveBeenCalledWith(CHAT_KIND, { defaultProfileId: null }));
		expect(setCopilotProfile).not.toHaveBeenCalled();
	});

	it("the chat pins the built-in while the default is custom", async () => {
		// SC-0k: the pinned built-in is the effective (running) profile even
		// when the kind default is a custom profile — the resolver twin.
		const { getByTestId } = renderChatModal("builtin", "cprof_default");
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-builtin"));
		// The state label proves the chat-row read ("builtin") applied.
		await waitFor(() => expect(getByTestId("copilot-profile-assign-here-btn").textContent).toContain("copilot_profile_active_here"));
		expect((getByTestId("copilot-profile-assign-here-btn") as HTMLButtonElement).disabled).toBe(true);
		expect(getByTestId("copilot-profile-row-builtin").textContent).toContain("★");
		expect(getByTestId("copilot-profile-row-cprof_default").textContent).not.toContain("★");
		expect(getByTestId("copilot-profile-row-cprof_default").textContent).toContain("copilot_profile_default");
	});

	it("the effective-by-default profile still offers Use here (state only for the pinned choice)", async () => {
		// SC-0k: with no own choice the kind default is the effective profile
		// (it carries the active mark), but Use here still offers to pin it —
		// pinning keeps this chat on it when the default later changes.
		const { getByTestId } = renderChatModal(null, "cprof_default");
		await flush(getByTestId);
		expect(getByTestId("copilot-profile-row-cprof_default").textContent).toContain("★");
		expect(getByTestId("copilot-profile-row-cprof_here").textContent).not.toContain("★");
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_default"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-default-btn").textContent).toContain("copilot_profile_default"));
		expect(getByTestId("copilot-profile-assign-here-btn").textContent).toContain("copilot_profile_use_here");
		expect((getByTestId("copilot-profile-assign-here-btn") as HTMLButtonElement).disabled).toBe(false);
		expect((getByTestId("copilot-profile-assign-default-btn") as HTMLButtonElement).disabled).toBe(true);
	});

	it("the footer orders the secondary default action first; only Use here is primary", async () => {
		// SC-0k: secondary first, primary last (the edit footer's Cancel →
		// Save order). The here-button keeps the Save button's accent fill;
		// the default-button is the Cancel-shaped secondary (no fill).
		const { getByTestId } = renderChatModal(null, null);
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_here"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-here-btn")).toBeDefined());
		const buttons = Array.from(getByTestId("md-footer").querySelectorAll("button"));
		expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
			"copilot-profile-assign-default-btn",
			"copilot-profile-assign-here-btn",
		]);
		expect(getByTestId("copilot-profile-assign-here-btn").className).toContain("bg-accent");
		const defaultBtn = getByTestId("copilot-profile-assign-default-btn");
		expect(defaultBtn.className).toContain("bg-transparent");
		expect(defaultBtn.className).toContain("border-border");
		expect(defaultBtn.className).not.toContain("bg-accent");
		expect(defaultBtn.className).not.toContain("bg-success");
	});

	it("the default button's state is the check + default label, disabled, still secondary", async () => {
		// SC-0k: the selected kind default swaps the secondary button to its
		// state (check + label) without ever taking the primary fill.
		const { getByTestId } = renderChatModal(null, "cprof_default");
		await flush(getByTestId);
		fireEvent.pointerDown(getByTestId("copilot-profile-row-cprof_default"));
		await waitFor(() => expect(getByTestId("copilot-profile-assign-default-btn").textContent).toContain("copilot_profile_default"));
		const defaultBtn = getByTestId("copilot-profile-assign-default-btn");
		expect((defaultBtn as HTMLButtonElement).disabled).toBe(true);
		expect(defaultBtn.className).toContain("bg-transparent");
		expect(defaultBtn.className).not.toContain("bg-success");
		expect(defaultBtn.className).not.toContain("bg-accent");
	});
});
