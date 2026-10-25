/**
 * Rail chat-list tests (RAIL_DRILL_IN RD-3-fix) — two defects found in review.
 *
 * 1. With NO active chat the rail got its chat list from `useChatMeta()?.chats`,
 *    which is null without an active chat — every character row said «No chats»
 *    and every character screen showed the empty state although the chats
 *    existed. The list now comes from `useChatList()` (the sidebar list, which
 *    does not depend on an active chat).
 * 2. The panel's chat list kept the bottom-sheet cap (`max-h-[55vh]`) inside the
 *    rail drawer and left an empty band above the bottom panel on a tall phone.
 *    The panel's `listSizing` now picks per host: the drawer's character screen
 *    "fill"s its flex column and scrolls; the tablet sheet keeps today's cap.
 *
 * Renders the real `<Rail />` (both hosts live in it: the drawer and, via the
 * collapsed strip's avatar tap, the tablet `CharacterChatsSheet`) with real
 * stores. Only the boundaries are doubled, as in `rail-character-browser.test`:
 * `useT` (keys verbatim; a `count` option is appended as `key#count`), the
 * tooltip provider, the two controllers, and the two mobile import
 * orchestrators. The snapshot store is seeded with the chat list but WITHOUT an
 * active chat — the state that exposed the first defect.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { forwardRef, type ReactNode } from "react";
import { brandId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../../api/types.js";
import type { CharacterImportMobileHandle } from "../../modals/import/CharacterImportMobile.js";
import type { ChatImportMobileHandle } from "../../modals/import/ChatImportMobile.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireUiSettings } from "../../../../test/wire-fixtures.js";
import { formatRelativeTime } from "../sidebar-utils.js";

useDomEnv({ failOnNetwork: true });

const { act, fireEvent, render } = await import("@testing-library/react");

// ── Doubles ──────────────────────────────────────────────────────────────

installI18nContextSeam({
	custom: {
		t: (key, opts?) => (typeof opts?.count === "number" ? `${key}#${opts.count}` : key),
		tDynamic: (key) => key,
	},
});

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const NOOP_ASYNC = async () => {};
const CHAT_STUB = {
	handleSwitchChat: mock(async (_chatId: ChatId): Promise<void> => {}),
	handleFork: NOOP_ASYNC,
	handleDeleteActiveBranch: NOOP_ASYNC,
};
const CHARACTER_STUB = {
	handleCreateChat: NOOP_ASYNC,
	handleExportCharacter: NOOP_ASYNC,
	handleDuplicateCharacter: NOOP_ASYNC,
	handleDeleteCharacter: NOOP_ASYNC,
	handleExportChatJsonl: NOOP_ASYNC,
	handleRemoveChat: NOOP_ASYNC,
	handleRenameChat: NOOP_ASYNC,
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
// these doubles render nothing (the tests never open a picker).
const realCharacterImport = await import("../../modals/import/CharacterImportMobile.js");
mock.module("../../modals/import/CharacterImportMobile.js", () => ({
	...realCharacterImport,
	CharacterImportMobile: forwardRef<CharacterImportMobileHandle, object>(function CharacterImportDouble() {
		return null;
	}),
}));
const realChatImport = await import("../../modals/import/ChatImportMobile.js");
mock.module("../../modals/import/ChatImportMobile.js", () => ({
	...realChatImport,
	ChatImportMobile: forwardRef<ChatImportMobileHandle, object>(function ChatImportDouble() {
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

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function makeEntry(id: string, name: string): AppCharacterEntry {
	return {
		id,
		name,
		subtitle: "",
		tags: [],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

function makeChat(id: ChatId, characterId: string, title: string, updatedAt: string): ChatListItem {
	return {
		id,
		title,
		characterId: brandId<CharacterId>(characterId),
		characterName: "",
		subtitle: `${title} subtitle`,
		activeBranchLabel: "",
		mode: "rp",
		messageCount: 4,
		lastMessageAt: updatedAt,
		updatedAt,
	};
}

const CHARACTERS = [makeEntry(ARIA, "Aria"), makeEntry(BRAM, "Bram"), makeEntry(CORA, "Cora")];
/** Aria: two chats (newest 5 min ago); Bram: one (1 min ago); Cora: none. */
const CHATS = [
	makeChat(CHAT_A1, ARIA, "Moonlit Harbor", ago(5 * MIN)),
	makeChat(CHAT_A2, ARIA, "Winter Market", ago(2 * DAY)),
	makeChat(CHAT_B1, BRAM, "Station Nine", ago(MIN)),
];

/** The chat list is loaded (the sidebar list) but NO chat is active. */
beforeEach(() => {
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
	useChatStore.setState({ activeChatId: null, selectedCharacterId: null });
	useModalStore.setState({ isCreateCharacterModalOpen: false });
	useCharacterStore.setState({ confirmDestroy: null });
	useSnapshotStore.setState({
		character: null,
		activeChat: null,
		activeBranch: null,
		branches: [],
		chatIds: CHATS.map((c) => c.id),
		chatsById: Object.fromEntries(CHATS.map((c) => [c.id, c])),
	});
});

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Render the rail and open its drawer the way the TopBar hamburger does. */
function openRail(): View {
	const view = render(<Rail />);
	act(() => {
		useNavigationStore.setState({ railForceOpen: useNavigationStore.getState().railForceOpen + 1 });
	});
	return view;
}

function drawer(view: View): HTMLElement {
	const popup = view.baseElement.querySelector<HTMLElement>(".rail-popup");
	if (!popup) throw new Error("the rail drawer is not mounted");
	return popup;
}

/** The drawer's character row (tap target) for `name` on screen 1. */
function characterRow(view: View, name: string): HTMLElement {
	const label = [...drawer(view).querySelectorAll("span")].find((el) => el.childElementCount === 0 && el.textContent === name);
	const row = label?.closest<HTMLElement>("button");
	if (!row) throw new Error(`no character row for "${name}"`);
	return row;
}

/** Line 2 of a character row: «N chats · when» / «No chats». */
function rowSummary(view: View, name: string): string {
	return characterRow(view, name).querySelector("span.leading-snug")?.textContent ?? "";
}

/** The chat rows under `root`, by title. */
function chatTitles(root: HTMLElement): string[] {
	return [...root.querySelectorAll<HTMLElement>("div.group")].map((row) => row.querySelector("span.truncate")?.textContent ?? "");
}

/** The panel's scrolling chat list: the nearest scroller above a chat row. */
function chatList(root: HTMLElement, title: string): HTMLElement {
	const row = [...root.querySelectorAll<HTMLElement>("div.group")].find((el) => el.querySelector("span.truncate")?.textContent === title);
	const list = row?.closest<HTMLElement>("div.overflow-y-auto");
	if (!list) throw new Error(`no chat list around "${title}"`);
	return list;
}

/** The tablet sheet is launched from a collapsed-strip avatar (title = the character's name). */
function openTabletSheet(view: View, name: string): HTMLElement {
	const avatar = view.baseElement.querySelector<HTMLElement>(`div[title="${name}"]`);
	if (!avatar) throw new Error(`no collapsed-strip avatar for "${name}"`);
	fireEvent.click(avatar);
	const sheet = view.baseElement.querySelector<HTMLElement>(".bs-popup");
	if (!sheet) throw new Error("the tablet chats sheet is not mounted");
	return sheet;
}

// ── Defect 1: the chat list does not depend on an active chat ────────────

describe("Rail drawer — chats listed without an active chat", () => {
	it("every character row shows its real count and newest time (Cora has none)", () => {
		const view = openRail();
		expect(useChatStore.getState().activeChatId).toBeNull();
		expect(rowSummary(view, "Aria")).toBe(`chat_count#2 · ${formatRelativeTime(CHATS[0].updatedAt)}`);
		expect(rowSummary(view, "Bram")).toBe(`chat_count#1 · ${formatRelativeTime(CHATS[2].updatedAt)}`);
		expect(rowSummary(view, "Cora")).toBe("rail_no_chats");
	});

	it("tapping a character lists its chats, not the empty state", () => {
		const view = openRail();
		fireEvent.click(characterRow(view, "Aria"));
		expect(chatTitles(drawer(view)).sort()).toEqual(["Moonlit Harbor", "Winter Market"]);
		expect(drawer(view).querySelector(".empty-state")).toBeNull();
	});

	it("the tablet sheet lists the character's chats too", () => {
		const view = openRail();
		const sheet = openTabletSheet(view, "Bram");
		expect(chatTitles(sheet)).toEqual(["Station Nine"]);
	});
});

// ── Defect 2: the chat list sizes itself per host ────────────────────────

describe("Rail chat list — sizing per host", () => {
	it("the drawer's character screen fills its flex column and scrolls (no bottom-sheet cap)", () => {
		const view = openRail();
		fireEvent.click(characterRow(view, "Aria"));
		const list = chatList(drawer(view), "Moonlit Harbor");
		for (const cls of ["min-h-0", "flex-1", "overflow-y-auto"]) expect(list.classList.contains(cls)).toBe(true);
		expect(list.className).not.toContain("max-h-");
		// The host the list fills: a flex column that can shrink below its content.
		const host = list.parentElement;
		for (const cls of ["flex", "flex-col", "min-h-0", "flex-1"]) expect(host?.classList.contains(cls)).toBe(true);
	});

	it("the tablet sheet keeps today's cap, class for class", () => {
		const view = openRail();
		const sheet = openTabletSheet(view, "Aria");
		expect(chatList(sheet, "Moonlit Harbor").className).toBe("max-h-[55vh] overflow-y-auto pb-3");
	});
});
