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
 *   - assigning a user profile calls setCopilotProfile(scriptId, id); assigning
 *     the built-in seed calls setCopilotProfile(scriptId, null) (unassign);
 *   - deleting a user profile asks for confirmation then calls remove.
 *
 * Input typing is not simulated here (same happy-dom limitation noted in the
 * co-author suite) — buttons → handler → RPC wiring + mode transitions are what
 * is pinned.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotProfileStore } from "../../../../stores/copilot-profile-store.js";
import { useCopilotSkillStore } from "../../../../stores/copilot-skill-store.js";
import type { CopilotProfile, CopilotProfileCreate, CopilotProfileUpdate } from "@vibe-tavern/api-contracts";

// ── SAFE module mocks (capture real first, spread `...real`) ───────────────
const realI18nContext = await import("../../../../i18n/context.js");
const realProfileApi = await import("../../../../api/copilot-profile-api.js");
const realSkillApi = await import("../../../../api/copilot-skill-api.js");
const realMasterDetailModal = await import("../../../shared/MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../../../shared/destructive-confirm-modal.js");

mock.module("../../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const BUILTIN: CopilotProfile = {
	id: "builtin",
	name: "Experience Authoring",
	isBuiltIn: true,
	basePrompt: "You author interactive experiences.",
	skillIds: ["experience-authoring"],
	toolSet: { write_buffer: true, edit_buffer: true, run_test: true },
	maxSteps: 20,
};

const USER: CopilotProfile = {
	id: "cprof_1",
	name: "Card games",
	isBuiltIn: false,
	basePrompt: "You help author card-game experiences.",
	skillIds: ["experience-authoring"],
	toolSet: { write_buffer: true, run_test: true },
	maxSteps: 20,
};

const ALL_PROFILES = [BUILTIN, USER];

const listCopilotProfiles = mock(() => Promise.resolve(ALL_PROFILES));
const createCopilotProfile = mock(async (_input: CopilotProfileCreate) => USER);
const updateCopilotProfile = mock(async (_id: string, _input: CopilotProfileUpdate) => USER);
const deleteCopilotProfile = mock(async (_id: string) => undefined);
const setCopilotProfile = mock(async (_scriptId: string, _profileId: string | null) => undefined);

mock.module("../../../../api/copilot-profile-api.js", () => ({
	...realProfileApi,
	listCopilotProfiles,
	createCopilotProfile,
	updateCopilotProfile,
	deleteCopilotProfile,
	setCopilotProfile,
}));

const SKILL_CATALOG = {
	entries: [
		{ id: "experience-authoring", source: "builtin" as const, name: "Experience Authoring", description: "Craft guidance.", manifestPath: "experience-authoring/SKILL.md", shadowsBuiltin: false },
	],
	errors: [],
};
const listCopilotSkills = mock(() => Promise.resolve(SKILL_CATALOG));
mock.module("../../../../api/copilot-skill-api.js", () => ({
	...realSkillApi,
	listCopilotSkills,
	readCopilotSkill: mock(),
	importCopilotSkills: mock(),
	deleteCopilotSkill: mock(),
}));

// MasterDetailModal passthrough (render master + detail + footer + headerActions flat).
mock.module("../../../shared/MasterDetailModal.js", () => ({
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

mock.module("../../../shared/destructive-confirm-modal.js", () => ({
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

let CopilotProfileModal: typeof import("./CopilotProfileModal.js").CopilotProfileModal;
beforeAll(async () => {
	({ CopilotProfileModal } = await import("./CopilotProfileModal.js"));
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
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ entries: [], errors: [], isLoading: false, hasLoaded: false });
});

afterEach(() => {
	useCopilotProfileStore.setState({ profiles: [], isLoading: false, hasLoaded: false });
	useCopilotSkillStore.setState({ entries: [], errors: [], isLoading: false, hasLoaded: false });
});

function renderModal(over: { scriptId?: string; assignedProfileId?: string | null } = {}) {
	const props = {
		scriptId: "script-1",
		assignedProfileId: null,
		isOpen: true,
		onClose: mock(),
		...over,
	};
	const utils = render(<CopilotProfileModal {...props} />);
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
