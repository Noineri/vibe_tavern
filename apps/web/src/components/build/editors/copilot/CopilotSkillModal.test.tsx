/**
 * Wave 3 / CP-10 — copilot skill library manager (MasterDetail) tests.
 *
 * Mirrors `CoauthorSkillModal.test.tsx` against the copilot skill roots:
 *   - lists the merged catalog on open (built-in + user entries);
 *   - a pure built-in skill has no delete affordance (read-only);
 *   - a user skill exposes delete → confirm → `deleteCopilotSkill`.
 *
 * The modal is CONTROLLED (open is a prop), so it is rendered with
 * `isOpen=true` directly (no global modal store).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useCopilotSkillStore } from "../../../../stores/copilot-skill-store.js";
import type { SkillCatalog } from "@vibe-tavern/api-contracts";

const realI18nContext = await import("../../../../i18n/context.js");
const realSkillApi = await import("../../../../api/copilot-skill-api.js");
const realMasterDetailModal = await import("../../../shared/MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../../../shared/destructive-confirm-modal.js");

mock.module("../../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const listSkillsMock = mock();
const deleteSkillMock = mock();
const importSkillsMock = mock();
mock.module("../../../../api/copilot-skill-api.js", () => ({
	...realSkillApi,
	listCopilotSkills: listSkillsMock,
	readCopilotSkill: mock(),
	deleteCopilotSkill: deleteSkillMock,
	importCopilotSkills: importSkillsMock,
}));

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

let CopilotSkillModal: typeof import("./CopilotSkillModal.js").CopilotSkillModal;
beforeAll(async () => {
	({ CopilotSkillModal } = await import("./CopilotSkillModal.js"));
});

const CATALOG: SkillCatalog = {
	entries: [
		{ id: "experience-authoring", source: "builtin", name: "Experience Authoring", description: "Built-in craft skill.", manifestPath: "experience-authoring/SKILL.md", shadowsBuiltin: false },
		{ id: "my-card-skill", source: "user", name: "My Card Skill", description: "User-imported skill.", manifestPath: "my-card-skill/SKILL.md", shadowsBuiltin: false },
	],
	errors: [],
};

beforeEach(() => {
	listSkillsMock.mockReset();
	listSkillsMock.mockResolvedValue(CATALOG);
	deleteSkillMock.mockReset();
	deleteSkillMock.mockResolvedValue({ id: "my-card-skill" });
	importSkillsMock.mockReset();
	importSkillsMock.mockResolvedValue({ importedSkillIds: ["my-card-skill"], importedTopLevelDirs: ["my-card-skill"] });
	useCopilotSkillStore.setState({ entries: [], errors: [], isLoading: false, hasLoaded: false });
});

function renderModal() {
	return render(<CopilotSkillModal isOpen onClose={mock()} />);
}

describe("CopilotSkillModal — catalog list + read-only built-ins", () => {
	it("lists every catalog entry (built-in + user) on open", async () => {
		const { getByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		expect(getByText("Experience Authoring")).toBeDefined();
	});

	it("a pure built-in skill has no delete affordance", async () => {
		const { getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("Experience Authoring")).toBeDefined());
		expect(queryByTestId("copilot-skill-delete-btn-experience-authoring")).toBeNull();
	});

	it("a user skill exposes a delete affordance", async () => {
		const { getByTestId, getByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		expect(getByTestId("copilot-skill-delete-btn-my-card-skill")).toBeDefined();
	});
});

describe("CopilotSkillModal — delete user skill", () => {
	it("asks for confirmation then calls deleteCopilotSkill", async () => {
		const { getByTestId, getByText } = renderModal();
		await waitFor(() => expect(getByText("My Card Skill")).toBeDefined());
		fireEvent.click(getByTestId("copilot-skill-delete-btn-my-card-skill"));
		await waitFor(() => expect(getByTestId("confirm-modal")).toBeDefined());
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith("my-card-skill"));
	});
});
