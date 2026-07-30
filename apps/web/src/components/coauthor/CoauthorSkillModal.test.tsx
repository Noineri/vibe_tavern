/**
 * CTX-S7 — Co-Author skill library manager (MasterDetail). Pins:
 *   - lists the merged catalog on open (built-in + user entries);
 *   - built-in skills are read-only (no delete affordance — pure built-in
 *     delete is rejected at the UI layer, the server rejects it too);
 *   - user skills expose a delete affordance;
 *   - REFERENCE GUARD (self-check #2): deleting a user skill that modules still
 *     bind opens a confirm that NAMES those modules, instead of silently leaving
 *     broken bindings; confirming calls deleteCoauthorSkill.
 *
 * Mirrors the CoauthorModuleModal.test.tsx mock topology: MasterDetailModal +
 * DestructiveConfirmModal are passthroughs (children rendered flat), api-actions
 * + skill-api are mocked, and `...real` spreads keep the mocks leak-safe
 * (Bun's process-global mock.module still benefits from the spread for parity).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
import type { SkillCatalog } from "@vibe-tavern/api-contracts";

const realI18nContext = await import("../../i18n/context.js");
const realSkillApi = await import("../../api/skill-api.js");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realMasterDetailModal = await import("../shared/MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../shared/destructive-confirm-modal.js");

mock.module("../../i18n/context.js", () => ({
		...realI18nContext,
		useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// ─── skill-api mock: the catalog the store loads + the delete/import fns ──
const listSkillsMock = mock();
const deleteSkillMock = mock();
const importSkillsMock = mock();
mock.module("../../api/skill-api.js", () => ({
	...realSkillApi,
	listCoauthorSkills: listSkillsMock,
	readCoauthorSkill: mock(),
	deleteCoauthorSkill: deleteSkillMock,
	importCoauthorSkills: importSkillsMock,
}));

// ─── api-actions mock: the module list the reference guard consults ──────
const listModulesMock = mock();
mock.module("../../stores/api-actions/chat-actions.js", () => ({
	...realChatActions,
	listCoauthorModulesAction: listModulesMock,
}));

// ─── MasterDetailModal passthrough (children flat) ──────────────────────

mock.module("../shared/MasterDetailModal.js", () => ({
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

// ─── DestructiveConfirmModal passthrough (renders title + buttons) ───────

mock.module("../shared/destructive-confirm-modal.js", () => ({
		...realDestructiveConfirmModal,
		DestructiveConfirmModal: ({ title, body, confirmLabel, onConfirm, onCancel }: {
			title: string; body: React.ReactNode; confirmLabel: string;
			onConfirm: () => void; onCancel: () => void;
		}) => (
			<div data-testid="confirm-modal">
				<div data-testid="confirm-title">{title}</div>
				<div data-testid="confirm-body">{body as React.ReactNode}</div>
				<button type="button" data-testid="confirm-cancel" onClick={onCancel}>cancel</button>
				<button type="button" data-testid="confirm-ok" onClick={onConfirm}>{confirmLabel}</button>
			</div>
		),
}));

let CoauthorSkillModal: typeof import("./CoauthorSkillModal.js").CoauthorSkillModal;
beforeAll(async () => {
	({ fireEvent, render, waitFor } = await import("@testing-library/react"));
	({ CoauthorSkillModal } = await import("./CoauthorSkillModal.js"));
});
const { useCoauthorSkillStore } = await import("../../stores/coauthor-skill-store.js");
const { useModalStore } = await import("../../stores/modal-store.js");

const CATALOG: SkillCatalog = {
	entries: [
		{ id: "general-writing", source: "builtin", name: "General Writing", description: "Vivid prose skill.", manifestPath: "general-writing/SKILL.md", shadowsBuiltin: false },
		{ id: "janitor-modern-botmaking", source: "user", name: "Modern Botmaking", description: "User-imported card skill.", manifestPath: "janitor-modern-botmaking/SKILL.md", shadowsBuiltin: false },
		{ id: "general-writing-shadow", source: "user", name: "General Writing (mine)", description: "Shadows the built-in.", manifestPath: "general-writing-shadow/SKILL.md", shadowsBuiltin: true },
	],
	errors: [],
};

beforeEach(() => {
	listSkillsMock.mockResolvedValue(CATALOG);
	deleteSkillMock.mockResolvedValue({ id: "x" });
	importSkillsMock.mockResolvedValue({ importedSkillIds: [], importedTopLevelDirs: [] });
	listModulesMock.mockResolvedValue([]);
	useCoauthorSkillStore.setState({ entries: [], errors: [], isLoading: false, hasLoaded: false });
	useModalStore.setState({ isCoauthorSkillModalOpen: true });
});

describe("CoauthorSkillModal — catalog list + read-only built-ins (CTX-S7)", () => {
	it("lists every catalog entry (built-in + user) on open", async () => {
		const { getByText, queryAllByTestId } = render(<CoauthorSkillModal />);
		await waitFor(() => expect(getByText("Modern Botmaking")).toBeDefined());
		expect(getByText("General Writing")).toBeDefined();
		// Only user-source rows render a delete button (built-ins are read-only).
		expect(queryAllByTestId(/skill-delete-btn-/)).toHaveLength(2);
	});

	it("a pure built-in skill has no delete affordance (delete is rejected at the UI)", async () => {
		const { getByText, queryByTestId } = render(<CoauthorSkillModal />);
		await waitFor(() => expect(getByText("General Writing")).toBeDefined());
		expect(queryByTestId("skill-delete-btn-general-writing")).toBeNull();
	});
});

describe("CoauthorSkillModal — delete reference guard (CTX-S7 self-check #2)", () => {
	it("names the modules that still bind a skill before deleting it", async () => {
		// One module references the user skill; one does not.
		listModulesMock.mockResolvedValue([
			{ id: "cmod_a", name: "My Card Module", skillIds: ["janitor-modern-botmaking", "general-writing"] },
			{ id: "cmod_b", name: "Dialogue Only", skillIds: ["dialogue-generation"] },
		]);
		const { getByText, getByTestId, queryByTestId } = render(<CoauthorSkillModal />);
		await waitFor(() => expect(getByText("Modern Botmaking")).toBeDefined());

		// Click delete on the user skill that is referenced.
		fireEvent.click(getByTestId("skill-delete-btn-janitor-modern-botmaking"));

		// The reference guard resolves modules, then opens a confirm that NAMES
		// the referencing module — not a silent plain confirm.
		await waitFor(() => expect(queryByTestId("confirm-modal")).not.toBeNull());
		expect(getByText("My Card Module")).toBeDefined();
		// The non-referencing module is NOT listed.
		expect(queryByTestId("confirm-title")?.textContent).toBe("coauthor.skill.delete_confirm_title");
	});

	it("confirming the guarded delete calls deleteCoauthorSkill for that id", async () => {
		listModulesMock.mockResolvedValue([
			{ id: "cmod_a", name: "My Card Module", skillIds: ["janitor-modern-botmaking"] },
		]);
		const { getByText, getByTestId, queryByTestId } = render(<CoauthorSkillModal />);
		await waitFor(() => expect(getByText("Modern Botmaking")).toBeDefined());
		fireEvent.click(getByTestId("skill-delete-btn-janitor-modern-botmaking"));
		await waitFor(() => expect(queryByTestId("confirm-modal")).not.toBeNull());

		fireEvent.click(getByTestId("confirm-ok"));

		await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith("janitor-modern-botmaking"));
	});

	it("an unreferenced user skill deletes via a plain confirm (no module list)", async () => {
		listModulesMock.mockResolvedValue([{ id: "cmod_b", name: "Other", skillIds: ["dialogue-generation"] }]);
		const { getByText, getByTestId, queryByTestId } = render(<CoauthorSkillModal />);
		await waitFor(() => expect(getByText("Modern Botmaking")).toBeDefined());
		fireEvent.click(getByTestId("skill-delete-btn-janitor-modern-botmaking"));
		await waitFor(() => expect(queryByTestId("confirm-modal")).not.toBeNull());
		// Plain body (no referencing module name rendered).
		expect(getByTestId("confirm-body").textContent).toBe("coauthor.skill.delete_confirm_body");
		expect(queryByTestId("Other" as never)).toBeNull();
	});
});
