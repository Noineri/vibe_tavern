/**
 * Character-chats panel characterization (RAIL_DRILL_IN RD-1).
 *
 * Everything below the sheet header of `CharacterChatsSheet` — chat search, the
 * chat list and its empty states, the branches block, inline chat/branch
 * rename, the chat/branch ⋮ `ActionSheet`s and the `useRowActions` wiring —
 * lives in `character-chats-panel.tsx`. These tests render THROUGH the sheet
 * (the public surface both rails use) so they pin the same behavior before and
 * after the panel was extracted: the move must leave every assertion untouched.
 *
 * Seams: `useT` is mocked at its module boundary (keys verbatim, `...real`
 * spread) so labels are queried by i18n key; the two branch actions that hit
 * the API (`activateBranchAction`, `renameBranchAction`) are replaced on
 * `chat-actions.js` (`...real` spread); the character controller, the confirm
 * dialog setter and the navigation callbacks are plain test-local doubles.
 * `BottomSheet` / `ActionSheet` run real (Base UI Drawer mounts under
 * happy-dom), so the nested ⋮ sheets are exercised as nested drawers.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { brandId, type ChatBranch, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { CharacterChatsSheetProps } from "./CharacterChatsSheet.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { fireEvent, render } = await import("@testing-library/react");

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const activateBranchAction = mock(async (_chatId: ChatId, _branchId: ChatBranchId): Promise<void> => {});
const renameBranchAction = mock(async (_chatId: ChatId, _branchId: ChatBranchId, _label: string): Promise<void> => {});
const realChatActions = await import("../../../stores/api-actions/chat-actions.js");
mock.module("../../../stores/api-actions/chat-actions.js", () => ({
	...realChatActions,
	activateBranchAction,
	renameBranchAction,
}));

const { CharacterChatsSheet } = await import("./CharacterChatsSheet.js");

beforeEach(() => {
	activateBranchAction.mockClear();
	renameBranchAction.mockClear();
});

const CHAT_1 = brandId<ChatId>("chat-1");
const CHAT_2 = brandId<ChatId>("chat-2");
const CHAT_3 = brandId<ChatId>("chat-3");
const BR_ROOT = brandId<ChatBranchId>("br-root");
const BR_ALT = brandId<ChatBranchId>("br-alt");
const BR_UNNAMED = brandId<ChatBranchId>("br-unnamed");

function makeChat(id: ChatId, title: string, over: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title,
		characterId: brandId<ChatListItem["characterId"]>("char-1"),
		characterName: "Aria",
		subtitle: `${title} subtitle`,
		activeBranchLabel: "",
		mode: "rp",
		messageCount: 3,
		lastMessageAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...over,
	};
}

function makeBranch(id: ChatBranchId, label: string): ChatBranch {
	return {
		id,
		chatId: CHAT_1,
		parentBranchId: null,
		forkedFromMessageId: null,
		label,
		createdAt: "2026-01-01T00:00:00Z",
	} as ChatBranch;
}

const CHATS: readonly ChatListItem[] = [
	makeChat(CHAT_1, "Moonlit Harbor"),
	makeChat(CHAT_2, "Winter Market", { activeBranchLabel: "Alt timeline" }),
	makeChat(CHAT_3, "Harbor Revisited"),
];
const BRANCHES: readonly ChatBranch[] = [makeBranch(BR_ROOT, "Main thread"), makeBranch(BR_ALT, "Side thread")];

interface RenderOptions extends Partial<CharacterChatsSheetProps> {
	removalMode?: "delete" | "clear";
}

function renderSheet(opts: RenderOptions = {}) {
	const { removalMode = "delete", ...props } = opts;
	const character = {
		handleRenameChat: mock(async (_chatId: ChatId, _title: string): Promise<void> => {}),
		handleExportChatJsonl: mock(async (_chatId: ChatId): Promise<void> => {}),
		handleRemoveChat: mock(async (_chatId: ChatId): Promise<void> => {}),
		getChatRemovalMode: mock((_chatId: ChatId) => removalMode),
	};
	const setConfirmDestroy = mock();
	const onClose = mock();
	const onSwitchChat = mock();
	const onCreateChat = mock();
	const openChatImport = mock();
	const view = render(
		<CharacterChatsSheet
			characterId="char-1"
			characterName="Aria"
			characterAvatarSrc={null}
			chats={CHATS}
			activeChatId={CHAT_1}
			branches={BRANCHES}
			activeBranchId={BR_ROOT}
			withBranches={true}
			emptyTitleKey="sidebar_send_a_message"
			mode="rp"
			character={character as unknown as CharacterControllerActions}
			setConfirmDestroy={setConfirmDestroy}
			openChatImport={openChatImport}
			onClose={onClose}
			onSwitchChat={onSwitchChat}
			onCreateChat={onCreateChat}
			{...props}
		/>,
	);
	return { ...view, character, setConfirmDestroy, onClose, onSwitchChat, onCreateChat, openChatImport };
}

type View = ReturnType<typeof renderSheet>;

/**
 * The chat row card (`.group`) whose title span reads `title`. Scoped to the row
 * markup, not a global text query: a closing ⋮ sheet keeps its title (the same
 * text) mounted through its exit transition, which never completes under
 * happy-dom.
 */
function chatRow(view: View, title: string): HTMLElement {
	const row = [...view.baseElement.querySelectorAll<HTMLElement>("div.group")]
		.find((el) => el.querySelector("span.truncate")?.textContent === title);
	if (!row) throw new Error(`no chat row for "${title}"`);
	return row;
}

/** The title text of a row — null while the row shows its rename input instead. */
function rowTitle(row: HTMLElement): string | null {
	if (row.querySelector("input")) return null;
	return row.querySelector("span.truncate")?.textContent ?? null;
}

/** The chat ⋮ button — the row's only `button.absolute`. */
function chatMenuButton(row: HTMLElement): HTMLButtonElement {
	const btn = row.querySelector<HTMLButtonElement>("button.absolute");
	if (!btn) throw new Error("no chat menu button in row");
	return btn;
}

/** The branch toggle — the row's `button` carrying the `branch_count` label. */
function branchToggle(row: HTMLElement): HTMLButtonElement | undefined {
	return [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").includes("branch_count"));
}

/** The branch row (`div.cursor-pointer`) holding `label`, plus its ⋮ button. */
function branchRow(view: View, label: string): { row: HTMLElement; menu: HTMLButtonElement } {
	const row = [...view.baseElement.querySelectorAll<HTMLElement>("div.cursor-pointer")]
		.find((el) => el.querySelector("button.ml-auto") !== null && el.querySelector("span.truncate")?.textContent === label);
	if (!row) throw new Error(`no branch row for "${label}"`);
	const menu = row.querySelector<HTMLButtonElement>("button.ml-auto");
	if (!menu) throw new Error("no branch menu button in row");
	return { row, menu };
}

function searchBox(view: View): HTMLInputElement {
	return view.getByPlaceholderText("chat_search_placeholder") as HTMLInputElement;
}

/** The inline rename input — the only `input` besides the search box. */
function renameInput(view: View): HTMLInputElement | null {
	const inputs = [...view.baseElement.querySelectorAll<HTMLInputElement>("input")].filter((i) => i !== searchBox(view));
	return inputs[0] ?? null;
}

describe("CharacterChatsSheet — sheet header and closed state", () => {
	it("renders nothing while characterId is null", () => {
		const view = renderSheet({ characterId: null });
		expect(view.baseElement.textContent).toBe("");
	});

	it("shows the character name and initials fallback; + creates a chat, x closes", () => {
		const view = renderSheet();
		expect(view.getByText("Aria")).toBeTruthy();
		expect(view.getByText("A")).toBeTruthy();
		fireEvent.click(view.getByLabelText("new_chat"));
		expect(view.onCreateChat).toHaveBeenCalledTimes(1);
		fireEvent.click(view.getByLabelText("close"));
		expect(view.onClose).toHaveBeenCalledTimes(1);
	});

	it("renders the avatar image when a source is given", () => {
		const view = renderSheet({ characterAvatarSrc: "/avatar.png" });
		const img = view.getByAltText("Aria") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe("/avatar.png");
	});
});

describe("CharacterChatsSheet — chat list, search and empty states", () => {
	it("lists every chat with its title and subtitle; the active chat carries the accent card", () => {
		const view = renderSheet();
		for (const c of CHATS) {
			expect(view.getByText(c.title)).toBeTruthy();
			expect(view.getByText(c.subtitle)).toBeTruthy();
		}
		expect(chatRow(view, "Moonlit Harbor").className).toContain("bg-accent-dim");
		expect(chatRow(view, "Winter Market").className).toContain("bg-s2/30");
	});

	it("tapping a chat row switches to it", () => {
		const view = renderSheet();
		fireEvent.click(chatRow(view, "Winter Market"));
		expect(view.onSwitchChat).toHaveBeenCalledTimes(1);
		expect(view.onSwitchChat).toHaveBeenCalledWith(CHAT_2);
	});

	it("search filters titles case-insensitively on the trimmed query", () => {
		const view = renderSheet();
		fireEvent.change(searchBox(view), { target: { value: "  HARBOR " } });
		expect(view.queryByText("Moonlit Harbor")).toBeTruthy();
		expect(view.queryByText("Harbor Revisited")).toBeTruthy();
		expect(view.queryByText("Winter Market")).toBeNull();
	});

	it("the trailing clear button appears only with a query and resets the list", () => {
		const view = renderSheet();
		expect(view.queryByLabelText("chat_search_clear")).toBeNull();
		fireEvent.change(searchBox(view), { target: { value: "winter" } });
		expect(view.queryByText("Moonlit Harbor")).toBeNull();
		fireEvent.click(view.getByLabelText("chat_search_clear"));
		expect(searchBox(view).value).toBe("");
		expect(view.queryByLabelText("chat_search_clear")).toBeNull();
		for (const c of CHATS) expect(view.queryByText(c.title)).toBeTruthy();
	});

	it("a query with no match shows the no-results block whose button also clears the search", () => {
		const view = renderSheet();
		fireEvent.change(searchBox(view), { target: { value: "zzz-nothing" } });
		expect(view.getByText("chat_search_no_results")).toBeTruthy();
		for (const c of CHATS) expect(view.queryByText(c.title)).toBeNull();
		// Two clear affordances while no results: the field's trailing x (aria-label) and the block's text button.
		fireEvent.click(view.getByText("chat_search_clear"));
		expect(searchBox(view).value).toBe("");
		expect(view.queryByText("chat_search_no_results")).toBeNull();
		expect(view.queryByText("Winter Market")).toBeTruthy();
	});

	it("no chats: the empty state shows the caller's title key and a new-chat button", () => {
		const view = renderSheet({ chats: [], emptyTitleKey: "coauthor_empty_chats_key" });
		expect(view.getByText("coauthor_empty_chats_key")).toBeTruthy();
		const cta = view.getByText("new_chat");
		expect(cta.className).toContain("empty-cta");
		fireEvent.click(cta);
		expect(view.onCreateChat).toHaveBeenCalledTimes(1);
		expect(view.queryByText("chat_search_no_results")).toBeNull();
	});
});

describe("CharacterChatsSheet — branches block", () => {
	it("withBranches: the active chat shows a collapsed toggle; a tap opens the branch rows, a second tap closes them", () => {
		const view = renderSheet();
		const toggle = branchToggle(chatRow(view, "Moonlit Harbor"));
		expect(toggle).toBeTruthy();
		expect(view.queryByText("Main thread")).toBeNull();
		fireEvent.click(toggle!);
		expect(view.getByText("Main thread")).toBeTruthy();
		expect(view.getByText("Side thread")).toBeTruthy();
		fireEvent.click(toggle!);
		expect(view.queryByText("Main thread")).toBeNull();
	});

	it("the toggle sits only under the active chat, never under inactive ones", () => {
		const view = renderSheet();
		expect(branchToggle(chatRow(view, "Moonlit Harbor"))).toBeTruthy();
		expect(branchToggle(chatRow(view, "Winter Market"))).toBeUndefined();
		expect(branchToggle(chatRow(view, "Harbor Revisited"))).toBeUndefined();
	});

	it("withBranches=false: no toggle even when branches are passed", () => {
		const view = renderSheet({ withBranches: false });
		expect(branchToggle(chatRow(view, "Moonlit Harbor"))).toBeUndefined();
		expect(view.queryByText("Main thread")).toBeNull();
	});

	it("no toggle without branches, nor when the active chat is not in the list", () => {
		const empty = renderSheet({ branches: [] });
		expect(branchToggle(chatRow(empty, "Moonlit Harbor"))).toBeUndefined();
		empty.unmount();
		const elsewhere = renderSheet({ activeChatId: brandId<ChatId>("chat-elsewhere") });
		for (const c of CHATS) expect(branchToggle(chatRow(elsewhere, c.title))).toBeUndefined();
	});

	it("an unnamed branch falls back to the unnamed label; the active branch is highlighted", () => {
		const view = renderSheet({ branches: [...BRANCHES, makeBranch(BR_UNNAMED, "")] });
		fireEvent.click(branchToggle(chatRow(view, "Moonlit Harbor"))!);
		expect(view.getByText("sidebar_unnamed_branch")).toBeTruthy();
		expect(branchRow(view, "Main thread").row.className).toContain("bg-accent-dim/50");
		expect(branchRow(view, "Side thread").row.className).not.toContain("bg-accent-dim/50");
	});

	it("tapping a branch row activates it for the active chat without switching chats", () => {
		const view = renderSheet();
		fireEvent.click(branchToggle(chatRow(view, "Moonlit Harbor"))!);
		fireEvent.click(branchRow(view, "Side thread").row);
		expect(activateBranchAction).toHaveBeenCalledWith(CHAT_1, BR_ALT);
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});
});

describe("CharacterChatsSheet — inactive chat branch line", () => {
	it("an inactive chat with an active-branch label shows the arrow line", () => {
		const view = renderSheet();
		const line = view.getByText("↳ Alt timeline");
		expect(line.className).toContain("text-t4");
		expect(chatRow(view, "Winter Market").contains(line)).toBe(true);
	});

	it("the line is absent for the active chat and for inactive chats with no label", () => {
		const view = renderSheet({
			chats: [
				makeChat(CHAT_1, "Moonlit Harbor", { activeBranchLabel: "Active chat label" }),
				makeChat(CHAT_2, "Winter Market"),
			],
		});
		expect(view.queryByText("↳ Active chat label")).toBeNull();
		expect(view.baseElement.textContent).not.toContain("↳");
	});
});

describe("CharacterChatsSheet — chat menu (nested action sheet)", () => {
	it("the chat ⋮ opens the action sheet, titled with the chat, without switching chats", () => {
		const view = renderSheet();
		expect(view.queryByText("sidebar_rename")).toBeNull();
		fireEvent.click(chatMenuButton(chatRow(view, "Winter Market")));
		expect(view.getByText("sidebar_rename")).toBeTruthy();
		expect(view.getByText("sidebar_export_jsonl")).toBeTruthy();
		expect(view.getByText("delete")).toBeTruthy();
		expect(view.getByText("cancel")).toBeTruthy();
		const titles = [...view.baseElement.querySelectorAll("h2")].map((h) => h.textContent);
		expect(titles).toContain("Winter Market");
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});

	it("the menu sheet stacks as a nested drawer on top of the chats sheet", () => {
		const view = renderSheet();
		fireEvent.click(chatMenuButton(chatRow(view, "Winter Market")));
		// Two drawer popups are mounted: the chats sheet and the nested menu sheet.
		expect(view.baseElement.querySelectorAll(".bs-popup").length).toBe(2);
		expect(view.baseElement.querySelector("[data-nested-drawer-open]")).toBeTruthy();
	});

	it("mode=coauthor: the chat menu offers no JSONL export", () => {
		const view = renderSheet({ mode: "coauthor", withBranches: false });
		fireEvent.click(chatMenuButton(chatRow(view, "Winter Market")));
		expect(view.getByText("sidebar_rename")).toBeTruthy();
		expect(view.getByText("delete")).toBeTruthy();
		expect(view.queryByText("sidebar_export_jsonl")).toBeNull();
	});

	it("export JSONL runs the character controller for that chat", () => {
		const view = renderSheet();
		fireEvent.click(chatMenuButton(chatRow(view, "Winter Market")));
		fireEvent.click(view.getByText("sidebar_export_jsonl"));
		expect(view.character.handleExportChatJsonl).toHaveBeenCalledWith(CHAT_2);
	});

	it("delete raises the destroy confirmation for that chat (clear wording when the controller says so)", () => {
		const del = renderSheet();
		fireEvent.click(chatMenuButton(chatRow(del, "Winter Market")));
		fireEvent.click(del.getByText("delete"));
		expect(del.setConfirmDestroy).toHaveBeenCalledTimes(1);
		expect(del.setConfirmDestroy.mock.calls[0][0]).toMatchObject({ title: "sidebar_delete_chat", confirmLabel: "delete" });
		del.unmount();

		const clear = renderSheet({ removalMode: "clear" });
		fireEvent.click(chatMenuButton(chatRow(clear, "Winter Market")));
		fireEvent.click(clear.getByText("sidebar_clear_chat"));
		expect(clear.setConfirmDestroy.mock.calls[0][0]).toMatchObject({ title: "sidebar_clear_chat", confirmLabel: "sidebar_clear_chat" });
	});
});

describe("CharacterChatsSheet — inline chat rename", () => {
	function startRename(view: View, title: string): { input: HTMLInputElement; row: HTMLElement } {
		const row = chatRow(view, title);
		fireEvent.click(chatMenuButton(row));
		fireEvent.click(view.getByText("sidebar_rename"));
		const input = renameInput(view);
		if (!input) throw new Error("rename input did not appear");
		return { input, row };
	}

	it("the menu's rename swaps the title for an input seeded with it", () => {
		const view = renderSheet();
		const { input, row } = startRename(view, "Winter Market");
		expect(input.value).toBe("Winter Market");
		expect(input.className).toContain("border-accent");
		expect(row.contains(input)).toBe(true);
		expect(rowTitle(row)).toBeNull();
	});

	it("Enter commits the trimmed draft and leaves rename mode", () => {
		const view = renderSheet();
		const { input, row } = startRename(view, "Winter Market");
		fireEvent.change(input, { target: { value: "  Spring Fair  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(view.character.handleRenameChat).toHaveBeenCalledTimes(1);
		expect(view.character.handleRenameChat).toHaveBeenCalledWith(CHAT_2, "Spring Fair");
		expect(renameInput(view)).toBeNull();
		// The title span is back (the chat list prop is unchanged — rename goes through the controller).
		expect(rowTitle(row)).toBe("Winter Market");
	});

	it("Escape cancels without renaming", () => {
		const view = renderSheet();
		const { input, row } = startRename(view, "Winter Market");
		fireEvent.change(input, { target: { value: "Spring Fair" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(view.character.handleRenameChat).not.toHaveBeenCalled();
		expect(renameInput(view)).toBeNull();
		expect(rowTitle(row)).toBe("Winter Market");
	});

	it("blur commits the draft", () => {
		const view = renderSheet();
		const { input } = startRename(view, "Winter Market");
		fireEvent.change(input, { target: { value: "Spring Fair" } });
		fireEvent.blur(input);
		expect(view.character.handleRenameChat).toHaveBeenCalledWith(CHAT_2, "Spring Fair");
		expect(renameInput(view)).toBeNull();
	});

	it("a blank draft leaves rename mode without calling the controller", () => {
		const view = renderSheet();
		const { input } = startRename(view, "Winter Market");
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(view.character.handleRenameChat).not.toHaveBeenCalled();
		expect(renameInput(view)).toBeNull();
	});

	it("clicking inside the rename input does not switch chats", () => {
		const view = renderSheet();
		const { input } = startRename(view, "Winter Market");
		fireEvent.click(input);
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});
});

describe("CharacterChatsSheet — branch menu and inline branch rename", () => {
	/** Opens the branches block if it is collapsed, then taps the branch's ⋮. */
	function openBranchMenu(view: View, label: string) {
		const toggle = branchToggle(chatRow(view, "Moonlit Harbor"))!;
		if (!view.queryByText("Main thread")) fireEvent.click(toggle);
		fireEvent.click(branchRow(view, label).menu);
	}

	function startBranchRename(view: View, label: string): HTMLInputElement {
		openBranchMenu(view, label);
		fireEvent.click(view.getByText("sidebar_rename"));
		const input = renameInput(view);
		if (!input) throw new Error("branch rename input did not appear");
		return input;
	}

	it("the branch ⋮ opens the branch action sheet without activating the branch", () => {
		const view = renderSheet();
		openBranchMenu(view, "Side thread");
		expect(view.getByText("sidebar_rename")).toBeTruthy();
		expect(activateBranchAction).not.toHaveBeenCalled();
	});

	it("the menu's rename seeds the input with the branch label; Enter commits via the branch action", () => {
		const view = renderSheet();
		const input = startBranchRename(view, "Side thread");
		expect(input.value).toBe("Side thread");
		fireEvent.change(input, { target: { value: " Renamed side " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(renameBranchAction).toHaveBeenCalledTimes(1);
		expect(renameBranchAction).toHaveBeenCalledWith(CHAT_1, BR_ALT, "Renamed side");
		expect(renameInput(view)).toBeNull();
	});

	it("Escape cancels the branch rename; blur commits it", () => {
		const view = renderSheet();
		const first = startBranchRename(view, "Side thread");
		fireEvent.change(first, { target: { value: "Dropped" } });
		fireEvent.keyDown(first, { key: "Escape" });
		expect(renameBranchAction).not.toHaveBeenCalled();
		expect(renameInput(view)).toBeNull();

		openBranchMenu(view, "Side thread");
		fireEvent.click(view.getByText("sidebar_rename"));
		const second = renameInput(view)!;
		fireEvent.change(second, { target: { value: "Kept" } });
		fireEvent.blur(second);
		expect(renameBranchAction).toHaveBeenCalledWith(CHAT_1, BR_ALT, "Kept");
	});

	it("clicking the branch rename input does not activate the branch", () => {
		const view = renderSheet();
		const input = startBranchRename(view, "Side thread");
		fireEvent.click(input);
		expect(activateBranchAction).not.toHaveBeenCalled();
	});
});
