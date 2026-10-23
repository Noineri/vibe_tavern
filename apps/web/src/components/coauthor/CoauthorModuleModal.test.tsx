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
 * AP-25 (mockup §5, mirroring the profile modal): rows carry the name
 * (SC-16d: wraps, never cut) + one in-use marker + 11px sentence-case tag —
 * no ★, no dot, no id line, no hover edit/delete buttons; Dup/Edit/Delete
 * live in the MasterDetailFooter (built-in → Duplicate only; user → Edit +
 * Delete), right side Close + Activate or a quiet in-use state; the base
 * prompt gets the clamped preview + show-full toggle (PROMPT_CLAMP_AT=500).
 * What WAS row/detail buttons is now footer actions — every rewritten
 * assertion notes its was → now with the AP-24 visual-rules basis.
 *
 * Input typing (onChange → state update) is not simulated here — React's
 * synthetic event delegation doesn't reliably fire on happy-dom-dispatched
 * input events through this component's mock tree (proven to work in isolation
 * probes but not in the full nested mock setup). The editor's field-change
 * behavior is verified via Playwright instead. What IS tested: every button →
 * handler → RPC wiring, validation gating, and mode transitions.
 *
 * Tool toggles render human-readable labels via `COAUTHOR_TOOL_LABEL_KEYS`
 * (exhaustive over `COAUTHOR_TOOL_KEYS`); the useT mock returns keys verbatim,
 * so label assertions read as the mapped i18n key, never the raw snake_case.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
import { useModalStore } from "../../stores/modal-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useCoauthorSkillStore } from "../../stores/coauthor-skill-store.js";
import type { CoauthorModule, CoauthorModuleCreate, CoauthorModuleUpdate } from "@vibe-tavern/api-contracts";
import { COAUTHOR_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import type { TFunc } from "../../i18n/context.js";

// Mock useT at the module boundary — returns keys verbatim so assertions match.
// Use `...real` spread (AGENTS.md mock.module gotcha): the mock persists
// process-globally, so every OTHER export of context.js must survive for
// subsequent test files that import LocaleProvider etc.
const realI18nContext = await import("../../i18n/context.js");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realSkillApi = await import("../../api/skill-api.js");
const realMasterDetailModal = await import("../shared/MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../shared/destructive-confirm-modal.js");

mock.module("../../i18n/context.js", () => ({
		...realI18nContext,
		useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

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

// Keep the bindings above the later mock.module registration.
// `listCoauthorModulesAction`'s impl closes over ALL_MODULES lazily (invoked
// at test runtime, by which point ALL_MODULES is initialized); ALL_MODULES is
// declared above so TypeScript sees it before this destructure.
const listCoauthorModulesAction = mock(() => Promise.resolve(ALL_MODULES));
const setCoauthorModuleAction = mock(async (_chatId: string, _moduleId: string | null) => undefined);
const createCoauthorModuleAction = mock(async (_input: CoauthorModuleCreate) => USER_MODULE);
const updateCoauthorModuleAction = mock(async (_moduleId: string, _input: CoauthorModuleUpdate) => USER_MODULE);
const deleteCoauthorModuleAction = mock(async (_moduleId: string) => undefined);

mock.module("../../stores/api-actions/chat-actions.js", () => ({
	...realChatActions,
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
const listSkillsMock = mock(() => Promise.resolve(SKILL_CATALOG));
mock.module("../../api/skill-api.js", () => ({
	...realSkillApi,
	listCoauthorSkills: listSkillsMock,
	readCoauthorSkill: mock(),
	importCoauthorSkills: mock(),
	deleteCoauthorSkill: mock(),
}));

// MasterDetailModal passthrough: render master + detail + footer + headerActions
// flat. Supports both node and render-prop children.
// `...real` spread preserves MasterDetailMobileDrillDown + other exports for
// subsequent test files (mock.module is process-global — AGENTS.md gotcha).

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

// DestructiveConfirmModal passthrough (also uses `...real` spread).

mock.module("../shared/destructive-confirm-modal.js", () => ({
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

let CoauthorModuleModal: typeof import("./CoauthorModuleModal.js").CoauthorModuleModal;
let COAUTHOR_TOOL_LABEL_KEYS: typeof import("./coauthor-tool-labels.js").COAUTHOR_TOOL_LABEL_KEYS;
let resolveCoauthorToolLabel: typeof import("./coauthor-tool-labels.js").resolveCoauthorToolLabel;
beforeAll(async () => {
	({ CoauthorModuleModal } = await import("./CoauthorModuleModal.js"));
	({ COAUTHOR_TOOL_LABEL_KEYS, resolveCoauthorToolLabel } = await import("./coauthor-tool-labels.js"));
});

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
			coauthorContextLinks: [],
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

	it("built-in modules have NO edit or delete affordances (read-only)", async () => {
		// AP-25 was: hover edit/delete row buttons (absent for built-ins) +
		// detail-body Duplicate; now (AP-24 visual rules): NO row carries
		// hover buttons, and the built-in footer's only action is Duplicate.
		setActiveChat(null);
		openModal();
		const { getAllByText, getByText, queryByTestId, queryByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getAllByText("Default Co-Author").length).toBeGreaterThan(0));
		expect(queryByTestId("module-edit-btn-default")).toBeNull();
		expect(queryByTestId("module-delete-btn-default")).toBeNull();
		expect(queryByTestId("module-edit-btn-cmod_1")).toBeNull();
		expect(queryByTestId("module-delete-btn-cmod_1")).toBeNull();
		// The default-selected built-in row's footer: Duplicate only.
		expect(getByText("coauthor.module.duplicate")).toBeTruthy();
		expect(queryByText("coauthor.module.edit")).toBeNull();
		expect(queryByText("coauthor.module.delete")).toBeNull();
	});

	it("user modules show edit + delete footer affordances", async () => {
		// AP-25 was: hover edit/delete row buttons; now (AP-24 visual rules):
		// select the row, Edit + Delete render as footer actions.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText, queryByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		expect(getByText("coauthor.module.delete")).toBeTruthy();
		expect(queryByText("coauthor.module.duplicate")).toBeNull();
	});

	it("clicking edit on a user module opens the editor populated with its data", async () => {
		// AP-25 was: the row hover Edit button; now (AP-24 visual rules):
		// select the row, then the footer Edit action.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		const nameInput = await waitFor(() => getByTestId("module-name-input") as HTMLInputElement);
		expect(nameInput.value).toBe("My Custom Module");
	});

	it("Save on edit calls updateCoauthorModuleAction with the module id", async () => {
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
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
		// AP-25 was: the row hover Delete button; now (AP-24 visual rules):
		// select the row, then the footer Delete action.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.delete")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.delete"));
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
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		await waitFor(() => expect(getByRole("button", { name: "coauthor.module.tool.write_personality" })).toBeTruthy());
		expect(getByRole("button", { name: "coauthor.module.tool.write_scenario" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.write_examples" })).toBeTruthy();
	});

	it("surfaces lore tools as toggle pills (derived from the schema, not hardcoded)", async () => {
		// Wave 4 lore tools must appear alongside the profile/greeting tools. The
		// list is derived from COAUTHOR_TOOL_KEYS (= coauthorToolSetSchema), so this
		// also pins that a newly-added schema key surfaces here automatically.
		setActiveChat(null);
		openModal();
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		await waitFor(() => expect(getByRole("button", { name: "coauthor.module.tool.create_lorebook" })).toBeTruthy());
		expect(getByRole("button", { name: "coauthor.module.tool.create_lore_entry" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.set_lore_activation" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.edit_lorebook" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.edit_lore_entry" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.add_lore_entry" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.ai_write_lore_entry" })).toBeTruthy();
		expect(getByRole("button", { name: "coauthor.module.tool.ai_generate_lore_keys" })).toBeTruthy();
	});

	it("toggling a write tool persists on save without disabling its edit sibling", async () => {
		// USER_MODULE ships toolSet { edit_examples: true } — write_examples is off.
		setActiveChat(null);
		openModal();
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		await waitFor(() => expect(getByRole("button", { name: "coauthor.module.tool.write_examples" })).toBeTruthy());
		// Turn write_examples ON; edit_examples stays ON (independent flags).
		fireEvent.click(getByRole("button", { name: "coauthor.module.tool.write_examples" }));
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
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		await waitFor(() => expect(getByRole("button", { name: "coauthor.module.tool.edit_personality" })).toBeTruthy());
		fireEvent.click(getByRole("button", { name: "coauthor.module.tool.edit_personality" }));
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
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
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
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
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
	it("built-in detail view shows a Duplicate footer action and stays read-only (no edit/delete)", async () => {
		// AP-25 was: Duplicate/Edit/Delete buttons in the detail body; now
		// (AP-24 visual rules): the detail body is button-free, the footer
		// owns the selection-scoped actions (built-in → Duplicate only).
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText, queryByTestId, queryByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("coauthor.module.duplicate")).toBeTruthy());
		expect(queryByTestId("module-view-duplicate-btn")).toBeNull();
		expect(queryByTestId("module-view-edit-btn")).toBeNull();
		expect(queryByTestId("module-view-delete-btn")).toBeNull();
		expect(queryByText("coauthor.module.edit")).toBeNull();
		expect(queryByText("coauthor.module.delete")).toBeNull();
	});

	it("Duplicate seeds the editor with the resolved prompt + skills + tools + budget, and Save creates a user copy", async () => {
		// AP-25 was: the detail-body Duplicate button; now: footer action.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("coauthor.module.duplicate")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.duplicate"));
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
		// AP-25 was: the detail-body Duplicate button; now: footer action.
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByText("coauthor.module.duplicate")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.duplicate"));
		const nameInput = await waitFor(() => getByTestId("module-name-input") as HTMLInputElement);
		fireEvent.change(nameInput, { target: { value: "" } });
		fireEvent.click(getByTestId("module-save-btn"));
		await waitFor(() => expect(createCoauthorModuleAction).not.toHaveBeenCalled());
	});
});

describe("CoauthorModuleModal — human-readable tool labels (HOTFIX-UI)", () => {
	it("renders a mapped label (never the raw key) for every COAUTHOR_TOOL_KEYS entry", async () => {
		// The editor toggle list is driven by COAUTHOR_TOOL_KEYS; each pill
		// shows t(labelKey) — the useT mock returns keys verbatim, so the
		// accessible name is the mapped i18n key and the raw snake_case key
		// matches no toggle.
		setActiveChat(null);
		openModal();
		// AP-25 was: the row hover Edit button; now: footer Edit action.
		const { getByTestId, getByRole, getByText, queryByRole } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByText("coauthor.module.edit")).toBeTruthy());
		fireEvent.click(getByText("coauthor.module.edit"));
		await waitFor(() => expect(getByTestId("module-editor")).toBeTruthy());
		for (const key of COAUTHOR_TOOL_KEYS) {
			expect(getByRole("button", { name: COAUTHOR_TOOL_LABEL_KEYS[key] })).toBeTruthy();
			expect(queryByRole("button", { name: key })).toBeNull();
		}
	});

	it("read-only view renders labels for enabled tools, not raw keys", async () => {
		// The default module ships enabled tools; its detail chips show the
		// same mapped labels as the editor pills.
		setActiveChat(null);
		openModal();
		const { getAllByText, getByText, queryByText } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getAllByText("Default Co-Author").length).toBeGreaterThan(0));
		expect(getByText("coauthor.module.tool.write_profile")).toBeTruthy();
		expect(getByText("coauthor.module.tool.edit_personality")).toBeTruthy();
		expect(queryByText("write_profile")).toBeNull();
		expect(queryByText("edit_personality")).toBeNull();
	});

	it("falls back to the raw key for unmapped (future) tool keys", () => {
		const identity: TFunc = (key) => key;
		expect(resolveCoauthorToolLabel(identity, "some_future_tool")).toBe("some_future_tool");
		expect(resolveCoauthorToolLabel(identity, "write_profile")).toBe("coauthor.module.tool.write_profile");
	});
});

describe("CoauthorModuleModal — rows (AP-25, mockup §5)", () => {
	async function openAndFlush() {
		setActiveChat(null);
		openModal();
		const queries = render(<CoauthorModuleModal />);
		await waitFor(() => expect(queries.getByTestId("module-row-default")).toBeTruthy());
		return queries;
	}

	it("rows carry no hover edit/delete icons (actions live in the footer)", async () => {
		// AP-25 was: user rows carried hover edit/delete buttons; now (AP-24
		// visual rules): NO row carries them — Edit/Delete live in the
		// MasterDetailFooter, one set for the selection.
		const { queryByTestId } = await openAndFlush();
		expect(queryByTestId("module-edit-btn-default")).toBeNull();
		expect(queryByTestId("module-delete-btn-default")).toBeNull();
		expect(queryByTestId("module-edit-btn-cmod_1")).toBeNull();
		expect(queryByTestId("module-delete-btn-cmod_1")).toBeNull();
	});

	it("marks the active module with the in-use marker (null assignment → default active)", async () => {
		// AP-25 was: the active row carried "★ "; now (AP-24 visual rules):
		// the check + in-use marker line, no star, no dot.
		const { getByTestId } = await openAndFlush();
		expect(getByTestId("module-row-default").textContent).toContain("copilot_profile_in_use");
		expect(getByTestId("module-row-default").textContent).not.toContain("★");
		expect(getByTestId("module-row-cmod_1").textContent).not.toContain("copilot_profile_in_use");
	});

	it("a user assignment moves the marker", async () => {
		setActiveChat("cmod_1");
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		expect(getByTestId("module-row-cmod_1").textContent).toContain("copilot_profile_in_use");
		expect(getByTestId("module-row-default").textContent).not.toContain("copilot_profile_in_use");
	});

	it("renders the name and the pills on separate lines; the name wraps (no truncate)", async () => {
		const { getByTestId, queryByTestId } = await openAndFlush();
		const nameEl = getByTestId("module-row-name-default");
		const pillsEl = getByTestId("module-row-pills-default");
		expect(nameEl.textContent).toContain("Default Co-Author");
		expect(pillsEl.textContent).toContain("coauthor.module.built_in");
		expect(nameEl.contains(pillsEl)).toBe(false);
		expect(pillsEl.contains(nameEl)).toBe(false);
		const classes = nameEl.className.split(/\s+/);
		expect(classes).not.toContain("truncate");
		expect(classes).toContain("whitespace-normal");
		expect(classes).toContain("break-words");
		// A user row carries no pill line.
		expect(getByTestId("module-row-name-cmod_1").textContent).toContain("My Custom Module");
		expect(queryByTestId("module-row-pills-cmod_1")).toBeNull();
	});

	it("renders tags as 11px sentence-case (no mono uppercase pills)", async () => {
		// AP-25 was: `font-mono text-[9px] uppercase` pills; now (AP-24 visual
		// rules): the tag canon — font-ui, ui-fs-3px (= 11 px), no case.
		const { getByTestId } = await openAndFlush();
		const tag = getByTestId("module-row-pills-default").querySelector("span");
		expect(tag).not.toBeNull();
		const classes = (tag as HTMLElement).className.split(/\s+/);
		expect(classes).toContain("text-[calc(var(--ui-fs)-3px)]");
		expect(classes).not.toContain("uppercase");
		expect(classes).not.toContain("font-mono");
	});
});

describe("CoauthorModuleModal — detail (AP-25, mockup §5)", () => {
	it("shows name + tag (custom for a user module, built-in for the seed)", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByTestId("module-prompt-preview")).toBeTruthy());
		expect(getByTestId("module-detail-name").textContent).toBe("My Custom Module");
		expect(getByTestId("module-detail-tag").textContent).toBe("copilot_profile_custom_tag");
		fireEvent.pointerDown(getByTestId("module-row-default"));
		await waitFor(() => expect(getByTestId("module-detail-name").textContent).toBe("Default Co-Author"));
		expect(getByTestId("module-detail-tag").textContent).toBe("coauthor.module.built_in");
	});

	it("clamps a long base prompt with a show-full toggle; a short one renders whole", async () => {
		// The AP-23 precedent (>500 chars → line-clamp-8 + show-full toggle;
		// shorter bodies render whole with no toggle), mirrored from AP-24.
		const LONG_PROMPT = `You author with the user. ${"Rule after rule, with examples. ".repeat(30)}`;
		const LONG_MOD: CoauthorModule = {
			id: "cmod_long",
			name: "Long Prompt",
			description: "A module with a very long base prompt.",
			basePrompt: LONG_PROMPT,
			openingMessage: "",
			skillIds: [],
			toolSet: {},
			maxSteps: 5,
			isBuiltIn: false,
		};
		listCoauthorModulesAction.mockReturnValue(Promise.resolve([...ALL_MODULES, LONG_MOD]));
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_long")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_long"));
		await waitFor(() => expect(getByTestId("module-prompt-preview")).toBeTruthy());
		const preview = getByTestId("module-prompt-preview");
		expect(preview.textContent).toContain("Rule after rule");
		expect(preview.getAttribute("class") ?? "").toContain("line-clamp-8");
		fireEvent.click(getByText("copilot_skill_show_full"));
		await waitFor(() => expect(getByText("copilot_skill_collapse")).toBeDefined());
		expect(getByTestId("module-prompt-preview").getAttribute("class") ?? "").not.toContain("line-clamp-8");
		fireEvent.click(getByText("copilot_skill_collapse"));
		await waitFor(() => expect(getByText("copilot_skill_show_full")).toBeDefined());
		expect(getByTestId("module-prompt-preview").getAttribute("class") ?? "").toContain("line-clamp-8");
		// A short prompt (the seed) renders whole with no toggle.
		fireEvent.pointerDown(getByTestId("module-row-default"));
		await waitFor(() => expect(queryByTestId("module-prompt-toggle")).toBeNull());
		expect(getByTestId("module-prompt-preview").getAttribute("class") ?? "").not.toContain("line-clamp-8");
	});
});

describe("CoauthorModuleModal — footer (AP-25, mockup §5)", () => {
	it("the active selection shows a quiet in-use state instead of the Activate button", async () => {
		// AP-25 was: the active selection kept an accent button reading
		// `coauthor.module.active`; now (AP-24 visual rules): a quiet in-use
		// label — no second primary action.
		setActiveChat(null);
		openModal();
		const { getByTestId, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-default")).toBeTruthy());
		await waitFor(() => expect(getByTestId("module-in-use-state")).toBeDefined());
		expect(getByTestId("module-in-use-state").textContent).toContain("copilot_profile_in_use_label");
		expect(queryByTestId("module-activate-btn")).toBeNull();
		// The footer still closes: Close + the duplicate action render.
		expect(getByTestId("md-footer").textContent).toContain("close");
	});

	it("selecting a non-active module swaps the quiet state for the Activate primary", async () => {
		setActiveChat(null);
		openModal();
		const { getByTestId, getByText, queryByTestId } = render(<CoauthorModuleModal />);
		await waitFor(() => expect(getByTestId("module-row-cmod_1")).toBeTruthy());
		fireEvent.pointerDown(getByTestId("module-row-cmod_1"));
		await waitFor(() => expect(getByTestId("module-activate-btn")).toBeTruthy());
		expect(getByText("coauthor.module.activate")).toBeTruthy();
		expect(queryByTestId("module-in-use-state")).toBeNull();
	});
});
