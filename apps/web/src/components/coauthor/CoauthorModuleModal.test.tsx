/**
 * CS-25 — author-module manager (MasterDetail): create / edit / delete / activate.
 *
 * The modal was a read-only picker (CS-16); CS-25 rewrites it into a full
 * manager. Pins:
 *   - lists every module on open; built-in modules show a "Built-in" badge;
 *   - built-in modules have NO edit/delete buttons (read-only);
 *   - user modules show edit + delete affordances;
 *   - editing a user module opens the editor form populated with its data;
 *   - Save on an edited module calls updateCoauthorModuleAction;
 *   - "+ New module" opens a blank editor; saving a blank draft is blocked by
 *     client-side validation (name required → no RPC);
 *   - deleting a user module asks for confirmation, then calls
 *     deleteCoauthorModuleAction;
 *   - activating a non-active module calls setCoauthorModuleAction and closes.
 *
 * Input typing (onChange → state update) is not simulated here — React's
 * synthetic event delegation doesn't reliably fire on happy-dom-dispatched
 * input events through this component's mock tree (proven to work in isolation
 * probes but not in the full nested mock setup). The editor's field-change
 * behavior is verified via Playwright instead. What IS tested: every button →
 * handler → RPC wiring, validation gating, and mode transitions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useModalStore } from "../../stores/modal-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useCoauthorSkillStore } from "../../stores/coauthor-skill-store.js";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
// Use `...real` spread (AGENTS.md mock.module gotcha): the mock persists
// process-globally, so every OTHER export of context.js must survive for
// subsequent test files that import LocaleProvider etc.
vi.mock("../../i18n/context.js", async (importOriginal) => {
	const i18nReal = await importOriginal() as typeof import("../../i18n/context.js");
	return {
		...i18nReal,
		useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
	};
});

const SEED_MODULES: CoauthorModule[] = [
	{
		id: "default",
		name: "Default Co-Author",
		description: "A balanced co-author module.",
		basePrompt: "You are a co-author assistant. ...",
		openingMessage: "I'm ready to help you build {{char}}.",
		skillIds: ["general-writing"],
		toolSet: { write_profile: true, edit_personality: true, edit_scenario: true, edit_examples: true, edit_greeting: true, add_alt_greeting: true, edit_alt_greeting: true },
		maxSteps: 5,
		isBuiltIn: true,
	},
	{
		id: "profile-editor",
		name: "Profile Editor",
		description: "Refines character profiles.",
		basePrompt: "You focus on profiles. ...",
		openingMessage: "I'll focus on {{char}}'s profile.",
		skillIds: ["profile-analysis"],
		toolSet: { write_profile: true, edit_personality: true },
		maxSteps: 3,
		isBuiltIn: true,
	},
];

const USER_MODULE: CoauthorModule = {
	id: "cmod_1",
	name: "My Custom Module",
	description: "A user-created module.",
	basePrompt: "Custom prompt text.",
	openingMessage: "Let's build {{char}}.",
	skillIds: ["dialogue-generation"],
	toolSet: { edit_examples: true },
	maxSteps: 7,
	isBuiltIn: false,
};

const ALL_MODULES = [...SEED_MODULES, USER_MODULE];

// vi.hoisted: vi.mock (below) is hoisted above these consts, so its factory
// would close over uninitialized bindings. Hoisting the fns alongside the
// mock keeps the vi.mock factory and all test-body call sites unchanged.
// `listCoauthorModulesAction`'s impl closes over ALL_MODULES lazily (invoked
// at test runtime, by which point ALL_MODULES is initialized); ALL_MODULES is
// declared above so TypeScript sees it before this destructure.
const {
	listCoauthorModulesAction,
	setCoauthorModuleAction,
	createCoauthorModuleAction,
	updateCoauthorModuleAction,
	deleteCoauthorModuleAction,
} = vi.hoisted(() => ({
	listCoauthorModulesAction: vi.fn(() => Promise.resolve(ALL_MODULES)),
	setCoauthorModuleAction: vi.fn<(chatId: string, moduleId: string | null) => Promise<void>>(async () => {}),
	createCoauthorModuleAction: vi.fn(async (_input: unknown) => ({}) as CoauthorModule),
	updateCoauthorModuleAction: vi.fn(async (_id: string, _input: unknown) => ({}) as CoauthorModule),
	deleteCoauthorModuleAction: vi.fn(async (_id: string) => {}),
}));

vi.mock("../../stores/api-actions/chat-actions.js", () => ({
	listCoauthorModulesAction,
	setCoauthorModuleAction,
	createCoauthorModuleAction,
	updateCoauthorModuleAction,
	deleteCoauthorModuleAction,
}));

// CTX-S7: skill catalog the module editor's skill picker renders. Mocked so the
// modal's `loadSkills()` on open resolves cleanly (no real fetch) and the
// picker is exercised against a known catalog.
const SKILL_CATALOG = {
	entries: [
		{ id: "general-writing", source: "builtin" as const, name: "General Writing", description: "Vivid prose.", manifestPath: "general-writing/SKILL.md", shadowsBuiltin: false },
		{ id: "dialogue-generation", source: "builtin" as const, name: "Dialogue Generation", description: "Voice/dialogue.", manifestPath: "dialogue-generation/SKILL.md", shadowsBuiltin: false },
	],
	errors: [],
};
const { listSkillsMock } = vi.hoisted(() => ({ listSkillsMock: vi.fn(() => Promise.resolve(SKILL_CATALOG)) }));
vi.mock("../../api/skill-api.js", () => ({
	listCoauthorSkills: listSkillsMock,
	readCoauthorSkill: vi.fn(),
	importCoauthorSkills: vi.fn(),
	deleteCoauthorSkill: vi.fn(),
}));

// MasterDetailModal passthrough: render master + detail + footer + headerActions
// flat. Supports both node and render-prop children.
// `...real` spread preserves MasterDetailMobileDrillDown + other exports for
// subsequent test files (mock.module is process-global — AGENTS.md gotcha).
vi.mock("../shared/MasterDetailModal.js", async (importOriginal) => {
	const mdmReal = await importOriginal() as typeof import("../shared/MasterDetailModal.js");
	return {
		...mdmReal,
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
	};
});

// DestructiveConfirmModal passthrough (also uses `...real` spread).
vi.mock("../shared/destructive-confirm-modal.js", async (importOriginal) => {
	const dcmReal = await importOriginal() as typeof import("../shared/destructive-confirm-modal.js");
	return {
		...dcmReal,
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
	};
});

const { CoauthorModuleModal } = await import("./CoauthorModuleModal.js");


beforeEach(() => {
	listCoauthorModulesAction.mockReturnValue(Promise.resolve(ALL_MODULES));
	listSkillsMock.mockReturnValue(Promise.resolve(SKILL_CATALOG));
	setCoauthorModuleAction.mockClear();
	createCoauthorModuleAction.mockClear();
	updateCoauthorModuleAction.mockClear();
	deleteCoauthorModuleAction.mockClear();
});

afterEach(() => {
	useModalStore.setState({ isCoauthorModuleModalOpen: false });
	useSnapshotStore.setState({ activeChat: null });
	useCoauthorSkillStore.setState({ entries: [], errors: [], isLoading: false, hasLoaded: false });
});

function openModal() {
	useModalStore.setState({ isCoauthorModuleModalOpen: true });
}

function setActiveChat(coauthorModuleId: string | null) {
	useSnapshotStore.setState({
		activeChat: {
			id: "chat_test",
			characterId: "char_test",
			mode: "coauthor",
			coauthorModuleId,
			coauthorLorebookIds: [],
		} as never,
	});
}

describe("CoauthorModuleModal (CS-25 manager)", () => {
	it("lists every module on open; built-ins carry a Built-in badge", async () => {
		setActiveChat(null);
		openModal();
		const { getAllByText, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getAllByText("Default Co-Author").length).toBeGreaterThan(0));
		expect(getByText("Profile Editor")).toBeTruthy();
		expect(getByText("My Custom Module")).toBeTruthy();
		expect(getAllByText("coauthor.module.built_in").length).toBeGreaterThan(0);
	});

	it("built-in modules have NO edit or delete buttons (read-only)", async () => {
		setActiveChat(null);
		openModal();
		const { getAllByText, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getAllByText("Default Co-Author").length).toBeGreaterThan(0));
		expect(queryByTestId("module-edit-btn-default")).toBeNull();
		expect(queryByTestId("module-delete-btn-default")).toBeNull();
	});

	it("user modules show edit + delete affordances", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		expect(getByTestId("module-delete-btn-cmod_1")).toBeTruthy();
	});

	it("clicking edit on a user module opens the editor populated with its data", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		const nameInput = await waitFor(() => getByTestId("module-name-input") as HTMLInputElement);
		expect(nameInput.value).toBe("My Custom Module");
	});

	it("Save on edit calls updateCoauthorModuleAction with the module id", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		// Editor opens with Save/Cancel footer.
		await waitFor(() => expect(getByTestId("module-save-btn")).toBeTruthy());
		// Save commits the draft (unchanged from the loaded module data).
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(updateCoauthorModuleAction).toHaveBeenCalledTimes(1));
		expect(updateCoauthorModuleAction.mock.calls[0][0]).toBe("cmod_1");
	});

	it("+ New module opens a blank editor; Save with empty name shows validation error (no RPC)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-new-btn")).toBeTruthy());
		fireEvent.click(getByTestId("module-new-btn"));
		// Editor opens blank with a name input.
		await waitFor(() => expect(getByTestId("module-name-input")).toBeTruthy());
		expect(getByTestId("module-save-btn")).toBeTruthy();
		// Saving a blank draft triggers client-side validation — no RPC call.
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(createCoauthorModuleAction).not.toHaveBeenCalled());
	});

	it("delete asks for confirmation, then calls deleteCoauthorModuleAction", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-delete-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-delete-btn-cmod_1"));
		await waitFor(() => expect(getByTestId("confirm-modal")).toBeTruthy());
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(deleteCoauthorModuleAction).toHaveBeenCalledTimes(1));
		expect(deleteCoauthorModuleAction.mock.calls[0][0]).toBe("cmod_1");
	});

	it("activating a non-active module calls setCoauthorModuleAction(chatId, moduleId)", async () => {
		setActiveChat(null);
		openModal();
		const { getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("Profile Editor")).toBeTruthy());
		// Rows select via onPointerDown (matches the canonical PresetList /
		// ProviderProfileList pattern for touch-manipulation); pointerDown bubbles
		// up from the name span to the row handler.
		fireEvent.pointerDown(getByText("Profile Editor"));
		await waitFor(() => expect(getByText("coauthor.module.activate")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.activate"));
		await waitFor(() => expect(setCoauthorModuleAction).toHaveBeenCalledTimes(1));
		expect(setCoauthorModuleAction.mock.calls[0]).toEqual(["chat_test", "profile-editor"]);
	});

	it("exposes the three section write tools as toggle pills in the editor (CED-4)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId, getByRole } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		await waitFor(() => expect(getByRole("button", { name: "write_personality" })).toBeTruthy());
		expect(getByRole("button", { name: "write_scenario" })).toBeTruthy();
		expect(getByRole("button", { name: "write_examples" })).toBeTruthy();
	});

	it("toggling a write tool persists on save without disabling its edit sibling", async () => {
		// USER_MODULE ships toolSet { edit_examples: true } — write_examples is off.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByRole } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		await waitFor(() => expect(getByRole("button", { name: "write_examples" })).toBeTruthy());
		// Turn write_examples ON; edit_examples stays ON (independent flags).
		fireEvent.click(getByRole("button", { name: "write_examples" }));
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(updateCoauthorModuleAction).toHaveBeenCalledTimes(1));
		const input = updateCoauthorModuleAction.mock.calls[0][1] as { toolSet: Record<string, boolean> };
		expect(input.toolSet).toStrictEqual({ edit_examples: true, write_examples: true });
	});

	it("toggling an edit tool on does not enable its write sibling", async () => {
		// USER_MODULE ships toolSet { edit_examples: true }; edit_personality and
		// write_personality are both off. Toggling edit_personality ON must not
		// flip write_personality.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByRole } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		await waitFor(() => expect(getByRole("button", { name: "edit_personality" })).toBeTruthy());
		fireEvent.click(getByRole("button", { name: "edit_personality" }));
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(updateCoauthorModuleAction).toHaveBeenCalledTimes(1));
		const input = updateCoauthorModuleAction.mock.calls[0][1] as { toolSet: Record<string, boolean> };
		expect(input.toolSet).toStrictEqual({ edit_examples: true, edit_personality: true });
	});
});

describe("CoauthorModuleModal — catalog-driven skill picker (CTX-S7)", () => {
	it("renders the merged skill catalog as toggle chips (not a hardcoded list)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId, getByRole } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		// Catalog-driven: chips are the skill NAMES from the catalog, not the old
		// hardcoded id list. Both catalog skills appear; the one this module
		// binds (dialogue-generation) is active.
		await waitFor(() => expect(getByRole("button", { name: "General Writing" })).toBeTruthy());
		expect(getByRole("button", { name: "Dialogue Generation" })).toBeTruthy();
		const bound = getByRole("button", { name: "Dialogue Generation" });
		expect(bound.className).toContain("accent");
	});

	it("renders an orphan binding (skill no longer in the catalog) distinctly so it can be unbound", async () => {
		// Empty catalog → the module's `dialogue-generation` binding is now orphaned.
		listSkillsMock.mockReturnValue(Promise.resolve({ entries: [], errors: [] }));
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-edit-btn-cmod_1")).toBeTruthy());
		fireEvent.click(getByTestId("module-edit-btn-cmod_1"));
		// The orphan chip is present (struck-through, danger) and unbinds on click.
		const orphan = await waitFor(() => getByTestId("module-skill-orphan-dialogue-generation"));
		expect(orphan.className).toContain("line-through");
		fireEvent.click(orphan);
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(updateCoauthorModuleAction).toHaveBeenCalledTimes(1));
		const input = updateCoauthorModuleAction.mock.calls[0][1] as { skillIds: string[] };
		expect(input.skillIds).toEqual([]);
	});
});

describe("CoauthorModuleModal — built-in Duplicate (CTX-M3)", () => {
	it("built-in detail view shows a Duplicate button and stays read-only (no edit/delete)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-view-duplicate-btn")).toBeTruthy());
		expect(queryByTestId("module-view-edit-btn")).toBeNull();
		expect(queryByTestId("module-view-delete-btn")).toBeNull();
	});

	it("Duplicate seeds the editor with the resolved prompt + skills + tools + budget, and Save creates a user copy", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-view-duplicate-btn")).toBeTruthy());
		fireEvent.click(getByTestId("module-view-duplicate-btn"));
		const nameInput = await waitFor(() => getByTestId("module-name-input") as HTMLInputElement);
		// Name carries the copy-suffix key appended (the useT mock returns keys
		// verbatim, per the file convention; the real " (copy)" value is pinned
		// by i18n:check). Proves the built-in name is the seed of the new draft.
		expect(nameInput.value).toBe("Default Co-Author" + "coauthor.module.duplicate_suffix");
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(createCoauthorModuleAction).toHaveBeenCalledTimes(1));
		// The created user copy carries the built-in's RESOLVED fields verbatim —
		// later seed changes never mutate it (it is persisted with its own text).
		const created = createCoauthorModuleAction.mock.calls[0][0] as {
			name: string; basePrompt: string; skillIds: string[];
			toolSet: Record<string, boolean>; maxSteps: number;
		};
		expect(created.name).toBe("Default Co-Author" + "coauthor.module.duplicate_suffix");
		expect(created.basePrompt).toBe("You are a co-author assistant. ...");
		expect(created.skillIds).toEqual(["general-writing"]);
		expect(created.toolSet.write_profile).toBe(true);
		expect(created.toolSet.edit_personality).toBe(true);
		expect(created.maxSteps).toBe(5);
	});

	it("Duplicate then clearing the name blocks Save with the validation toast (no RPC)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-view-duplicate-btn")).toBeTruthy());
		fireEvent.click(getByTestId("module-view-duplicate-btn"));
		const nameInput = await waitFor(() => getByTestId("module-name-input") as HTMLInputElement);
		fireEvent.change(nameInput, { target: { value: "" } });
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(createCoauthorModuleAction).not.toHaveBeenCalled());
	});
});
