/**
 * Desktop Sidebar — the chat list does not depend on an active chat
 * (RAIL_DRILL_IN RD-4).
 *
 * `Sidebar` used to take its chat list from `useChatMeta()?.chats`, which is
 * null whenever no chat is active. The desktop sidebar DOES render in that state
 * (`AppShell` replaces only the central surface with the «select a character /
 * chat» placeholder — e.g. right after the current chat is deleted), so with no
 * active chat the chats section showed its empty state, the collapsed-sidebar
 * flyout listed nothing, and the character list's recency sort had no chat data.
 * The list now comes from `useChatList()` — the sidebar list, the same source the
 * phone rails read.
 *
 * Renders the real `<Sidebar />` with real stores (the BuildCharacterSwitcher
 * harness pattern); only the boundaries are doubled: `useT` (keys verbatim), the
 * tooltip provider and the two controllers. The snapshot store is seeded with the
 * chat list and a selected character but WITHOUT an active chat. The Radix
 * flyout popover mounts under happy-dom via a click inside an async act.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { brandId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../api/types.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireUiSettings } from "../../../test/wire-fixtures.js";

useDomEnv({ failOnNetwork: true });

const { act, fireEvent, render, within } = await import("@testing-library/react");

// ── Doubles ──────────────────────────────────────────────────────────────

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => children,
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const NOOP_ASYNC = async () => {};
const CHAT_STUB = {
	handleSwitchChat: mock(async (_chatId: ChatId): Promise<void> => {}),
	handleActivateBranch: NOOP_ASYNC,
	handleRenameBranch: NOOP_ASYNC,
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

const realChatController = await import("../../hooks/use-chat-controller.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
	...realChatController,
	useChatController: () => CHAT_STUB,
}));
const realCharacterController = await import("../../hooks/use-character-controller.js");
mock.module("../../hooks/use-character-controller.js", () => ({
	...realCharacterController,
	useCharacterController: () => CHARACTER_STUB,
}));

const { Sidebar } = await import("./Sidebar.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { useChatStore, useNavigationStore } = await import("../../stores/index.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const ARIA = "char-aria";
const BRAM = "char-bram";
const CORA = "char-cora";

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

function makeChat(id: string, characterId: string, title: string, updatedAt: string, mode: "rp" | "coauthor" = "rp"): ChatListItem {
	return {
		id: brandId<ChatId>(id),
		title,
		characterId: brandId<CharacterId>(characterId),
		characterName: "",
		subtitle: "",
		activeBranchLabel: "",
		mode,
		messageCount: 4,
		lastMessageAt: updatedAt,
		updatedAt,
	};
}

const CHARACTERS = [makeEntry(ARIA, "Aria"), makeEntry(BRAM, "Bram"), makeEntry(CORA, "Cora")];
/** Aria: two RP chats and a Co-Author draft (never listed in the RP sidebar); Bram: one RP chat (newest); Cora: none. */
const CHATS = [
	makeChat("chat-a1", ARIA, "Moonlit Harbor", ago(5 * MIN)),
	makeChat("chat-a2", ARIA, "Winter Market", ago(2 * DAY)),
	makeChat("chat-a3", ARIA, "Aria Draft", ago(MIN), "coauthor"),
	makeChat("chat-b1", BRAM, "Station Nine", ago(30_000)),
];

/** The chat list is loaded and a character is selected, but NO chat is active. */
function seedNoActiveChat(opts: { collapsed: boolean; selectedCharacterId: string | null }): void {
	useNavigationStore.setState({ mode: "play", sidebarCollapsed: opts.collapsed, characterSortMode: "recent", chatSortMode: "recent" });
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
	useChatStore.setState({ activeChatId: null, selectedCharacterId: opts.selectedCharacterId });
	useSnapshotStore.setState({
		character: null,
		persona: null,
		activeChat: null,
		activeBranch: null,
		branches: [],
		chatIds: CHATS.map((c) => c.id),
		chatsById: Object.fromEntries(CHATS.map((c) => [c.id, c])),
	});
}

beforeEach(() => {
	CHAT_STUB.handleSwitchChat.mockClear();
});

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Chat rows' titles in the expanded sidebar's chats section, in document order. */
function chatSectionTitles(view: View): string[] {
	const section = [...view.container.querySelectorAll("section")].find((s) => s.textContent?.includes("sidebar_chats"));
	if (!section) throw new Error("the chats section is not rendered");
	return [...section.querySelectorAll<HTMLElement>("div.truncate")].map((el) => el.textContent ?? "");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Sidebar — chats section without an active chat", () => {
	it("lists the selected character's RP chats (not another character's, not its Co-Author chat)", () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Sidebar />);
		expect(chatSectionTitles(view)).toEqual(["Moonlit Harbor", "Winter Market"]);
		expect(within(view.container).queryByText("sidebar_send_a_message")).toBeNull();
	});

	it("tapping one of those chats switches to it", () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Sidebar />);
		fireEvent.click(within(view.container).getByText("Winter Market"));
		expect(CHAT_STUB.handleSwitchChat).toHaveBeenCalledWith(brandId<ChatId>("chat-a2"));
	});

	it("a selected character with no chats of its own still shows the empty state", () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: CORA });
		const view = render(<Sidebar />);
		expect(chatSectionTitles(view)).toEqual([]);
		expect(within(view.container).getByText("sidebar_send_a_message")).toBeTruthy();
	});
});

describe("Sidebar — character list recency without an active chat", () => {
	it("orders the characters by their newest RP chat (Bram, Aria, Cora), not by the unsorted tie", () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: null });
		const view = render(<Sidebar />);
		const names = ["Aria", "Bram", "Cora"];
		const hits = names.flatMap((name) =>
			[...view.container.querySelectorAll("span")].filter((el) => el.childElementCount === 0 && el.textContent?.trim() === name).map((el) => ({ name, el })),
		);
		hits.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
		expect(hits.map((h) => h.name)).toEqual(["Bram", "Aria", "Cora"]);
	});
});

describe("Sidebar — collapsed flyout without an active chat", () => {
	it("opening a character's flyout lists that character's RP chats", async () => {
		seedNoActiveChat({ collapsed: true, selectedCharacterId: null });
		const view = render(<Sidebar />);
		const tile = [...view.container.querySelectorAll("span")].find((el) => el.textContent === "A");
		if (!tile) throw new Error("no collapsed-strip avatar for Aria");
		// Radix Popper positions asynchronously after mount: click inside an async act so those updates settle.
		await act(async () => {
			fireEvent.click(tile);
		});
		const body = within(document.body);
		expect(body.getByText("Moonlit Harbor")).toBeTruthy();
		expect(body.getByText("Winter Market")).toBeTruthy();
		expect(body.queryByText("Aria Draft")).toBeNull();
		expect(body.queryByText("Station Nine")).toBeNull();
		expect(body.queryByText("sidebar_send_a_message")).toBeNull();
	});
});
