/**
 * AP-27 — assistant settings summary (mockup §4) tests.
 *
 * Pins:
 *   - four rows render (profile / model / auto-compact / skills) with
 *     titles, one-line muted subtitles and their controls;
 *   - the subtitle carries the host's kindLabel (AP-17);
 *   - the profile dropdown resolves the effective profile (built-in seed
 *     when nothing is assigned) and choosing another writes exactly what
 *     the profile modal's primary action writes;
 *   - «Edit profiles ›» opens the profile modal as a child with parentBack
 *     «Assistant settings»; back returns to the summary (not closed);
 *   - the skills row shows the builtin/user counts (or the empty line) and
 *     «Open library ›» opens the skill modal with the same parentBack;
 *   - the model row renders AgentModelPills with the composer's binding;
 *   - the auto-compact toggle reflects the kind default and writes through
 *     the kind-settings seam.
 *
 * Children + model pills ride stubs (the shell-test pattern — capture real
 * first, spread); the profile dropdown rides a native-select fake (Radix
 * Popover.Content never mounts under happy-dom).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotProfileStore } from "../../../stores/copilot-profile-store.js";
import { useCopilotSkillStore } from "../../../stores/copilot-skill-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";

// ── SAFE module mocks (capture real first, spread `...real`) ───────────────
const realI18nContext = await import("../../../i18n/context.js");
const realProfileApi = await import("../../../api/copilot-profile-api.js");
const realDropdownSelect = await import("../DropdownSelect.js");
const realModelPills = await import("./AgentModelPills.js");
const realProfileModal = await import("./AgentProfileModal.js");
const realSkillModal = await import("./AgentSkillModal.js");

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		// Identity with the single `{n}` count echoed (the new per-part
		// plural keys pass `{ n, count }`; the old combined key is gone).
		t: (key: string, opts?: Record<string, unknown>) =>
			opts !== undefined ? `${key}:${String(opts.n)}` : key,
		tDynamic: (key: string) => key,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

const BUILTIN: CopilotProfile = {
	id: "builtin",
	name: "Experience Authoring",
	isBuiltIn: true,
	basePrompt: "You author interactive experiences.",
	toolSet: { write_buffer: true },
	agentKind: "experience",
};

const USER: CopilotProfile = {
	id: "cprof_1",
	name: "Card games",
	isBuiltIn: false,
	basePrompt: "You help author card-game experiences.",
	toolSet: { write_buffer: true },
	agentKind: "experience",
};

const listCopilotProfiles = mock(() => Promise.resolve([BUILTIN, USER]));
const setCopilotProfile = mock(async (_scriptId: string, _profileId: string | null) => undefined);
mock.module("../../../api/copilot-profile-api.js", () => ({
	...realProfileApi,
	listCopilotProfiles,
	createCopilotProfile: mock(),
	updateCopilotProfile: mock(),
	deleteCopilotProfile: mock(),
	setCopilotProfile,
}));

const realBootstrapActions = await import("../../../stores/api-actions/bootstrap-actions.js");
const patchAgentKindSettingsAction = mock(async (_kind: string, _patch: { autoCompactDefault?: boolean }) => ({
	agentKind: _kind,
	providerProfileId: null,
	modelName: null,
	defaultProfileId: null,
	updatedAt: "",
	servesChatModes: [],
	autoCompactDefault: _patch.autoCompactDefault ?? true,
}));
mock.module("../../../stores/api-actions/bootstrap-actions.js", () => ({
	...realBootstrapActions,
	patchAgentKindSettingsAction,
}));

const SKILL_ENTRIES = [
	{ id: "experience-authoring", source: "builtin" as const, name: "Experience Authoring", description: "Craft guidance.", manifestPath: "experience-authoring/SKILL.md", shadowsBuiltin: false },
	{ id: "grill-me", source: "builtin" as const, name: "grill-me", description: "Design interview.", manifestPath: "grill-me/SKILL.md", shadowsBuiltin: false },
	{ id: "my-style", source: "user" as const, name: "My style", description: "Naming and comments.", manifestPath: "my-style/SKILL.md", shadowsBuiltin: false },
];
const listCopilotSkills = mock(() => Promise.resolve({ entries: SKILL_ENTRIES, errors: [] }));
const realSkillApi = await import("../../../api/copilot-skill-api.js");
mock.module("../../../api/copilot-skill-api.js", () => ({
	...realSkillApi,
	listCopilotSkills,
	readCopilotSkill: mock(),
	importCopilotSkills: mock(),
	deleteCopilotSkill: mock(),
}));

let mobileOverride = false;
const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
	...realUseMobile,
	useIsMobile: () => mobileOverride,
}));

// The profile dropdown's Radix popup never mounts under happy-dom — a native
// select pins the same boundary (displayed effective id → onChange id).
mock.module("../DropdownSelect.js", () => ({
	...realDropdownSelect,
	DropdownSelect: ({ value, options, onChange, triggerTestId, disabled }: {
		value: string;
		options: Array<{ id: string; label: ReactNode }>;
		onChange: (value: string) => void;
		triggerTestId?: string;
		disabled?: boolean;
	}) => (
		<select
			data-testid={triggerTestId}
			value={value}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
		>
			{options.map((o) => (
				<option key={o.id} value={o.id}>{String(o.label)}</option>
			))}
		</select>
	),
}));

// The model pills render provider/model pickers (fetch-backed) — the summary
// only passes the composer's binding through, so a stub exposing the
// received props + a change arm pins exactly that boundary.
mock.module("./AgentModelPills.js", () => ({
	...realModelPills,
	AgentModelPills: ({ providerProfileId, model, onProviderChange, mobile }: {
		providerProfileId: string | null;
		model?: string;
		onProviderChange: (profileId: string, model?: string) => void;
		mobile?: boolean;
	}) => (
		<div data-testid="settings-model-pills" data-provider={providerProfileId ?? ""} data-model={model ?? ""} data-mobile={mobile === true ? "true" : "false"}>
			<button type="button" data-testid="settings-model-change" onClick={() => onProviderChange("p2", "m2")}>
				change
			</button>
		</div>
	),
}));

// Children render over the summary — stubs exposing parentBack + a back arm
// pin the drill-down flow (open → parentBack label → back returns).
mock.module("./AgentProfileModal.js", () => ({
	...realProfileModal,
	AgentProfileModal: ({ isOpen, parentBack }: {
		isOpen: boolean;
		parentBack?: { label: string; onBack: () => void };
	}) => (
		isOpen ? (
			<div data-testid="settings-child-profile">
				<span data-testid="settings-child-profile-back">{parentBack?.label}</span>
				<button type="button" data-testid="settings-child-profile-back-btn" onClick={parentBack?.onBack}>
					back
				</button>
			</div>
		) : null
	),
}));

mock.module("./AgentSkillModal.js", () => ({
	...realSkillModal,
	AgentSkillModal: ({ isOpen, parentBack }: {
		isOpen: boolean;
		parentBack?: { label: string; onBack: () => void };
	}) => (
		isOpen ? (
			<div data-testid="settings-child-skill">
				<span data-testid="settings-child-skill-back">{parentBack?.label}</span>
				<button type="button" data-testid="settings-child-skill-back-btn" onClick={parentBack?.onBack}>
					back
				</button>
			</div>
		) : null
	),
}));

let AgentSettingsModal: typeof import("./AgentSettingsModal.js").AgentSettingsModal;
beforeAll(async () => {
	// The summary reads the host descriptor (kindLabel subtitle,
	// profileAssignment variant) — registering the real host, like the
	// profile modal suite does (never unregistered; the worker isolates the
	// module registry per file).
	await import("../../build/editors/copilot/experience-agent-host.js");
	({ AgentSettingsModal } = await import("./AgentSettingsModal.js"));
});

function seedBootstrap(autoCompactDefault: boolean): void {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: [],
			promptPresets: [],
			uiSettings: wireUiSettings(),
			agentKindSettings: {
				experience: {
					agentKind: "experience",
					providerProfileId: null,
					modelName: null,
					defaultProfileId: null,
					updatedAt: "",
					servesChatModes: [],
					autoCompactDefault,
				},
			},
			isArmServer: false,
		},
		personas: null,
		isLoading: false,
	});
}

beforeEach(() => {
	mobileOverride = false;
	listCopilotProfiles.mockReset();
	listCopilotProfiles.mockResolvedValue([BUILTIN, USER]);
	setCopilotProfile.mockReset();
	setCopilotProfile.mockResolvedValue(undefined);
	patchAgentKindSettingsAction.mockReset();
	patchAgentKindSettingsAction.mockImplementation(async (_kind: string, _patch: { autoCompactDefault?: boolean }) => ({
		agentKind: _kind,
		providerProfileId: null,
		modelName: null,
		defaultProfileId: null,
		updatedAt: "",
		servesChatModes: [],
		autoCompactDefault: _patch.autoCompactDefault ?? true,
	}));
	listCopilotSkills.mockReset();
	listCopilotSkills.mockResolvedValue({ entries: SKILL_ENTRIES, errors: [] });
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ catalogs: {}, isLoading: false });
	seedBootstrap(true);
});

afterEach(() => {
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ catalogs: {}, isLoading: false });
	useBootstrapStore.setState({ data: null, personas: null, isLoading: false });
});

function renderSummary(over: Partial<React.ComponentProps<typeof AgentSettingsModal>> = {}) {
	const onProviderChange = mock((_profileId: string, _model?: string) => undefined);
	const utils = render(
		<AgentSettingsModal
			agentKind="experience"
			scriptId="script-1"
			assignedProfileId={null}
			providerProfileId="p1"
			model="m1"
			onProviderChange={onProviderChange}
			isOpen
			onClose={mock()}
			{...over}
		/>,
	);
	return { ...utils, onProviderChange };
}

async function flushProfiles(getByTestId: (id: string) => HTMLElement) {
	// Profiles arrive via the store load — the dropdown gains its options.
	await waitFor(() => expect(getByTestId("agent-settings-profile-select").textContent).toContain("Card games"));
}

describe("AgentSettingsModal — rows", () => {
	it("renders four rows with titles, one-line subtitles and controls", async () => {
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);

		expect(getByTestId("agent-settings-title").textContent).toBe("agent_settings_title");
		// AP-17: the subtitle is the host's kindLabel.
		expect(getByTestId("agent-settings-subtitle").textContent).toBe("agent_kind_experience");

		const profile = getByTestId("agent-settings-row-profile");
		expect(profile.textContent).toContain("agent_settings_profile");
		expect(profile.textContent).toContain("agent_settings_profile_sub");
		expect(profile.textContent).toContain("agent_settings_edit_profiles");
		expect(getByTestId("agent-settings-profile-select")).toBeDefined();

		const modelRow = getByTestId("agent-settings-row-model");
		expect(modelRow.textContent).toContain("agent_settings_model");
		expect(modelRow.textContent).toContain("agent_settings_model_sub");
		expect(getByTestId("settings-model-pills")).toBeDefined();

		const compact = getByTestId("agent-settings-row-autocompact");
		expect(compact.textContent).toContain("agent_settings_autocompact");
		expect(compact.textContent).toContain("agent_settings_autocompact_sub");

		const skills = getByTestId("agent-settings-row-skills");
		expect(skills.textContent).toContain("agent_settings_skills");
		expect(getByTestId("agent-settings-open-library-btn")).toBeDefined();
	});

	it("resolves the built-in seed in the dropdown when nothing is assigned", async () => {
		const { getByTestId } = renderSummary({ assignedProfileId: null });
		await flushProfiles(getByTestId);
		expect((getByTestId("agent-settings-profile-select") as HTMLSelectElement).value).toBe("builtin");
	});

	it("marks the assigned user profile in the dropdown", async () => {
		const { getByTestId } = renderSummary({ assignedProfileId: "cprof_1" });
		await flushProfiles(getByTestId);
		expect((getByTestId("agent-settings-profile-select") as HTMLSelectElement).value).toBe("cprof_1");
	});
});

describe("AgentSettingsModal — profile row writes", () => {
	it("choosing a user profile writes what the profile modal's assign writes", async () => {
		const { getByTestId } = renderSummary({ assignedProfileId: null });
		await flushProfiles(getByTestId);

		fireEvent.change(getByTestId("agent-settings-profile-select"), { target: { value: "cprof_1" } });
		// Same seam + args as the profile modal's «Use profile» for a
		// script host (setCopilotProfile unassigns the built-in via null).
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", "cprof_1"));
	});

	it("choosing the built-in seed unassigns via null", async () => {
		const { getByTestId } = renderSummary({ assignedProfileId: "cprof_1" });
		await flushProfiles(getByTestId);

		fireEvent.change(getByTestId("agent-settings-profile-select"), { target: { value: "builtin" } });
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledWith("script-1", null));
	});
});

describe("AgentSettingsModal — failed profile write", () => {
	it("shows the effective profile again, and choosing the same profile retries the write", async () => {
		setCopilotProfile.mockRejectedValueOnce(new Error("write failed"));
		const { getByTestId } = renderSummary({ assignedProfileId: null });
		await flushProfiles(getByTestId);
		const select = () => getByTestId("agent-settings-profile-select") as HTMLSelectElement;
		expect(select().value).toBe("builtin");

		fireEvent.change(select(), { target: { value: "cprof_1" } });
		// The write fails — the hook toasts and never calls `onAssigned` —
		// so the park clears and the trigger falls back to the effective
		// profile (nothing was applied).
		await waitFor(() => expect(select().value).toBe("builtin"));
		expect(setCopilotProfile).toHaveBeenCalledTimes(1);

		// The pin is cleared too: choosing the same profile retries.
		fireEvent.change(select(), { target: { value: "cprof_1" } });
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledTimes(2));
	});

	it("retries the same choice after the modal closes and reopens", async () => {
		setCopilotProfile.mockRejectedValue(new Error("write failed"));
		const onProviderChange = mock((_profileId: string, _model?: string) => undefined);
		const base = {
			agentKind: "experience" as const,
			scriptId: "script-1",
			assignedProfileId: null,
			providerProfileId: "p1",
			model: "m1",
			onProviderChange,
			onClose: mock(),
		};
		const utils = render(<AgentSettingsModal {...base} isOpen />);
		await flushProfiles(utils.getByTestId);

		fireEvent.change(utils.getByTestId("agent-settings-profile-select"), { target: { value: "cprof_1" } });
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledTimes(1));

		// Close (the park + the pin reset) and reopen — the choice is
		// parked fresh, so the write fires again.
		utils.rerender(<AgentSettingsModal {...base} isOpen={false} />);
		utils.rerender(<AgentSettingsModal {...base} isOpen />);
		await flushProfiles(utils.getByTestId);
		fireEvent.change(utils.getByTestId("agent-settings-profile-select"), { target: { value: "cprof_1" } });
		await waitFor(() => expect(setCopilotProfile).toHaveBeenCalledTimes(2));
	});
});

describe("AgentSettingsModal — children", () => {
	it("«Edit profiles ›» opens the profile modal with parentBack; back returns to the summary", async () => {
		const { getByTestId, queryByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		expect(queryByTestId("settings-child-profile")).toBeNull();

		fireEvent.click(getByTestId("agent-settings-edit-profiles-btn"));
		expect(getByTestId("settings-child-profile")).toBeDefined();
		expect(getByTestId("settings-child-profile-back").textContent).toBe("agent_settings_title");

		fireEvent.click(getByTestId("settings-child-profile-back-btn"));
		expect(queryByTestId("settings-child-profile")).toBeNull();
		// Back returns to the summary — the rows are still mounted.
		expect(getByTestId("agent-settings-row-profile")).toBeDefined();
		expect(getByTestId("agent-settings-row-skills")).toBeDefined();
	});

	it("«Open library ›» opens the skill modal with parentBack; back returns to the summary", async () => {
		const { getByTestId, queryByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		expect(queryByTestId("settings-child-skill")).toBeNull();

		fireEvent.click(getByTestId("agent-settings-open-library-btn"));
		expect(getByTestId("settings-child-skill")).toBeDefined();
		expect(getByTestId("settings-child-skill-back").textContent).toBe("agent_settings_title");

		fireEvent.click(getByTestId("settings-child-skill-back-btn"));
		expect(queryByTestId("settings-child-skill")).toBeNull();
		expect(getByTestId("agent-settings-row-skills")).toBeDefined();
	});
});

describe("AgentSettingsModal — skills row", () => {
	it("shows one part per non-zero source through its own plural key", async () => {
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		await waitFor(() =>
			expect(getByTestId("agent-settings-row-skills").textContent).toContain(
				"agent_settings_skills_builtin:2 · agent_settings_skills_custom:1",
			),
		);
	});

	it("hides the built-in part when the kind ships no built-in skills", async () => {
		// Sidechat + scripts ship 0 built-in skills — «0 встроенных» noise.
		listCopilotSkills.mockResolvedValue({
			entries: SKILL_ENTRIES.filter((e) => e.source === "user").concat([
				{ id: "second", source: "user" as const, name: "Second", description: "d", manifestPath: "second/SKILL.md", shadowsBuiltin: false },
				{ id: "third", source: "user" as const, name: "Third", description: "d", manifestPath: "third/SKILL.md", shadowsBuiltin: false },
			]),
			errors: [],
		});
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		await waitFor(() =>
			expect(getByTestId("agent-settings-row-skills").textContent).toContain("agent_settings_skills_custom:3"),
		);
		expect(getByTestId("agent-settings-row-skills").textContent).not.toContain("agent_settings_skills_builtin");
	});

	it("hides the custom part when the kind has no user skills", async () => {
		listCopilotSkills.mockResolvedValue({
			entries: SKILL_ENTRIES.filter((e) => e.source === "builtin"),
			errors: [],
		});
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		await waitFor(() =>
			expect(getByTestId("agent-settings-row-skills").textContent).toContain("agent_settings_skills_builtin:2"),
		);
		expect(getByTestId("agent-settings-row-skills").textContent).not.toContain("agent_settings_skills_custom");
	});

	it("shows the empty line when the kind has no skills", async () => {
		listCopilotSkills.mockResolvedValue({ entries: [], errors: [] });
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		await waitFor(() =>
			expect(getByTestId("agent-settings-row-skills").textContent).toContain("agent_settings_no_skills"),
		);
	});
});

describe("AgentSettingsModal — model row", () => {
	it("passes the composer's binding through to the model pills", async () => {
		const { getByTestId, onProviderChange } = renderSummary();
		await flushProfiles(getByTestId);

		const pills = getByTestId("settings-model-pills");
		expect(pills.getAttribute("data-provider")).toBe("p1");
		expect(pills.getAttribute("data-model")).toBe("m1");
		expect(pills.getAttribute("data-mobile")).toBe("false");

		fireEvent.click(getByTestId("settings-model-change"));
		expect(onProviderChange).toHaveBeenCalledWith("p2", "m2");
	});

	it("passes the phone variant to the model pills on mobile (AP-26b)", async () => {
		// AP-26b: the phone summary is full-screen — the model row renders
		// the pills' mobile (bottom-sheet) variant there.
		mobileOverride = true;
		const { getByTestId } = renderSummary();
		await flushProfiles(getByTestId);
		expect(getByTestId("settings-model-pills").getAttribute("data-mobile")).toBe("true");
	});
});

describe("AgentSettingsModal — auto-compact row", () => {
	it("reflects the kind default and writes through the kind-settings seam", async () => {
		const { getByRole } = renderSummary();
		const toggle = getByRole("switch", { name: "agent_settings_autocompact" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");

		fireEvent.click(toggle);
		await waitFor(() =>
			expect(patchAgentKindSettingsAction).toHaveBeenCalledWith("experience", { autoCompactDefault: false }),
		);
	});

	it("reads off when the kind default is off", async () => {
		seedBootstrap(false);
		const { getByRole } = renderSummary();
		expect(getByRole("switch", { name: "agent_settings_autocompact" }).getAttribute("aria-checked")).toBe("false");
	});
});
