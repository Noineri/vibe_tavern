/**
 * Wave 3 / CP-10, per-kind libraries AS-8d2 — agent skill library manager
 * (MasterDetail) tests.
 *
 * Mirrors `CoauthorSkillModal.test.tsx` against the copilot skill roots:
 *   - lists the kind's merged catalog on open (built-in + user entries);
 *   - a pure built-in skill has no delete affordance (read-only);
 *   - a user skill exposes delete → confirm → `deleteCopilotSkill(kind, id)`;
 *   - every RPC carries the modal's kind; one kind never shows the other
 *     kind's cached entries.
 *
 * The modal is CONTROLLED (open + kind are props), so it is rendered with
 * `isOpen=true` directly (no global modal store).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotSkillStore } from "../../../stores/copilot-skill-store.js";
import type { SkillCatalog, SkillCatalogEntryDto } from "@vibe-tavern/api-contracts";

const realSkillApi = await import("../../../api/copilot-skill-api.js");
const realMasterDetailModal = await import("../MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../destructive-confirm-modal.js");

installI18nContextSeam();

const listSkillsMock = mock();
const deleteSkillMock = mock();
const importSkillsMock = mock();
const readContentMock = mock();
const createSkillMock = mock();
const updateSkillMock = mock();
mock.module("../../../api/copilot-skill-api.js", () => ({
	...realSkillApi,
	listCopilotSkills: listSkillsMock,
	readCopilotSkill: mock(),
	deleteCopilotSkill: deleteSkillMock,
	importCopilotSkills: importSkillsMock,
	readCopilotSkillContent: readContentMock,
	createCopilotSkill: createSkillMock,
	updateCopilotSkill: updateSkillMock,
}));

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

let AgentSkillModal: typeof import("./AgentSkillModal.js").AgentSkillModal;
beforeAll(async () => {
	({ AgentSkillModal } = await import("./AgentSkillModal.js"));
});

const CATALOG: SkillCatalog = {
	entries: [
		{ id: "experience-authoring", source: "builtin", name: "Experience Authoring", description: "Built-in craft skill.", manifestPath: "experience-authoring/SKILL.md", shadowsBuiltin: false },
		{ id: "my-card-skill", source: "user", name: "My Card Skill", description: "User-imported skill.", manifestPath: "my-card-skill/SKILL.md", shadowsBuiltin: false },
	],
	errors: [],
};

const SCRIPT_USER_ENTRY: SkillCatalogEntryDto = {
	id: "script-skill",
	source: "user",
	name: "Script Skill",
	description: "Script-only skill.",
	manifestPath: "script-skill/SKILL.md",
	shadowsBuiltin: false,
};

const CACHED_EXPERIENCE_ENTRY: SkillCatalogEntryDto = {
	id: "cached-experience-skill",
	source: "builtin",
	name: "Cached Experience Skill",
	description: "Seeded experience cache.",
	manifestPath: "cached-experience-skill/SKILL.md",
	shadowsBuiltin: false,
};

const CACHED_SCRIPT_ENTRY: SkillCatalogEntryDto = {
	id: "cached-script-skill",
	source: "builtin",
	name: "Cached Script Skill",
	description: "Seeded script cache.",
	manifestPath: "cached-script-skill/SKILL.md",
	shadowsBuiltin: false,
};

beforeEach(() => {
	listSkillsMock.mockReset();
	listSkillsMock.mockResolvedValue(CATALOG);
	deleteSkillMock.mockReset();
	deleteSkillMock.mockResolvedValue({ id: "my-card-skill" });
	importSkillsMock.mockReset();
	importSkillsMock.mockResolvedValue({ importedSkillIds: ["my-card-skill"], importedTopLevelDirs: ["my-card-skill"] });
	readContentMock.mockReset();
	readContentMock.mockResolvedValue({
		id: "my-card-skill",
		path: "my-card-skill/SKILL.md",
		content: "# My Card Skill\n\nUser-imported skill.",
		body: "User-imported skill.",
		files: [],
	});
	createSkillMock.mockReset();
	createSkillMock.mockResolvedValue({
		id: "fresh-skill",
		source: "user",
		name: "Script New",
		description: "Fresh.",
		manifestPath: "fresh-skill/SKILL.md",
		shadowsBuiltin: false,
	});
	updateSkillMock.mockReset();
	updateSkillMock.mockResolvedValue({
		id: "my-card-skill",
		source: "user",
		name: "My Card Skill",
		description: "User-imported skill.",
		manifestPath: "my-card-skill/SKILL.md",
		shadowsBuiltin: false,
	});
	useCopilotSkillStore.setState({ catalogs: {}, isLoading: false });
});

function renderModal(agentKind = "experience") {
	return render(<AgentSkillModal isOpen onClose={mock()} agentKind={agentKind} />);
}

describe("CopilotSkillModal — catalog list + read-only built-ins", () => {
	it("lists every catalog entry (built-in + user) on open", async () => {
		const { getByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		expect(getByText("Experience Authoring")).toBeDefined();
		expect(listSkillsMock).toHaveBeenCalledWith("experience");
	});

	it("rows show the description, not the id (AP-23)", async () => {
		const { getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		expect(getByText("User-imported skill.")).toBeDefined();
		expect(queryByText("my-card-skill")).toBeNull();
	});

	it("a pure built-in skill has no delete affordance (footer owns delete)", async () => {
		const { getByTestId, getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("Experience Authoring")).toBeDefined());
		fireEvent.pointerDown(getByTestId("copilot-skill-row-experience-authoring"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("experience", "experience-authoring"));
		expect(queryByText("copilot_skill_delete")).toBeNull();
	});
});

describe("CopilotSkillModal — delete user skill", () => {
	it("selecting a user skill exposes the footer delete, then confirms", async () => {
		const { getByTestId, getByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		fireEvent.pointerDown(getByTestId("copilot-skill-row-my-card-skill"));
		await waitFor(() => expect(getByText("copilot_skill_delete")).toBeDefined());
		fireEvent.click(getByText("copilot_skill_delete"));
		await waitFor(() => expect(getByTestId("confirm-modal")).toBeDefined());
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith("experience", "my-card-skill"));
	});
});

describe("CopilotSkillModal — skill content (AP-23)", () => {
	it("selecting a skill lazily reads its content for the modal kind", async () => {
		const { getByTestId, getByText } = renderModal("script");
		await waitFor(() => expect(listSkillsMock).toHaveBeenCalledWith("script"));
		expect(readContentMock).not.toHaveBeenCalled();
		fireEvent.pointerDown(getByTestId("copilot-skill-row-my-card-skill"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("script", "my-card-skill"));
		expect(getByText("copilot_skill_body_label")).toBeDefined();
		expect(getByTestId("copilot-skill-content-body").textContent).toBe("User-imported skill.");
	});
});

describe("CopilotSkillModal — per-kind library (AS-8d2)", () => {
	it("the script kind requests its own catalog", async () => {
		renderModal("script");
		await waitFor(() => expect(listSkillsMock).toHaveBeenCalledWith("script"));
	});

	it("import passes the kind", async () => {
		const { getByTestId } = renderModal("script");
		await waitFor(() => expect(listSkillsMock).toHaveBeenCalledWith("script"));
		const file = new File(["# Script skill"], "SKILL.md");
		fireEvent.change(getByTestId("copilot-skill-folder-input"), { target: { files: [file] } });
		await waitFor(() => expect(importSkillsMock).toHaveBeenCalledWith("script", [file]));
	});

	it("delete passes the kind", async () => {
		// Seed AND serve the script entry: the open effect's `load` would
		// otherwise replace the seeded cache with the default catalog and
		// drop the selection before the footer renders.
		listSkillsMock.mockResolvedValue({ entries: [SCRIPT_USER_ENTRY], errors: [] });
		useCopilotSkillStore.setState({
			catalogs: { script: { entries: [SCRIPT_USER_ENTRY], errors: [], hasLoaded: true } },
			isLoading: false,
		});
		const { getByTestId, getByText } = renderModal("script");
		fireEvent.pointerDown(getByTestId("copilot-skill-row-script-skill"));
		await waitFor(() => expect(getByText("copilot_skill_delete")).toBeDefined());
		fireEvent.click(getByText("copilot_skill_delete"));
		await waitFor(() => expect(getByTestId("confirm-modal")).toBeDefined());
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith("script", "script-skill"));
	});

	it("opening the modal for one kind never shows the other kind's cached entries", async () => {
		useCopilotSkillStore.setState({
			catalogs: {
				experience: { entries: [CACHED_EXPERIENCE_ENTRY], errors: [], hasLoaded: true },
				script: { entries: [CACHED_SCRIPT_ENTRY], errors: [], hasLoaded: true },
			},
			isLoading: false,
		});
		// Sync read pins the seeded cache: the open effect's `load` has not
		// resolved yet, so whatever renders now comes from the script cache.
		const { queryByText } = renderModal("script");
		expect(queryByText("Cached Script Skill")).toBeDefined();
		expect(queryByText("Cached Experience Skill")).toBeNull();
		await waitFor(() => expect(listSkillsMock).toHaveBeenCalledWith("script"));
	});
});

describe("CopilotSkillModal — editor save seam (AP-23d)", () => {
	it("creates a new skill through createCopilotSkill with the modal kind", async () => {
		const { getByTestId, getByText } = renderModal("script");
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		fireEvent.click(getByTestId("copilot-skill-new-btn"));
		fireEvent.change(getByTestId("copilot-skill-editor-name"), { target: { value: "Script New" } });
		fireEvent.change(getByTestId("copilot-skill-editor-when"), { target: { value: "Fresh." } });
		fireEvent.change(getByTestId("copilot-skill-editor-body"), { target: { value: "Fresh body." } });
		fireEvent.click(getByText("copilot_skill_save"));
		// The client seam carries the kind (was: no create path existed).
		await waitFor(() => expect(createSkillMock).toHaveBeenCalledWith("script", { name: "Script New", description: "Fresh.", body: "Fresh body." }));
	});

	it("updates an edited skill through updateCopilotSkill with the modal kind", async () => {
		const { getByTestId, getByText } = renderModal("experience");
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		fireEvent.pointerDown(getByTestId("copilot-skill-row-my-card-skill"));
		await waitFor(() => expect(getByText("copilot_skill_edit")).toBeDefined());
		fireEvent.click(getByText("copilot_skill_edit"));
		fireEvent.change(getByTestId("copilot-skill-editor-body"), { target: { value: "Edited body." } });
		fireEvent.click(getByText("copilot_skill_save"));
		await waitFor(() => expect(updateSkillMock).toHaveBeenCalledWith("experience", "my-card-skill", { name: "My Card Skill", description: "User-imported skill.", body: "Edited body." }));
		expect(createSkillMock).not.toHaveBeenCalled();
	});
});
