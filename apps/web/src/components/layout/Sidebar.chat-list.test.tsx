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
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { brandId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import type { AppCharacterEntry, ChatListItem } from "../../api/types.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { wireUiSettings } from "../../../test/wire-fixtures.js";

useDomEnv({ failOnNetwork: true });

const { act, fireEvent, render, within } = await import("@testing-library/react");

// ── Doubles ──────────────────────────────────────────────────────────────

installI18nContextSeam();

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
const { CoauthorSidebar } = await import("../coauthor/CoauthorSidebar.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { useChatStore, useNavigationStore } = await import("../../stores/index.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { useChatRunActivityStore } = await import("../../stores/chat-run-activity-store.js");
const originalActivity = useChatRunActivityStore.getState();

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
	useChatRunActivityStore.setState(originalActivity, true);
	CHAT_STUB.handleSwitchChat.mockClear();
});
afterAll(() => useChatRunActivityStore.setState(originalActivity, true));

// ── Harness ──────────────────────────────────────────────────────────────

type View = ReturnType<typeof render>;

/** Chat rows' titles in the expanded sidebar's chats section, in document order. */
function chatSectionTitles(view: View): string[] {
	const section = [...view.container.querySelectorAll("section")].find((s) => s.textContent?.includes("sidebar_chats"));
	if (!section) throw new Error("the chats section is not rendered");
	return [...section.querySelectorAll<HTMLElement>("div.truncate")].map((el) => el.textContent ?? "");
}

// ── Tests ────────────────────────────────────────────────────────────────

function expectVerticalContentSizing(area: Element) {
	const content = area.querySelector<HTMLElement>("[data-scroll-content]")!;
	expect(Number.parseFloat(content.style.minWidth)).toBe(0);
	expect(content.style.width).toBe("100%");
}

describe("Sidebar — chats section without an active chat", () => {
	it.each([["RP", Sidebar], ["Co-Author", CoauthorSidebar]] as const)("%s uses narrow custom viewport chrome in both expanded sections without changing global widths", async (_mode, Component) => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Component />);
		const sidebar = view.container.firstElementChild!;
		await act(async () => {});
		expect(sidebar.classList.contains("sidebar-scrollbars")).toBe(false);
		const sections = view.container.querySelectorAll('section[data-scroll-area="thin"]');
		expect(sections.length).toBe(2);
		for (const section of sections) {
			expect(section.querySelector("[data-scroll-viewport]")?.classList.contains("scrollbar-hide")).toBe(true);
			expect(section.querySelector("[data-scroll-viewport]")?.classList.contains("isolate")).toBe(true);
			expect(section.querySelector("[data-scroll-content]")).not.toBeNull();
			expectVerticalContentSizing(section);
		}
		const css = await Bun.file(`${import.meta.dir}/../../styles.css`).text();
		expect(css).toContain("::-webkit-scrollbar{width:8px;height:8px}");
		expect(css).not.toContain(".sidebar-scrollbars");
	});

	it.each([["RP", Sidebar], ["Co-Author", CoauthorSidebar]] as const)("%s keeps the collapsed avatar strip inside a narrow custom scroll area", async (_mode, Component) => {
		seedNoActiveChat({ collapsed: true, selectedCharacterId: ARIA });
		const view = render(<Component />);
		await act(async () => {});
		const area = view.container.querySelector('[data-scroll-area="thin"]')!;
		expect(area).not.toBeNull();
		expect(area.querySelector("[data-scroll-content]")?.textContent).toContain("A");
		expectVerticalContentSizing(area);
		expect(area.querySelector("[data-scroll-viewport]")?.classList.contains("scrollbar-hide")).toBe(true);
	});

	it.each([false, true])("keeps build navigation scrollable with custom chrome (collapsed=%s)", async (collapsed) => {
		seedNoActiveChat({ collapsed, selectedCharacterId: ARIA });
		useNavigationStore.setState({ mode: "build" });
		const view = render(<Sidebar />);
		await act(async () => {});
		expect(view.container.querySelector('[data-scroll-area="thin"]')).not.toBeNull();
		expectVerticalContentSizing(view.container.querySelector('[data-scroll-area="thin"]')!);
		expect(view.container.querySelector("[data-scroll-viewport]")?.classList.contains("scrollbar-hide")).toBe(true);
	});

	it("marks a character's non-first generating chat without intercepting the character actions", async () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Sidebar />);
		await act(async () => {});
		act(() => {
			useChatRunActivityStore.getState().setRunning("chat-a2", true);
			useChatRunActivityStore.getState().setRunning("chat-b1", true);
		});
		const characterRows = view.getByText("Bram").parentElement!;
		const characterBadge = within(characterRows).getByRole("status");
		expect(characterBadge.getAttribute("aria-label")).toBe("chat_writing_badge");
		expect(characterBadge.parentElement?.classList.contains("h-8")).toBe(true);
		expect(view.getAllByRole("status")).toHaveLength(2); // Avatars only: Aria and Bram, never Winter Market.
		const chatsSection = [...view.container.querySelectorAll("section")].find((section) => section.textContent?.includes("sidebar_chats"))!;
		expect(within(chatsSection).queryByRole("status")).toBeNull();
		fireEvent.click(within(characterRows).getByRole("button", { name: "sidebar_character_actions" }));
		expect(useChatStore.getState().selectedCharacterId).toBe(ARIA);
		expect(CHAT_STUB.handleSwitchChat).not.toHaveBeenCalled();
		act(() => useChatRunActivityStore.getState().setRunning("chat-a2", false));
		expect(view.getAllByRole("status")).toEqual([characterBadge]);
	});

	it("lists the selected character's RP chats (not another character's, not its Co-Author chat)", async () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Sidebar />);
		await act(async () => {});
		expect(chatSectionTitles(view)).toEqual(["Moonlit Harbor", "Winter Market"]);
		expect(within(view.container).queryByText("sidebar_send_a_message")).toBeNull();
	});

	it("tapping one of those chats switches to it", async () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: ARIA });
		const view = render(<Sidebar />);
		await act(async () => {});
		fireEvent.click(within(view.container).getByText("Winter Market"));
		expect(CHAT_STUB.handleSwitchChat).toHaveBeenCalledWith(brandId<ChatId>("chat-a2"));
	});

	it("a selected character with no chats of its own still shows the empty state", async () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: CORA });
		const view = render(<Sidebar />);
		await act(async () => {});
		expect(chatSectionTitles(view)).toEqual([]);
		expect(within(view.container).getByText("sidebar_send_a_message")).toBeTruthy();
	});
});

describe("Sidebar — character list recency without an active chat", () => {
	it("orders the characters by their newest RP chat (Bram, Aria, Cora), not by the unsorted tie", async () => {
		seedNoActiveChat({ collapsed: false, selectedCharacterId: null });
		const view = render(<Sidebar />);
		await act(async () => {});
		const names = ["Aria", "Bram", "Cora"];
		const hits = names.flatMap((name) =>
			[...view.container.querySelectorAll("span")].filter((el) => el.childElementCount === 0 && el.textContent?.trim() === name).map((el) => ({ name, el })),
		);
		hits.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
		expect(hits.map((h) => h.name)).toEqual(["Bram", "Aria", "Cora"]);
	});
});

describe("Sidebar — collapsed flyout without an active chat", () => {
	it.each([["RP", Sidebar], ["Co-Author", CoauthorSidebar]] as const)("%s portal list uses narrow custom chrome independently of the sidebar root", async (_mode, Component) => {
		seedNoActiveChat({ collapsed: true, selectedCharacterId: null });
		const view = render(<Component />);
		await act(async () => {
			const tile = [...view.container.querySelectorAll("span")].find((el) => el.textContent === "A")!;
			fireEvent.click(tile);
		});
		const dialog = view.getByRole("dialog");
		expect(view.container.contains(dialog)).toBe(false);
		const area = dialog.querySelector('[data-scroll-area="thin"]')!;
		expect(area).not.toBeNull();
		expectVerticalContentSizing(area);
		expect(area.querySelector("[data-scroll-viewport]")?.classList.contains("scrollbar-hide")).toBe(true);
	});

	it("keeps the status on the collapsed avatar without adding a chat-row badge", async () => {
		seedNoActiveChat({ collapsed: true, selectedCharacterId: null });
		useChatRunActivityStore.getState().setRunning("chat-a2", true);
		const view = render(<Sidebar />);
		const badge = view.getByRole("status", { name: "chat_writing_badge" });
		expect(badge.parentElement?.classList.contains("relative")).toBe(true);
		await act(async () => fireEvent.click(badge));
		expect(within(document.body).getByText("Winter Market")).toBeTruthy();
		expect(within(document.body).getAllByRole("status")).toEqual([badge]);
	});

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
