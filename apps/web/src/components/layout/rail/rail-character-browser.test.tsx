/**
 * RP rail drawer tests (RAIL_DRILL_IN RD-3).
 *
 * Renders the real `<Rail />` (the host that mounts the drawer) with real
 * stores; only the boundaries are doubled: `useT` (keys verbatim; a `count`
 * option is appended as `key#count` so the plural-key call is observable), the
 * Radix tooltip provider, the two controllers (spies for the actions the rail
 * triggers), the two branch actions that hit the API, and the two mobile
 * import orchestrators (spies for `openPicker`). The drawer, the panel and the
 * sheets run real (Base UI mounts under happy-dom).
 *
 * Written in two passes. The first describe was CHARACTERIZED against the
 * inline rail that existed before the drill-in (character rows with ⋮, the
 * selected character's chats below the row, a «New chat» row) and passed
 * unchanged on that code; its assertions are about EFFECTS — modal flag,
 * picker call, list contents, the controller call, whether the drawer stays
 * open — so they hold across the move. Only the locator helpers changed when
 * controls moved: the character ⋮ went from the row to the screen-2 header,
 * «New chat» from a row under the chats to the header «+», branches are open
 * by default (RD-2). The remaining describes are the drill-in itself.
 *
 * Happy-dom never completes Base UI's exit transition, so a closed drawer
 * stays mounted — which exercises the «every open» rule through the same
 * instance (`open` false→true) the quick-reopen case has in the browser.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { brandId, type ChatBranch, type ChatBranchId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import { normalizeAutoSummaryConfig, normalizeInsightsConfig, normalizeObjectiveState } from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../../api/types.js";
import type { CharacterImportMobileHandle } from "../../modals/import/CharacterImportMobile.js";
import type { ChatImportMobileHandle } from "../../modals/import/ChatImportMobile.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { wireCharacter, wireUiSettings } from "../../../../test/wire-fixtures.js";
import { i18next } from "../../../i18n/i18n.js";
import en from "../../../i18n/locales/en.json";
import ru from "../../../i18n/locales/ru.json";
import { formatRelativeTime } from "../sidebar-utils.js";

useDomEnv({ failOnNetwork: true });

const { act, fireEvent, render } = await import("@testing-library/react");

// ── Doubles ──────────────────────────────────────────────────────────────

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (key: string, opts?: { count?: number }) => (typeof opts?.count === "number" ? `${key}#${opts.count}` : key),
		tDynamic: (key: string) => key,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const activateBranchAction = mock(async (_chatId: ChatId, _branchId: ChatBranchId): Promise<void> => {});
const renameBranchAction = mock(async (_chatId: ChatId, _branchId: ChatBranchId, _label: string): Promise<void> => {});
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
mock.module("../../../stores/api-actions/chat-actions.js", () => ({
	...realChatActions,
	activateBranchAction,
	renameBranchAction,
}));

const renameChatSpy = mock(async (_chatId: ChatId, _title: string): Promise<void> => {});
const exportChatSpy = mock(async (_chatId: ChatId): Promise<void> => {});
const switchChatSpy = mock(async (_chatId: ChatId): Promise<void> => {});
const createChatSpy = mock(async (_characterId?: string): Promise<void> => {});
const exportCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const duplicateCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const deleteCharacterSpy = mock(async (_characterId: string): Promise<void> => {});
const NOOP_ASYNC = async () => {};

const CHAT_STUB = {
	handleSwitchChat: switchChatSpy,
	handleFork: mock(async (_messageId?: string): Promise<void> => {}),
	handleDeleteActiveBranch: mock(async (): Promise<void> => {}),
};
const CHARACTER_STUB = {
	handleCreateChat: createChatSpy,
	handleExportCharacter: exportCharacterSpy,
	handleDuplicateCharacter: duplicateCharacterSpy,
	handleDeleteCharacter: deleteCharacterSpy,
	handleExportChatJsonl: exportChatSpy,
	handleRemoveChat: NOOP_ASYNC,
	handleRenameChat: renameChatSpy,
	handleImportFiles: NOOP_ASYNC,
	getChatRemovalMode: () => "delete" as const,
	isImporting: false,
};

const realChatController = await import("../../../hooks/use-chat-controller.js");
mock.module("../../../hooks/use-chat-controller.js", () => ({
	...realChatController,
	useChatController: () => CHAT_STUB,
}));
const realCharacterController = await import("../../../hooks/use-character-controller.js");
mock.module("../../../hooks/use-character-controller.js", () => ({
	...realCharacterController,
	useCharacterController: () => CHARACTER_STUB,
}));

// The orchestrators are always-mounted children the rail drives through a ref;
// the double keeps the ref contract (`openPicker`) and renders nothing.
const openCharacterPicker = mock((): void => {});
const openChatPicker = mock((): void => {});
const realCharacterImport = await import("../../modals/import/CharacterImportMobile.js");
mock.module("../../modals/import/CharacterImportMobile.js", () => ({
	...realCharacterImport,
	CharacterImportMobile: forwardRef<CharacterImportMobileHandle, object>(function CharacterImportDouble(_props, ref) {
		useImperativeHandle(ref, () => ({ openPicker: openCharacterPicker }));
		return null;
	}),
}));
const realChatImport = await import("../../modals/import/ChatImportMobile.js");
mock.module("../../modals/import/ChatImportMobile.js", () => ({
	...realChatImport,
	ChatImportMobile: forwardRef<ChatImportMobileHandle, object>(function ChatImportDouble(_props, ref) {
		useImperativeHandle(ref, () => ({ openPicker: openChatPicker }));
		return null;
	}),
}));

const { Rail } = await import("../Rail.js");
const { useBootstrapStore } = await import("../../../stores/api-actions/bootstrap-actions.js");
const { useChatStore, useModalStore, useNavigationStore } = await import("../../../stores/index.js");
const { useCharacterStore } = await import("../../../stores/character-store.js");
const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const ARIA = "char-aria";
const BRAM = "char-bram";
const CORA = "char-cora";
const CHAT_A1 = brandId<ChatId>("chat-a1");
const CHAT_A2 = brandId<ChatId>("chat-a2");
const CHAT_B1 = brandId<ChatId>("chat-b1");
const CHAT_B2 = brandId<ChatId>("chat-b2");
const CHAT_C1 = brandId<ChatId>("chat-c1");
const BR_ROOT = brandId<ChatBranchId>("br-root");
const BR_ALT = brandId<ChatBranchId>("br-alt");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function makeEntry(id: string, name: string, tags: string[]): AppCharacterEntry {
	return {
		id,
		name,
		subtitle: "",
		tags,
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

function makeChat(id: ChatId, characterId: string, title: string, over: Partial<ChatListItem> = {}): ChatListItem {
	const stamp = over.updatedAt ?? ago(DAY);
	return {
		id,
		title,
		characterId: brandId<CharacterId>(characterId),
		characterName: "",
		subtitle: `${title} subtitle`,
		activeBranchLabel: "",
		mode: "rp",
		messageCount: 4,
		lastMessageAt: stamp,
		updatedAt: stamp,
		...over,
	};
}

function makeBranch(id: ChatBranchId, label: string, parentBranchId: ChatBranchId | null): ChatBranch {
	return { id, chatId: CHAT_A1, parentBranchId, forkedFromMessageId: null, label, createdAt: "2026-01-01T00:00:00Z" } as ChatBranch;
}

const CHARACTERS = [makeEntry(ARIA, "Aria", ["fantasy"]), makeEntry(BRAM, "Bram", ["scifi"]), makeEntry(CORA, "Cora", ["fantasy", "scifi"])];

/**
 * Aria: two RP chats (newest 5 min ago); Bram: one RP chat (1 min ago) plus a
 * newer co-author chat that play mode must not count; Cora: only a co-author chat.
 */
function chatRows(): ChatListItem[] {
	return [
		makeChat(CHAT_A1, ARIA, "Moonlit Harbor", { updatedAt: ago(5 * MIN), messageCount: 12 }),
		makeChat(CHAT_A2, ARIA, "Winter Market", { updatedAt: ago(2 * DAY), activeBranchLabel: "Alt timeline" }),
		makeChat(CHAT_B1, BRAM, "Station Nine", { updatedAt: ago(MIN) }),
		makeChat(CHAT_B2, BRAM, "Station Lore", { mode: "coauthor", updatedAt: ago(10_000) }),
		makeChat(CHAT_C1, CORA, "Lore Notes", { mode: "coauthor" }),
	];
}

function seedStores(opts: { activeChatId?: ChatId | null; selectedCharacterId?: string | null } = {}): void {
	const activeChatId = opts.activeChatId === undefined ? CHAT_A1 : opts.activeChatId;
	const chats = chatRows();
	useNavigationStore.setState({ mode: "play", characterSortMode: "recent", chatSortMode: "recent", railForceOpen: 0 });
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: false,
			allCharacters: CHARACTERS,
			promptPresets: [],
			uiSettings: wireUiSettings(),
			agentKindSettings: {},
			isArmServer: false,
		},
	});
	useChatStore.setState({ activeChatId, selectedCharacterId: opts.selectedCharacterId ?? null });
	useModalStore.setState({ isCreateCharacterModalOpen: false });
	useCharacterStore.setState({ confirmDestroy: null });
	if (activeChatId === null) {
		useSnapshotStore.setState({ character: null, activeChat: null, activeBranch: null, branches: [], chatIds: [], chatsById: {} });
		return;
	}
	const active = chats.find((c) => c.id === activeChatId);
	if (!active) throw new Error(`no seeded chat ${activeChatId}`);
	const root = makeBranch(BR_ROOT, active.title, null);
	useSnapshotStore.setState({
		character: { ...wireCharacter(), id: active.characterId, name: CHARACTERS.find((c) => c.id === active.characterId)?.name ?? "" },
		persona: null,
		allCharacters: CHARACTERS,
		chatIds: chats.map((c) => c.id),
		chatsById: Object.fromEntries(chats.map((c) => [c.id, c])),
		activeChat: {
			id: active.id,
			characterId: active.characterId,
			personaId: null,
			title: active.title,
			status: "active",
			mode: active.mode,
			activeBranchId: BR_ROOT,
			promptPresetId: null,
			selectedGreetingIndex: 0,
			coauthorContextLinks: [],
			coauthorModuleId: null,
			dynamicPrompt: "",
			createdAt: "2026-10-01T00:00:00.000Z",
			updatedAt: "2026-10-01T00:00:00.000Z",
			summary: "",
			messageHistoryLimit: 0,
			autoSummaryConfig: normalizeAutoSummaryConfig(undefined),
			insightsConfig: normalizeInsightsConfig(undefined),
			insightsObjectiveState: normalizeObjectiveState(undefined),
		},
		activeBranch: root,
		branches: [root, makeBranch(BR_ALT, "Side thread", BR_ROOT)],
	});
}

beforeEach(() => {
	for (const spy of [switchChatSpy, createChatSpy, exportCharacterSpy, duplicateCharacterSpy, deleteCharacterSpy, openCharacterPicker, openChatPicker, renameChatSpy, exportChatSpy, activateBranchAction, renameBranchAction]) spy.mockClear();
	seedStores();
});

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Render the rail and open its drawer the way the TopBar hamburger does. */
function openRail(opts: Parameters<typeof seedStores>[0] = {}): View {
	seedStores(opts);
	const view = render(<Rail />);
	openDrawer();
	return view;
}

function openDrawer(): void {
	act(() => {
		useNavigationStore.setState({ railForceOpen: useNavigationStore.getState().railForceOpen + 1 });
	});
}

/** The expanded drawer panel (the collapsed strip lives outside it). */
function drawer(view: View): HTMLElement {
	const popup = view.baseElement.querySelector<HTMLElement>(".rail-popup");
	if (!popup) throw new Error("the rail drawer is not mounted");
	return popup;
}

/** Whether the drawer is open (Base UI drops data-open from a closing popup). */
function drawerIsOpen(view: View): boolean {
	return drawer(view).hasAttribute("data-open");
}

function textOf(el: Element | null | undefined): string {
	return el?.textContent ?? "";
}

function inDrawer<T extends HTMLElement>(view: View, selector: string): T {
	const el = drawer(view).querySelector<T>(selector);
	if (!el) throw new Error(`nothing in the drawer matches ${selector}`);
	return el;
}

// ── Locators: the only part that moves with the drawer's markup ──────────

const CHARACTER_NAMES = CHARACTERS.map((c) => c.name);

/** The drawer's heading (Drawer.Title): the screen-1 title or the character's name. */
function screenTitle(view: View): string {
	return textOf(drawer(view).querySelector("h2"));
}

/** Screen 2 is showing when the header has its back arrow. */
function onCharacterScreen(view: View): boolean {
	return drawer(view).querySelector('button[aria-label="back"]') !== null;
}

function backButton(view: View): HTMLButtonElement {
	return inDrawer<HTMLButtonElement>(view, 'button[aria-label="back"]');
}

/** Screen 1 — go back from a character's screen if that is where the drawer opened. */
function showCharacterList(view: View): void {
	if (onCharacterScreen(view)) fireEvent.click(backButton(view));
}

/** Render, open, and make sure the character list (screen 1) is showing. */
function openRailOnList(opts: Parameters<typeof seedStores>[0] = {}): View {
	const view = openRail(opts);
	showCharacterList(view);
	return view;
}

/** Character names listed on screen 1, in document order. */
function listedCharacters(view: View): string[] {
	const root = drawer(view);
	const hits: { name: string; el: Element }[] = [];
	for (const name of CHARACTER_NAMES) {
		for (const el of root.querySelectorAll("span")) {
			if (el.childElementCount === 0 && el.textContent === name) hits.push({ name, el });
		}
	}
	hits.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
	return hits.map((h) => h.name);
}

/** The character row (tap target) for `name` on screen 1. */
function characterRow(view: View, name: string): HTMLElement {
	const label = [...drawer(view).querySelectorAll("span")].find((el) => el.childElementCount === 0 && el.textContent === name);
	const row = label?.closest<HTMLElement>("button");
	if (!row) throw new Error(`no character row for "${name}"`);
	return row;
}

/** Line 2 of a character row: «N chats · when» / «No chats». */
function rowSummary(view: View, name: string): string {
	return textOf(characterRow(view, name).querySelector("span.leading-snug"));
}

/** Open a character's screen from the list (going back first if another character's screen is showing). */
function openCharacter(view: View, name: string): void {
	showCharacterList(view);
	fireEvent.click(characterRow(view, name));
}

const createControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="create_manual"]');
const importControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="import_char_short"]');
/** Screen-2 header: «+» new chat for this character. */
const newChatControl = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="new_chat"]');
/** Screen-2 header: the character's ⋮ menu. */
const characterMenuButton = (view: View) => inDrawer<HTMLButtonElement>(view, 'button[aria-label="sidebar_character_actions"]');
/** The hamburger — the first tap target of screen 1's header. */
const hamburger = (view: View) => inDrawer<HTMLElement>(view, "div.cursor-pointer");

function searchBox(view: View): HTMLInputElement {
	return view.getByPlaceholderText("search_name_placeholder") as HTMLInputElement;
}

/** A chat row (the panel's `.group` card) by title. */
function chatRowByTitle(view: View, title: string): HTMLElement {
	const row = [...drawer(view).querySelectorAll<HTMLElement>("div.group")].find((el) => el.querySelector("span.truncate")?.textContent === title);
	if (!row) throw new Error(`no chat row for "${title}"`);
	return row;
}

function chatRowTitles(view: View): string[] {
	return [...drawer(view).querySelectorAll<HTMLElement>("div.group")].map((row) => textOf(row.querySelector("span.truncate")));
}

/** The chat ⋮ button — the row's last button (a branch badge may precede it). */
function chatMenuButton(view: View, title: string): HTMLButtonElement {
	const buttons = chatRowByTitle(view, title).querySelectorAll<HTMLButtonElement>("button");
	const btn = buttons[buttons.length - 1];
	if (!btn) throw new Error(`no menu button on chat "${title}"`);
	return btn;
}

/** A branch row by its label (the branches block is open by default). */
function branchRowByLabel(view: View, label: string): HTMLElement {
	const rows = drawer(view).querySelectorAll<HTMLElement>("div.border-dashed div.cursor-pointer");
	const row = [...rows].find((el) => el.querySelector("span.truncate")?.textContent === label);
	if (!row) throw new Error(`no branch row for "${label}"`);
	return row;
}

function branchMenuButton(view: View, label: string): HTMLButtonElement {
	const btn = branchRowByLabel(view, label).querySelector<HTMLButtonElement>("button");
	if (!btn) throw new Error(`no menu button on branch "${label}"`);
	return btn;
}

/** The inline rename input currently showing `value`. */
function renameInput(view: View, value: string): HTMLInputElement {
	const input = [...drawer(view).querySelectorAll<HTMLInputElement>("input")].find((i) => i.value === value);
	if (!input) throw new Error(`no rename input showing "${value}"`);
	return input;
}

// ── Characterization: every action reachable before the drill-in stays reachable ──

describe("Rail drawer — the actions reachable before the drill-in", () => {
	it("create opens the create-character modal and closes the drawer", () => {
		const view = openRailOnList();
		expect(drawerIsOpen(view)).toBe(true);
		fireEvent.click(createControl(view));
		expect(useModalStore.getState().isCreateCharacterModalOpen).toBe(true);
		expect(drawerIsOpen(view)).toBe(false);
	});

	it("import opens the character file picker and closes the drawer", () => {
		const view = openRailOnList();
		fireEvent.click(importControl(view));
		expect(openCharacterPicker).toHaveBeenCalledTimes(1);
		expect(drawerIsOpen(view)).toBe(false);
	});

	it("lists every character, most recently active first (co-author chats do not count in play mode)", () => {
		const view = openRailOnList();
		expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
	});

	it("sort toggle switches the list to alphabetical", () => {
		const view = openRailOnList();
		fireEvent.click(view.getByLabelText("sort_toggle: sort_recent"));
		expect(useNavigationStore.getState().characterSortMode).toBe("alphabetical");
		expect(listedCharacters(view)).toEqual(["Aria", "Bram", "Cora"]);
	});

	it("search narrows the list by name; no match shows the empty text; clearing restores it", () => {
		const view = openRailOnList();
		fireEvent.change(searchBox(view), { target: { value: "ar" } });
		expect(listedCharacters(view)).toEqual(["Aria"]);
		fireEvent.change(searchBox(view), { target: { value: "zzz" } });
		expect(listedCharacters(view)).toEqual([]);
		expect(view.getByText("search_no_results")).toBeTruthy();
		fireEvent.change(searchBox(view), { target: { value: "" } });
		expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
	});

	it("tag filter: the sheet lists every tag, picking narrows the list (AND), the badge counts, reset restores", () => {
		const view = openRailOnList();
		fireEvent.click(view.getByLabelText("filter_by_tags"));
		expect(view.getByText("fantasy")).toBeTruthy();
		expect(view.getByText("scifi")).toBeTruthy();
		fireEvent.click(view.getByText("fantasy"));
		expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);
		fireEvent.click(view.getByText("scifi"));
		expect(listedCharacters(view)).toEqual(["Cora"]);
		const filterButton = view.getByLabelText("filter_by_tags");
		expect(textOf(filterButton.parentElement)).toContain("2");
		fireEvent.click(view.getByText("reset"));
		expect(listedCharacters(view)).toEqual(["Bram", "Aria", "Cora"]);
	});

	it("the character menu lists export, duplicate, import chat and delete, and export runs for that character", () => {
		const view = openRailOnList();
		openCharacter(view, "Bram");
		fireEvent.click(characterMenuButton(view));
		for (const label of ["sidebar_export", "duplicate", "sidebar_import_chat", "delete"]) expect(view.getByText(label)).toBeTruthy();

		fireEvent.click(view.getByText("sidebar_export"));
		expect(exportCharacterSpy).toHaveBeenCalledWith(BRAM);
	});

	it("character menu: duplicate, import chat and delete (confirm) are wired", () => {
		const view = openRailOnList();
		openCharacter(view, "Bram");
		fireEvent.click(characterMenuButton(view));
		fireEvent.click(view.getByText("duplicate"));
		expect(duplicateCharacterSpy).toHaveBeenCalledWith(BRAM);

		fireEvent.click(characterMenuButton(view));
		fireEvent.click(view.getByText("sidebar_import_chat"));
		expect(openChatPicker).toHaveBeenCalledTimes(1);

		fireEvent.click(characterMenuButton(view));
		fireEvent.click(view.getByText("delete"));
		const dialog = useCharacterStore.getState().confirmDestroy;
		expect(dialog?.title).toBe("sidebar_delete_character");
		dialog?.onConfirm();
		expect(deleteCharacterSpy).toHaveBeenCalledWith(BRAM);
	});

	it("new chat creates a chat for the character it belongs to and leaves the drawer open", () => {
		const view = openRailOnList();
		openCharacter(view, "Bram");
		expect(useChatStore.getState().selectedCharacterId).toBe(BRAM);
		fireEvent.click(newChatControl(view));
		expect(createChatSpy).toHaveBeenCalledTimes(1);
		expect(createChatSpy).toHaveBeenCalledWith(BRAM);
		expect(drawerIsOpen(view)).toBe(true);
	});

	it("tapping a chat switches to it and leaves the drawer open", () => {
		const view = openRailOnList();
		openCharacter(view, "Aria");
		fireEvent.click(chatRowByTitle(view, "Winter Market"));
		expect(switchChatSpy).toHaveBeenCalledWith(CHAT_A2);
		expect(drawerIsOpen(view)).toBe(true);
	});

	it("the chat menu offers rename, export and delete; rename commits on Enter, export and delete run for that chat", () => {
		const view = openRailOnList();
		openCharacter(view, "Aria");
		fireEvent.click(chatMenuButton(view, "Winter Market"));
		for (const label of ["sidebar_rename", "sidebar_export_jsonl", "delete"]) expect(view.getByText(label)).toBeTruthy();

		fireEvent.click(view.getByText("sidebar_rename"));
		fireEvent.change(renameInput(view, "Winter Market"), { target: { value: "Spring Fair" } });
		fireEvent.keyDown(renameInput(view, "Spring Fair"), { key: "Enter" });
		expect(renameChatSpy).toHaveBeenCalledWith(CHAT_A2, "Spring Fair");

		fireEvent.click(chatMenuButton(view, "Winter Market"));
		fireEvent.click(view.getByText("sidebar_export_jsonl"));
		expect(exportChatSpy).toHaveBeenCalledWith(CHAT_A2);

		fireEvent.click(chatMenuButton(view, "Winter Market"));
		fireEvent.click(view.getByText("delete"));
		expect(useCharacterStore.getState().confirmDestroy?.title).toBe("sidebar_delete_chat");
	});

	it("the active chat's branches: tapping one activates it, its menu renames it; the drawer stays open", () => {
		const view = openRail();
		fireEvent.click(branchRowByLabel(view, "Side thread"));
		expect(activateBranchAction).toHaveBeenCalledWith(CHAT_A1, BR_ALT);
		expect(drawerIsOpen(view)).toBe(true);

		fireEvent.click(branchMenuButton(view, "Side thread"));
		fireEvent.click(view.getByText("sidebar_rename"));
		fireEvent.change(renameInput(view, "Side thread"), { target: { value: "Renamed" } });
		fireEvent.keyDown(renameInput(view, "Renamed"), { key: "Enter" });
		expect(renameBranchAction).toHaveBeenCalledWith(CHAT_A1, BR_ALT, "Renamed");
	});

	it("an inactive chat shows its active-branch line", () => {
		const view = openRail();
		expect(textOf(chatRowByTitle(view, "Winter Market"))).toContain("Alt timeline");
	});

	it("the branches block's actions are wired: «Branch» forks, «Delete» on the root branch explains instead of confirming", () => {
		const view = openRail();
		fireEvent.click(view.getByText("sidebar_fork_short"));
		expect(CHAT_STUB.handleFork).toHaveBeenCalledTimes(1);
		fireEvent.click(view.getByText("sidebar_delete_branch_short"));
		expect(useCharacterStore.getState().confirmDestroy).toBeNull();
	});
});

// ── The drill-in ─────────────────────────────────────────────────────────

describe("Rail drawer — opens on the active chat's character", () => {
	it("with an active chat the drawer opens on that character's screen", () => {
		const view = openRail();
		expect(onCharacterScreen(view)).toBe(true);
		expect(screenTitle(view)).toBe("Aria");
		expect(chatRowTitles(view)).toEqual(["Moonlit Harbor", "Winter Market"]);
	});

	it("opens on the ACTIVE CHAT's character, not the last selected one", () => {
		const view = openRail({ activeChatId: CHAT_A1, selectedCharacterId: BRAM });
		expect(screenTitle(view)).toBe("Aria");
	});

	it("without an active chat the drawer opens on the character list", () => {
		const view = openRail({ activeChatId: null });
		expect(onCharacterScreen(view)).toBe(false);
		expect(screenTitle(view)).toBe("characters");
		expect(listedCharacters(view)).toEqual(["Aria", "Bram", "Cora"]);
	});

	it("the rule re-applies on every open: back, close, reopen lands on the active character again", () => {
		const view = openRail();
		fireEvent.click(backButton(view));
		expect(onCharacterScreen(view)).toBe(false);
		fireEvent.click(hamburger(view));
		expect(drawerIsOpen(view)).toBe(false);
		openDrawer();
		expect(drawerIsOpen(view)).toBe(true);
		expect(screenTitle(view)).toBe("Aria");
	});

	it("a different active chat while the drawer was closed: the next open lands on its character", () => {
		const view = openRail();
		fireEvent.click(backButton(view));
		fireEvent.click(hamburger(view));
		act(() => { seedStores({ activeChatId: CHAT_B1 }); });
		openDrawer();
		expect(screenTitle(view)).toBe("Bram");
	});
});

describe("Rail drawer — drilling in and out", () => {
	it("tapping a character opens its screen and selects it; the other characters' chats are not listed", () => {
		const view = openRailOnList();
		fireEvent.click(characterRow(view, "Bram"));
		expect(onCharacterScreen(view)).toBe(true);
		expect(screenTitle(view)).toBe("Bram");
		expect(useChatStore.getState().selectedCharacterId).toBe(BRAM);
		expect(chatRowTitles(view)).toEqual(["Station Nine"]);
	});

	it("back returns to the list with the search query, tag filter and sort kept", () => {
		const view = openRailOnList();
		fireEvent.click(view.getByLabelText("sort_toggle: sort_recent"));
		fireEvent.click(view.getByLabelText("filter_by_tags"));
		fireEvent.click(view.getByText("fantasy"));
		fireEvent.change(searchBox(view), { target: { value: "a" } });
		expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);

		fireEvent.click(characterRow(view, "Aria"));
		expect(screenTitle(view)).toBe("Aria");
		fireEvent.click(backButton(view));

		expect(screenTitle(view)).toBe("characters");
		expect(searchBox(view).value).toBe("a");
		expect(useNavigationStore.getState().characterSortMode).toBe("alphabetical");
		expect(listedCharacters(view)).toEqual(["Aria", "Cora"]);
	});

	it("the query also survives closing and reopening the drawer", () => {
		const view = openRailOnList();
		fireEvent.change(searchBox(view), { target: { value: "br" } });
		fireEvent.click(hamburger(view));
		openDrawer();
		showCharacterList(view);
		expect(searchBox(view).value).toBe("br");
	});

	it("header «+» creates a chat for THIS character; header ⋮ opens THIS character's menu", () => {
		const view = openRailOnList();
		openCharacter(view, "Cora");
		fireEvent.click(newChatControl(view));
		expect(createChatSpy).toHaveBeenCalledWith(CORA);

		fireEvent.click(characterMenuButton(view));
		fireEvent.click(view.getByText("sidebar_export"));
		expect(exportCharacterSpy).toHaveBeenCalledWith(CORA);
	});

	it("a character without chats shows the panel's empty state; its «new chat» button creates for that character", () => {
		const view = openRailOnList();
		openCharacter(view, "Cora");
		expect(chatRowTitles(view)).toEqual([]);
		expect(view.getByText("sidebar_send_a_message")).toBeTruthy();
		fireEvent.click(inDrawer(view, "button.empty-cta"));
		expect(createChatSpy).toHaveBeenCalledWith(CORA);
	});

	it("a character that disappears while its screen is open falls back to the list", () => {
		const view = openRail();
		expect(screenTitle(view)).toBe("Aria");
		act(() => {
			const current = useBootstrapStore.getState().data;
			if (!current) throw new Error("bootstrap data was not seeded");
			useBootstrapStore.setState({ data: { ...current, allCharacters: CHARACTERS.filter((c) => c.id !== ARIA) } });
		});
		expect(screenTitle(view)).toBe("characters");
		expect(listedCharacters(view)).toEqual(["Bram", "Cora"]);
	});

	it("both screens carry a Drawer.Title as the dialog's accessible name", () => {
		const view = openRail();
		const dialog = view.baseElement.querySelector('[role="dialog"]');
		const nameOf = () => {
			const id = dialog?.getAttribute("aria-labelledby");
			return textOf(id ? view.baseElement.querySelector(`#${CSS.escape(id)}`) : null);
		};
		expect(nameOf()).toBe("Aria");
		fireEvent.click(backButton(view));
		expect(nameOf()).toBe("characters");
	});

	it("header controls are 30px with a 44px hit area (7px of invisible padding on every side)", () => {
		const view = openRailOnList();
		for (const control of [createControl(view), importControl(view)]) {
			expect(control.className).toContain("h-[30px]");
			expect(control.className).toContain("w-[30px]");
			expect(control.className).toContain("before:-inset-[7px]");
		}
		openCharacter(view, "Aria");
		for (const control of [newChatControl(view), characterMenuButton(view)]) {
			expect(control.className).toContain("w-[30px]");
			expect(control.className).toContain("before:-inset-[7px]");
		}
		// The back arrow is narrower (24px) to leave the name room; its hit area is widened sideways to 44px.
		expect(backButton(view).className).toContain("w-6");
		expect(backButton(view).className).toContain("before:-inset-x-2.5");
		expect(backButton(view).className).toContain("before:-inset-y-[7px]");
	});

	it("character rows are at least 48px tall; names ellipsize, the summary line wraps instead", () => {
		const view = openRailOnList();
		const row = characterRow(view, "Aria");
		expect(row.className).toContain("min-h-[48px]");
		expect(row.querySelector("span.truncate")?.textContent).toBe("Aria");
		expect(row.querySelector("span.leading-snug")?.className).not.toContain("truncate");
	});
});

describe("Rail drawer — «N chats · when» on the character rows", () => {
	it("shows the count of the play-mode chats and the newest updatedAt of those chats", () => {
		const view = openRailOnList();
		const chats = chatRows();
		const newest = (id: string) => chats.filter((c) => c.characterId === id && c.mode === "rp").map((c) => c.updatedAt).sort().reverse()[0];
		expect(rowSummary(view, "Aria")).toBe(`chat_count#2 · ${formatRelativeTime(newest(ARIA))}`);
		expect(rowSummary(view, "Bram")).toBe(`chat_count#1 · ${formatRelativeTime(newest(BRAM))}`);
		expect(formatRelativeTime(newest(ARIA))).not.toBe("");
	});

	it("a character without play-mode chats says so and shows no time (its co-author chat is not counted)", () => {
		const view = openRailOnList();
		expect(rowSummary(view, "Cora")).toBe("rail_no_chats");
	});

	it("the count equals the rows its screen lists, for every character", () => {
		const view = openRailOnList();
		for (const name of CHARACTER_NAMES) {
			showCharacterList(view);
			const summary = rowSummary(view, name);
			fireEvent.click(characterRow(view, name));
			const rows = chatRowTitles(view).length;
			if (rows === 0) expect(summary).toBe("rail_no_chats");
			else expect(summary).toStartWith(`chat_count#${rows}`);
		}
	});
});

describe("Rail drawer — build mode keeps the build-panel list", () => {
	it("shows the editor header and no character browser", () => {
		seedStores();
		useNavigationStore.setState({ mode: "build" });
		const view = render(<Rail />);
		openDrawer();
		expect(screenTitle(view)).toBe("editor");
		expect(drawer(view).querySelector('button[aria-label="create_manual"]')).toBeNull();
		expect(drawer(view).querySelector('button[aria-label="back"]')).toBeNull();
	});
});

// ── i18n: the plural forms behind the summary line ───────────────────────

describe("chat_count plural keys", () => {
	async function instance(lng: "en" | "ru") {
		const inst = i18next.createInstance();
		await inst.init({ lng, resources: { en: { translation: en }, ru: { translation: ru } }, interpolation: { prefix: "{", suffix: "}" } });
		return inst;
	}

	it("English: one / other", async () => {
		const inst = await instance("en");
		expect(String(inst.t("chat_count", { count: 1 }))).toBe("1 chat");
		expect(String(inst.t("chat_count", { count: 18 }))).toBe("18 chats");
		expect(en.rail_no_chats).toBe("No chats");
	});

	it("Russian: every count picks the plural category's own string (one / few / many)", async () => {
		const inst = await instance("ru");
		const rules = new Intl.PluralRules("ru");
		const forms: Partial<Record<Intl.LDMLPluralRule, string>> = { one: ru.chat_count_one, few: ru.chat_count_few, many: ru.chat_count_many };
		expect(new Set(Object.values(forms)).size).toBe(3);
		for (const count of [1, 2, 4, 5, 11, 12, 18, 21, 22, 25, 101]) {
			const expected = forms[rules.select(count)] ?? ru.chat_count_other;
			expect(String(inst.t("chat_count", { count }))).toBe(expected.replace("{count}", String(count)));
		}
		expect(typeof ru.rail_no_chats).toBe("string");
		expect(ru.rail_no_chats.length).toBeGreaterThan(0);
	});
});
