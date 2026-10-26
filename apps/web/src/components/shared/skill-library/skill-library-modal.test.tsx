/**
 * AP-23 — skill library polish: pins the mockup §6–7 layout of the merged
 * `SkillLibraryModal` through a fake adapter (no stores, no network).
 *
 * What is pinned (mockup §6–7, was → now against the AP-22 merged modal):
 *   - rows: name + one-line description (was: name + id line + per-row
 *     delete + shadow pill — all gone);
 *   - detail: name + «свой»/«встроенный» tag, description, lazy «Текст
 *     навыка» preview clamped to 8 lines with «Показать целиком»/«Свернуть»,
 *     collapsed «Технические детали» disclosure (id, path, source, shadow
 *     note, file list);
 *   - footer: shared `MasterDetailFooter` («Удалить» left for user skills,
 *     Close right), no per-row deletes anywhere;
 *   - «Импортировать папку» docked at the list bottom (was: headerActions),
 *     empty library = explanation + import CTA;
 *   - `parentBack` forwarded to `MasterDetailModal`.
 *
 * AP-23d — the mockup §8 skill editor, same fake adapter + the new create /
 * update seams (`save`):
 *   - «+ Новый навык» docks ABOVE the import (was: no entry point at all);
 *   - the detail gains an EDIT mode (the AP-23 view stays untouched):
 *     «Название» / «Когда использовать» (+ verbatim hint) / «Текст навыка»
 *     mono + the compact «ИИ-помощник» button (`apiMode="skill"`, the
 *     mocked AI modal pins replace/insert like `LoreEntryEditor`);
 *   - footer matrix: view user = «Изменить»/«Дублировать»/«Удалить» (was:
 *     delete only), view built-in = «Дублировать» only (was: empty), edit =
 *     «Отмена»/«Сохранить» right («Сохранить» blocks on a blank name);
 *   - save: blank new + duplicate prefill («{name} (копия)» + AP-21 body)
 *     create via `save(null, …)`, edit updates via `save(id, …)`; success
 *     returns to the view of the saved skill;
 *   - dirty guard: modal close, «Отмена», and list navigation all ask via
 *     `ConfirmCloseModal` (the PromptManagerModal convention); a clean
 *     editor exits immediately.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
const { act, fireEvent, render, waitFor, within } = await import("@testing-library/react");
import type { SkillCatalogEntryDto, SkillContentDto } from "@vibe-tavern/api-contracts";
import type { SkillLibraryAdapter, SkillLibraryTestids } from "./skill-library-adapter.js";

const realMasterDetailModal = await import("../MasterDetailModal.js");
const realDestructiveConfirmModal = await import("../destructive-confirm-modal.js");
const realConfirmCloseModal = await import("../confirm-close-modal.js");
const realAnimatedDisclosure = await import("../AnimatedDisclosure.js");
const realAiAssistantModal = await import("../AiAssistantModal.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
const realDndKit = await import("@dnd-kit/core");
import type { ComponentProps } from "react";

installI18nContextSeam();

mock.module("../../../hooks/use-mobile.js", () => ({
	...realUseMobile,
	useIsMobile: () => false,
}));
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
type RealDragOverlayProps = ComponentProps<typeof realDndKit.DragOverlay>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;
mock.module("@dnd-kit/core", () => ({
	...realDndKit,
	DndContext: (props: RealDndContextProps) => {
		dndHandlers = props;
		return <RealDndContext {...props} />;
	},
	DragOverlay: (props: RealDragOverlayProps) => <>{props.children}</>,
}));

// MasterDetailModal passthrough (children rendered flat, props captured so
// the suite can pin the header/footer wiring + parentBack forwarding).
// Co-load contract (ML-1 rework, ML-8 rework): the ...real spread supplies
// the REAL MasterDetailMobileDrillDown (with its master_detail_open aria),
// an aria-less stub poisons master-list.test.tsx caret pins (mock.module is
// process-global, last-write-wins). useMasterDetail stays shape-identical
// with master-list.test.tsx (isDetailOpen: false).
type ModalProps = {
	isOpen: boolean;
	onClose: () => void;
	headerActions?: unknown;
	masterContent: unknown;
	detailContent: unknown;
	footer?: unknown;
	parentBack?: { label: string; onBack: () => void };
};
let lastModalProps: ModalProps | null = null;
mock.module("../MasterDetailModal.js", () => ({
	...realMasterDetailModal,
	MasterDetailModal: (props: ModalProps) => {
		lastModalProps = props;
		if (!props.isOpen) return null;
		const resolve = (c: unknown) => (typeof c === "function" ? (c as (ctx: { openDetail: () => void; closeDetail: () => void }) => React.ReactNode)({ openDetail: () => {}, closeDetail: () => {} }) : c);
		return (
			<div data-testid="md-modal">
				<div data-testid="md-header-actions">{props.headerActions as React.ReactNode}</div>
				<div data-testid="md-master">{resolve(props.masterContent) as React.ReactNode}</div>
				<div data-testid="md-detail">{resolve(props.detailContent) as React.ReactNode}</div>
				<div data-testid="md-footer">{props.footer as React.ReactNode}</div>
				<button type="button" onClick={props.onClose} data-testid="md-close">close</button>
			</div>
		);
	},
	useMasterDetail: () => ({ isMobile: false, isDetailOpen: false, openDetail: () => {}, closeDetail: () => {} }),
}));

// ConfirmCloseModal passthrough (pins the dirty-guard wiring: the guard
// opens it, its confirm applies the pending exit, its cancel stays).
mock.module("../confirm-close-modal.js", () => ({
	...realConfirmCloseModal,
	ConfirmCloseModal: ({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) => (
		<div data-testid="confirm-close">
			<button type="button" data-testid="confirm-close-ok" onClick={onConfirm}>confirm-close-ok</button>
			<button type="button" data-testid="confirm-close-cancel" onClick={onCancel}>confirm-close-cancel</button>
		</div>
	),
}));

// AiAssistantModal passthrough: open renders two buttons driving the
// replace/insert callbacks (pins the LoreEntryEditor semantics the editor
// mirrors); closed renders nothing (the editor owns the open state).
let aiProps: { isOpen: boolean; onReplace?: (text: string) => void; onInsert?: (text: string) => void } | null = null;
mock.module("../AiAssistantModal.js", () => ({
	...realAiAssistantModal,
	AiAssistantModal: (props: { isOpen: boolean; onReplace?: (text: string) => void; onInsert?: (text: string) => void }) => {
		aiProps = props;
		if (!props.isOpen) return null;
		return (
			<div data-testid="ai-modal">
				<button type="button" data-testid="ai-replace" onClick={() => props.onReplace?.("Generated text.")}>replace</button>
				<button type="button" data-testid="ai-insert" onClick={() => props.onInsert?.("More.")}>insert</button>
			</div>
		);
	},
}));

mock.module("../destructive-confirm-modal.js", () => ({
	...realDestructiveConfirmModal,
	DestructiveConfirmModal: ({ title, body, confirmLabel, onConfirm, onCancel }: {
		title: React.ReactNode; body: React.ReactNode; confirmLabel: string;
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

// AnimatedDisclosure passthrough: open → children in the DOM, closed →
// absent (pins the collapsed-by-default contract without animation timing).
mock.module("../AnimatedDisclosure.js", () => ({
	...realAnimatedDisclosure,
	AnimatedDisclosure: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
}));

let SkillLibraryModal: typeof import("./skill-library-modal.js").SkillLibraryModal;
beforeAll(async () => {
	({ SkillLibraryModal } = await import("./skill-library-modal.js"));
});

// ─── Fake adapter ────────────────────────────────────────────────────────

const LABELS: SkillLibraryAdapter["labels"] = {
	title: "TITLE",
	subtitle: "SUBTITLE",
	importCta: "IMPORT_CTA",
	importing: "IMPORTING",
	importSuccess: "IMPORT_OK",
	importFailed: "IMPORT_FAIL",
	listLabel: "LIST",
	loading: "LOADING",
	emptyTitle: "EMPTY_TITLE",
	emptyBody: "EMPTY_BODY",
	emptyDetail: "EMPTY_DETAIL",
	delete: "DELETE",
	deleted: "DELETED",
	deleteFailed: "DELETE_FAIL",
	deleteConfirmTitle: "DEL_TITLE",
	deleteConfirmBody: "DEL_BODY",
	user: "OWN",
	builtIn: "BUILT_IN",
	shadow: "SHADOW",
	shadowTitle: "SHADOW_NOTE",
	idLabel: "ID",
	manifestLabel: "PATH",
	sourceLabel: "SOURCE",
	bodyLabel: "BODY_LABEL",
	showFull: "SHOW_FULL",
	collapse: "COLLAPSE",
	contentLoading: "CONTENT_LOADING",
	techDetails: "TECH",
	techDetailsHint: "TECH_HINT",
	filesLabel: "FILES",
	newSkill: "NEW_SKILL",
	edit: "EDIT",
	duplicate: "DUPLICATE",
	cancel: "CANCEL",
	save: "SAVE",
	saved: "SAVED",
	saveFailed: "SAVE_FAILED",
	nameLabel: "NAME_LABEL",
	whenLabel: "WHEN_LABEL",
	whenHint: "WHEN_HINT",
	copyName: "COPY_NAME",
};

const TESTIDS: SkillLibraryTestids = {
	folderInput: "test-folder-input",
	importBtn: "test-import-btn",
	row: (skillId) => `test-row-${skillId}`,
	previewToggle: "test-preview-toggle",
	techDetailsToggle: "test-tech-toggle",
	contentBody: "test-content-body",
	newSkillBtn: "test-new-btn",
	editorName: "test-editor-name",
	editorWhen: "test-editor-when",
	editorBody: "test-editor-body",
	aiAssistBtn: "test-ai-btn",
};

const BUILTIN_ENTRY: SkillCatalogEntryDto = {
	id: "grill-me",
	source: "builtin",
	name: "Grill Me",
	description: "Design interview before building.",
	manifestPath: "grill-me/SKILL.md",
	shadowsBuiltin: false,
};

const USER_ENTRY: SkillCatalogEntryDto = {
	id: "my-style",
	source: "user",
	name: "My Style",
	description: "Naming and comments",
	manifestPath: "my-style/SKILL.md",
	shadowsBuiltin: false,
};

const SHADOW_ENTRY: SkillCatalogEntryDto = {
	id: "grill-me-shadow",
	source: "user",
	name: "Grill Me Plus",
	description: "My extended interview.",
	manifestPath: "grill-me-shadow/SKILL.md",
	shadowsBuiltin: true,
};

const LONG_BODY = `Variables are camelCase by meaning.\n${"A comment only where the why is not obvious. ".repeat(30)}`;
const SHORT_BODY = "Short body.";

function contentFor(id: string, body: string, files: string[] = ["references/notes.md"]): SkillContentDto {
	return { id, path: `${id}/SKILL.md`, content: `---\nname: ${id}\n---\n${body}`, body, files };
}

const loadMock = mock();
const importTreeMock = mock();
const removeMock = mock();
const readContentMock = mock();
const findReferencingModulesMock = mock();
const reorderMock = mock();
// The create/update seam (AP-23d): null id creates (mirroring the
// server-side id derivation with a fixed fresh id), a set id updates in
// place — the in-place catalog refresh the stores perform on save.
const saveMock = mock();
const fakeEntries: SkillCatalogEntryDto[] = [];
let serverEntries: SkillCatalogEntryDto[] = [];
function syncFakeFromServer() {
	fakeEntries.length = 0;
	fakeEntries.push(...serverEntries);
}
function applyServerReorder(updates: Array<{ id: string; sortOrder: number }>) {
	const rank = new Map(updates.map((u) => [u.id, u.sortOrder]));
	serverEntries = [...serverEntries].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
	syncFakeFromServer();
}

function makeAdapter(overrides?: Partial<SkillLibraryAdapter>): SkillLibraryAdapter {
	return {
		labels: LABELS,
		testids: TESTIDS,
		entries: fakeEntries,
		isLoading: false,
		hasLoaded: true,
		load: loadMock,
		importTree: importTreeMock,
		remove: removeMock,
		readContent: readContentMock,
		save: saveMock,
		reorder: reorderMock,
		...overrides,
	};
}

function renderModal(adapter?: SkillLibraryAdapter, parentBack?: { label: string; onBack: () => void }, onClose?: () => void) {
	return render(<SkillLibraryModal isOpen onClose={onClose ?? mock()} adapter={adapter ?? makeAdapter()} parentBack={parentBack} />);
}

beforeEach(() => {
	dndHandlers = null;
	serverEntries = [BUILTIN_ENTRY, USER_ENTRY];
	syncFakeFromServer();
	loadMock.mockReset();
	loadMock.mockImplementation(async () => { syncFakeFromServer(); });
	reorderMock.mockReset();
	reorderMock.mockImplementation(async (updates: Array<{ id: string; sortOrder: number }>) => { applyServerReorder(updates); });
	importTreeMock.mockReset();
	importTreeMock.mockResolvedValue(["my-style"]);
	removeMock.mockReset();
	removeMock.mockResolvedValue(undefined);
	readContentMock.mockReset();
	readContentMock.mockImplementation(async (id) => contentFor(id, LONG_BODY));
	findReferencingModulesMock.mockReset();
	findReferencingModulesMock.mockResolvedValue([]);
	saveMock.mockReset();
	saveMock.mockImplementation(async (id, input) => {
		const savedId = id ?? "fresh-skill";
		const saved: SkillCatalogEntryDto = {
			id: savedId,
			source: "user",
			name: input.name,
			description: input.description,
			manifestPath: `${savedId}/SKILL.md`,
			shadowsBuiltin: false,
		};
		const ix = serverEntries.findIndex((e) => e.id === savedId);
		if (ix >= 0) serverEntries[ix] = saved;
		else serverEntries.push(saved);
		syncFakeFromServer();
		return saved;
	});
	lastModalProps = null;
	aiProps = null;
});

describe("skill-library-modal — master rows (mockup §6)", () => {
	it("rows show name + one-line description, no id line, no per-row delete", async () => {
		const { getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		expect(getByText("Naming and comments")).toBeDefined();
		expect(getByText("Grill Me")).toBeDefined();
		// No id / manifest leak into the rows.
		expect(queryByText("my-style")).toBeNull();
		expect(queryByText("grill-me")).toBeNull();
		expect(queryByText("my-style/SKILL.md")).toBeNull();
		// No delete affordance before a user skill is selected (the footer
		// owns delete now — the old per-row buttons are gone).
		expect(queryByText("DELETE")).toBeNull();
	});

	it("loads the catalog on open", async () => {
		renderModal();
		await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
	});
});

describe("skill-library-modal — detail (mockup §6)", () => {
	it("selecting a user skill shows tag + lazy body preview clamped with a toggle", async () => {
		const { getByTestId, getByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));

		// Tag + description (scoped to the detail: the ML-9 row badge shows
		// the same source word in the master list now — was: bare getByText).
		expect(within(getByTestId("md-detail")).getByText("OWN")).toBeDefined();
		// Lazy content: one read for the opened detail.
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("my-style"));
		expect(readContentMock).toHaveBeenCalledTimes(1);
		expect(getByText("BODY_LABEL")).toBeDefined();
		const body = getByTestId("test-content-body");
		expect(body.getAttribute("class") ?? "").toContain("line-clamp-8");
		// Toggle expands ↔ collapses.
		fireEvent.click(getByTestId("test-preview-toggle"));
		expect(getByTestId("test-preview-toggle").textContent).toBe("COLLAPSE");
		expect(getByTestId("test-content-body").getAttribute("class") ?? "").not.toContain("line-clamp-8");
		fireEvent.click(getByTestId("test-preview-toggle"));
		expect(getByTestId("test-preview-toggle").textContent).toBe("SHOW_FULL");
		expect(getByTestId("test-content-body").getAttribute("class") ?? "").toContain("line-clamp-8");
	});

	it("a built-in skill shows the built-in tag and no delete in the footer", async () => {
		const { getByTestId, getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("Grill Me")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-grill-me"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("grill-me"));
		expect(within(getByTestId("md-detail")).getByText("BUILT_IN")).toBeDefined();
		expect(queryByText("DELETE")).toBeNull();
		// The shared footer still renders Close (scoped: the modal mock
		// itself also renders a close button outside the footer).
		expect(within(getByTestId("md-footer")).getByText("close")).toBeDefined();
	});

	it("a short body renders whole with no toggle", async () => {
		readContentMock.mockResolvedValue(contentFor("my-style", SHORT_BODY, []));
		const { getByTestId, getByText, queryByTestId, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(getByTestId("test-content-body")).toBeDefined());
		expect(getByTestId("test-content-body").getAttribute("class") ?? "").not.toContain("line-clamp-8");
		expect(queryByTestId("test-preview-toggle")).toBeNull();
	});

	it("loading is a quiet line, failure is silent (tech details stay metadata-only)", async () => {
		let resolveContent: (c: SkillContentDto) => void = () => {};
		readContentMock.mockReturnValue(new Promise<SkillContentDto>((resolve) => { resolveContent = resolve; }));
		const { getByTestId, getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(getByText("CONTENT_LOADING")).toBeDefined());

		// Failure: no preview, no crash; the tech disclosure still opens
		// from metadata (id visible, no file list without content).
		readContentMock.mockRejectedValue(new Error("boom"));
		fireEvent.pointerDown(getByTestId("test-row-grill-me"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("grill-me"));
		await waitFor(() => expect(queryByText("CONTENT_LOADING")).toBeNull());
		expect(queryByText("BODY_LABEL")).toBeNull();
		fireEvent.click(getByTestId("test-tech-toggle"));
		expect(getByText("grill-me")).toBeDefined();
		resolveContent(contentFor("x", "y"));
	});
});

describe("skill-library-modal — tech details disclosure", () => {
	it("collapsed by default; opens id, path, source, shadow note, file list", async () => {
		const { getByTestId, getByText, queryByText } = renderModal({
			...makeAdapter(),
			entries: [SHADOW_ENTRY],
		});
		await waitFor(() => expect(getByText("Grill Me Plus")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-grill-me-shadow"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("grill-me-shadow"));
		// Collapsed: metadata rows absent.
		expect(queryByText("grill-me-shadow")).toBeNull();
		fireEvent.click(getByTestId("test-tech-toggle"));
		expect(getByText("grill-me-shadow")).toBeDefined();
		expect(getByText("grill-me-shadow/SKILL.md")).toBeDefined();
		expect(getByText("references/notes.md")).toBeDefined();
		expect(getByText("SHADOW_NOTE")).toBeDefined();
	});
});

describe("skill-library-modal — footer + import dock (mockup §6)", () => {
	it("user skill selected → footer delete; confirm removes and closes the confirm", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalled());

		fireEvent.click(getByText("DELETE"));
		await waitFor(() => expect(queryByTestId("confirm-modal")).not.toBeNull());
		expect(getByTestId("confirm-body").textContent).toBe("DEL_BODY");
		fireEvent.click(getByTestId("confirm-ok"));
		await waitFor(() => expect(removeMock).toHaveBeenCalledWith("my-style"));
		await waitFor(() => expect(queryByTestId("confirm-modal")).toBeNull());
	});

	it("the reference guard names the bound modules in the confirm", async () => {
		findReferencingModulesMock.mockResolvedValue(["Card Module"]);
		const guarded = makeAdapter({
			referenceGuard: {
				findReferencingModules: findReferencingModulesMock,
				referencedBody: "REF_BODY",
				referencedHint: "REF_HINT",
			},
		});
		const { getByTestId, getByText } = renderModal(guarded);
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalled());
		fireEvent.click(getByText("DELETE"));
		await waitFor(() => expect(findReferencingModulesMock).toHaveBeenCalledWith("my-style"));
		// The mock being CALLED does not mean the confirm has RENDERED (the guard
		// promise resolves and mounts the confirm after the call) — wait for the
		// resolved state itself, like the sibling delete test waits for
		// confirm-modal (Linux-CI flake, PR #63 test-linux 2026-10-26).
		await waitFor(() => expect(getByText("Card Module")).toBeDefined());
	});

	it("import docks at the list bottom, out of headerActions", async () => {
		const { getByTestId, getByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		// Header slot is empty (import moved out of it)…
		expect(getByTestId("md-header-actions").textContent).toBe("");
		// …and the single import button lives in the master list.
		const docked = getByTestId("test-import-btn");
		expect(getByTestId("md-master").contains(docked)).toBe(true);
		fireEvent.change(getByTestId("test-folder-input"), { target: { files: [new File(["x"], "SKILL.md")] } });
		await waitFor(() => expect(importTreeMock).toHaveBeenCalledTimes(1));
	});
});

describe("skill-library-modal — empty library (mockup §7)", () => {
	it("shows the explanation + import CTA, no dock", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal(makeAdapter({ entries: [] }));
		await waitFor(() => expect(getByText("EMPTY_TITLE")).toBeDefined());
		expect(getByText("EMPTY_BODY")).toBeDefined();
		expect(getByText("IMPORT_CTA")).toBeDefined();
		expect(queryByTestId("test-import-btn")).toBeNull();
		// The CTA drives the same folder input.
		fireEvent.click(getByText("IMPORT_CTA"));
		fireEvent.change(getByTestId("test-folder-input"), { target: { files: [new File(["x"], "SKILL.md")] } });
		await waitFor(() => expect(importTreeMock).toHaveBeenCalledTimes(1));
	});
});

describe("skill-library-modal — parentBack", () => {
	it("forwards parentBack to MasterDetailModal; absent stays absent", async () => {
		const onBack = mock();
		const first = renderModal(makeAdapter(), { label: "PARENT", onBack });
		await waitFor(() => expect(lastModalProps).not.toBeNull());
		expect(lastModalProps?.parentBack?.label).toBe("PARENT");
		first.unmount();

		lastModalProps = null;
		renderModal(makeAdapter());
		await waitFor(() => expect(lastModalProps).not.toBeNull());
		// (widened: the reset above narrows the union to `null`)
		expect((lastModalProps as ModalProps | null)?.parentBack).toBeUndefined();
	});
});

describe("skill-library-modal — editor entry points (AP-23d, mockup §8)", () => {
	it("«+ New skill» docks above the import; the blank editor shows Cancel/Save and no delete", async () => {
		const { getByTestId, getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		// Dock order: new ABOVE import (was: no creation entry point at all).
		const newBtn = getByTestId("test-new-btn");
		const importBtn = getByTestId("test-import-btn");
		expect(newBtn.compareDocumentPosition(importBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		fireEvent.click(newBtn);
		// Blank editor: three empty fields + the verbatim hint + edit footer.
		expect((getByTestId("test-editor-name") as HTMLInputElement).value).toBe("");
		expect((getByTestId("test-editor-when") as HTMLTextAreaElement).value).toBe("");
		expect((getByTestId("test-editor-body") as HTMLTextAreaElement).value).toBe("");
		expect(getByText("WHEN_HINT")).toBeDefined();
		expect(getByText("CANCEL")).toBeDefined();
		const saveBtn = getByText("SAVE").closest("button") as HTMLButtonElement | null;
		expect(queryByText("DELETE")).toBeNull();
		// Save blocks on a blank name (was: the view only offered inspect).
		expect(saveBtn?.disabled).toBe(true);
		fireEvent.change(getByTestId("test-editor-name"), { target: { value: "Fresh" } });
		expect(getByText("SAVE").closest("button")?.disabled).toBe(false);
	});

	it("view of a user skill offers Edit / Duplicate / Delete; built-in offers Duplicate only", async () => {
		const { getByTestId, getByText, queryByText } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("my-style"));
		// (was: the user footer carried delete only — no edit entry points.)
		expect(getByText("EDIT")).toBeDefined();
		expect(getByText("DUPLICATE")).toBeDefined();
		expect(getByText("DELETE")).toBeDefined();
		// Built-in (was: no footer actions at all — read-only with no copy path).
		fireEvent.pointerDown(getByTestId("test-row-grill-me"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("grill-me"));
		expect(queryByText("EDIT")).toBeNull();
		expect(getByText("DUPLICATE")).toBeDefined();
		expect(queryByText("DELETE")).toBeNull();
	});
});

describe("skill-library-modal — create (AP-23d)", () => {
	it("fills the blank editor and saves via create (null id), then views the new entry", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.click(getByTestId("test-new-btn"));
		fireEvent.change(getByTestId("test-editor-name"), { target: { value: "Fresh Skill" } });
		fireEvent.change(getByTestId("test-editor-when"), { target: { value: "When fresh." } });
		fireEvent.change(getByTestId("test-editor-body"), { target: { value: "Fresh body." } });
		fireEvent.click(getByText("SAVE"));
		// Create: null id — the folder id derives from the name server-side.
		await waitFor(() => expect(saveMock).toHaveBeenCalledWith(null, { name: "Fresh Skill", description: "When fresh.", body: "Fresh body." }));
		// Success returns to the VIEW of the saved skill (the fake catalog
		// refreshes in place, like the stores do on save).
		await waitFor(() => expect(queryByTestId("test-editor-name")).toBeNull());
		// The name renders twice (master row + detail title) — pin the detail.
		expect(within(getByTestId("md-detail")).getByText("Fresh Skill")).toBeDefined();
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("fresh-skill"));
	});
});

describe("skill-library-modal — edit (AP-23d)", () => {
	it("edits a user skill prefilled from the view and saves via update", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("my-style"));
		fireEvent.click(getByText("EDIT"));
		// Prefilled from the entry + the lazy AP-21 body.
		expect((getByTestId("test-editor-name") as HTMLInputElement).value).toBe("My Style");
		expect((getByTestId("test-editor-when") as HTMLTextAreaElement).value).toBe("Naming and comments");
		await waitFor(() => expect((getByTestId("test-editor-body") as HTMLTextAreaElement).value).toContain("Variables are camelCase"));
		fireEvent.change(getByTestId("test-editor-body"), { target: { value: "Edited body." } });
		fireEvent.click(getByText("SAVE"));
		await waitFor(() => expect(saveMock).toHaveBeenCalledWith("my-style", { name: "My Style", description: "Naming and comments", body: "Edited body." }));
		await waitFor(() => expect(queryByTestId("test-editor-name")).toBeNull());
	});
});

describe("skill-library-modal — duplicate built-in (AP-23d)", () => {
	it("prefills «{name} (копия)» + the built-in body and saves via create", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("Grill Me")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-grill-me"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("grill-me"));
		fireEvent.click(getByText("DUPLICATE"));
		// The copy name (the raw COPY_NAME key under the identity mock —
		// the real `tDynamic` interpolates `{name}`) + the built-in body.
		expect((getByTestId("test-editor-name") as HTMLInputElement).value).toBe("COPY_NAME");
		await waitFor(() => expect((getByTestId("test-editor-body") as HTMLTextAreaElement).value).toContain("Variables are camelCase"));
		fireEvent.click(getByText("SAVE"));
		// Duplicate saves AS NEW (null id), never an update of the built-in.
		await waitFor(() => expect(saveMock).toHaveBeenCalledWith(null, { name: "COPY_NAME", description: "Design interview before building.", body: expect.anything() }));
		await waitFor(() => expect(queryByTestId("test-editor-name")).toBeNull());
	});
});

describe("skill-library-modal — AI assist (AP-23d)", () => {
	it("replaces or inserts into the body like LoreEntryEditor", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.click(getByTestId("test-new-btn"));
		// The AI modal stays closed until the compact button asks.
		expect(queryByTestId("ai-modal")).toBeNull();
		fireEvent.click(getByTestId("test-ai-btn"));
		await waitFor(() => expect(getByTestId("ai-modal")).toBeDefined());
		// Replace swaps the body…
		fireEvent.click(getByTestId("ai-replace"));
		expect((getByTestId("test-editor-body") as HTMLTextAreaElement).value).toBe("Generated text.");
		// …insert appends after a blank line.
		fireEvent.click(getByTestId("ai-insert"));
		expect((getByTestId("test-editor-body") as HTMLTextAreaElement).value).toBe("Generated text.\n\nMore.");
	});
});

describe("skill-library-modal — dirty guard (AP-23d)", () => {
	it("Cancel with dirty edits asks; backing out keeps the draft, confirming discards", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.click(getByTestId("test-new-btn"));
		fireEvent.change(getByTestId("test-editor-name"), { target: { value: "Typed" } });
		fireEvent.click(getByText("CANCEL"));
		// (was: no guard existed — a dirty close discarded silently.)
		await waitFor(() => expect(getByTestId("confirm-close")).toBeDefined());
		fireEvent.click(getByTestId("confirm-close-cancel"));
		await waitFor(() => expect(queryByTestId("confirm-close")).toBeNull());
		expect((getByTestId("test-editor-name") as HTMLInputElement).value).toBe("Typed");
		fireEvent.click(getByText("CANCEL"));
		await waitFor(() => expect(getByTestId("confirm-close")).toBeDefined());
		fireEvent.click(getByTestId("confirm-close-ok"));
		await waitFor(() => expect(queryByTestId("test-editor-name")).toBeNull());
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("a clean Cancel and a clean modal close exit without asking", async () => {
		const onClose = mock();
		const { getByTestId, getByText, queryByTestId } = renderModal(undefined, undefined, onClose);
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.click(getByTestId("test-new-btn"));
		fireEvent.click(getByText("CANCEL"));
		expect(queryByTestId("confirm-close")).toBeNull();
		expect(queryByTestId("test-editor-name")).toBeNull();
		// Reopen, still clean, close via the modal X.
		fireEvent.click(getByTestId("test-new-btn"));
		fireEvent.click(getByTestId("md-close"));
		expect(queryByTestId("confirm-close")).toBeNull();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("a dirty modal close asks; confirming closes the modal", async () => {
		const onClose = mock();
		const { getByTestId, getByText, queryByTestId } = renderModal(undefined, undefined, onClose);
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.click(getByTestId("test-new-btn"));
		fireEvent.change(getByTestId("test-editor-body"), { target: { value: "Dirty body." } });
		fireEvent.click(getByTestId("md-close"));
		await waitFor(() => expect(getByTestId("confirm-close")).toBeDefined());
		fireEvent.click(getByTestId("confirm-close-ok"));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("selecting another row with dirty edits asks; confirming switches", async () => {
		const { getByTestId, getByText, queryByTestId } = renderModal();
		await waitFor(() => expect(getByText("My Style")).toBeDefined());
		fireEvent.pointerDown(getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("my-style"));
		fireEvent.click(getByText("EDIT"));
		fireEvent.change(getByTestId("test-editor-name"), { target: { value: "Renamed" } });
		fireEvent.pointerDown(getByTestId("test-row-grill-me"));
		await waitFor(() => expect(getByTestId("confirm-close")).toBeDefined());
		fireEvent.click(getByTestId("confirm-close-ok"));
		await waitFor(() => expect(queryByTestId("test-editor-name")).toBeNull());
		expect(within(getByTestId("md-detail")).getByText("BUILT_IN")).toBeDefined();
	});
});

describe("skill-library-modal — drag reorder (ML-9)", () => {
	// The ProxyManagerModal.reorder.test.tsx pattern: the captured-handler
	// drag-end boundary, the arrayMove payload asserted, the optimistic DOM,
	// the reload proof (unmount + fresh mount reads the server order), and
	// the rejected-persist rollback. Built-in and user skills order together
	// in the one list; no pinned rows (every stored skill keeps a position).
	function rowOrder(view: ReturnType<typeof render>): string[] {
		return Array.from(view.baseElement.querySelectorAll('[data-testid^="test-row-"]'))
			.map((el) => el.getAttribute("data-testid")!);
	}

	function dragEnd(activeId: string, overId: string): void {
		expect(dndHandlers).toBeTruthy();
		const endEvent = { active: { id: activeId }, over: { id: overId } } as unknown as Parameters<
			NonNullable<RealDndContextProps["onDragEnd"]>
		>[0];
		act(() => {
			dndHandlers!.onDragEnd!(endEvent);
		});
	}

	async function openAndFlushRows() {
		const view = renderModal();
		await waitFor(() => expect(view.getByTestId("test-row-my-style")).toBeDefined());
		return view;
	}

	it("built-in and user skills share one list with a handle per row, wrap titles, and status-slot badges", async () => {
		const view = await openAndFlushRows();
		// One list in stored order: built-in first, user second.
		expect(rowOrder(view)).toEqual(["test-row-grill-me", "test-row-my-style"]);
		// A handle per row — no pinned rows here (nothing is pinned by design).
		expect(view.getAllByLabelText("drag")).toHaveLength(2);
		// Per-row badges in the status slot (was: no badge in the rows — the
		// source tag lived in the detail only).
		expect(within(view.getByTestId("test-row-grill-me")).getByText("BUILT_IN")).toBeDefined();
		expect(within(view.getByTestId("test-row-my-style")).getByText("OWN")).toBeDefined();
		// Titles wrap (was: truncate): no ellipsis anywhere up the row chain.
		for (const [rowId, name] of [["test-row-grill-me", "Grill Me"], ["test-row-my-style", "My Style"]] as const) {
			const title = within(view.getByTestId(rowId)).getByText(name);
			expect(title.classList.contains("truncate")).toBe(false);
			expect(title.classList.contains("break-words")).toBe(true);
		}
		// Selecting marks the row by background + accent border (was:
		// border-l-2 without the accent text).
		fireEvent.pointerDown(view.getByTestId("test-row-my-style"));
		await waitFor(() => expect(view.getByTestId("test-row-my-style").classList.contains("bg-accent-dim")).toBe(true));
		expect(view.getByTestId("test-row-my-style").classList.contains("border-l-accent")).toBe(true);
		expect(view.getByTestId("test-row-my-style").classList.contains("text-accent-t")).toBe(true);
		view.unmount();
	});

	it("dragging a skill persists the arrayMove payload and the order survives a remount", async () => {
		const view = await openAndFlushRows();
		expect(rowOrder(view)).toEqual(["test-row-grill-me", "test-row-my-style"]);

		dragEnd("grill-me", "my-style");
		await act(async () => {});
		expect(reorderMock).toHaveBeenCalledTimes(1);
		expect(reorderMock.mock.calls[0]?.[0]).toEqual([
			{ id: "my-style", sortOrder: 0 },
			{ id: "grill-me", sortOrder: 1 },
		]);
		// Optimistic order shows immediately (the fake reorder re-syncs the
		// entries the modal reads — the store-adopts-response pattern).
		expect(rowOrder(view)).toEqual(["test-row-my-style", "test-row-grill-me"]);
		view.unmount();

		// Reload: a fresh mount lists the server-persisted order.
		const reloaded = await openAndFlushRows();
		expect(rowOrder(reloaded)).toEqual(["test-row-my-style", "test-row-grill-me"]);
		reloaded.unmount();
	});

	it("a rejected persist rolls back to the committed order", async () => {
		reorderMock.mockImplementationOnce(async () => { throw new Error("nope"); });
		const view = await openAndFlushRows();

		dragEnd("grill-me", "my-style");
		await waitFor(() => expect(reorderMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(rowOrder(view)).toEqual(["test-row-grill-me", "test-row-my-style"]));
		view.unmount();
	});

	it("tapping a row selects it and opens the detail (drag starts from the handle only)", async () => {
		const view = await openAndFlushRows();
		fireEvent.pointerDown(view.getByTestId("test-row-my-style"));
		await waitFor(() => expect(readContentMock).toHaveBeenCalledWith("my-style"));
		expect(within(view.getByTestId("md-detail")).getByText("OWN")).toBeDefined();
		view.unmount();
	});
});
