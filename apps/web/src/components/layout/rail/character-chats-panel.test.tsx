/**
 * Character-chats panel tests (RAIL_DRILL_IN RD-1 characterization, RD-2 flyout look).
 *
 * Everything below the sheet header of `CharacterChatsSheet` — chat search, the
 * chat list and its empty states, the branches block, inline chat/branch
 * rename, the chat/branch ⋮ `ActionSheet`s and the `useRowActions` wiring —
 * lives in `character-chats-panel.tsx`. These tests render THROUGH the sheet
 * (the public surface both rails use) so they pin the same behavior before and
 * after the panel was extracted: the move must leave every assertion untouched.
 *
 * RD-2 restyled the panel after the desktop compact-sidebar flyout (flat chat
 * rows, "when · N msgs" line 2, a branch badge that collapses an open-by-default
 * branches block, "Main" root label, "Branch" / "Delete" actions). Assertions the
 * restyle changed are marked "RD-2" below; everything else is the RD-1 pin.
 *
 * Seams: `useT` is mocked at its module boundary (keys verbatim, `...real`
 * spread) so labels are queried by i18n key; the two branch actions that hit
 * the API (`activateBranchAction`, `renameBranchAction`) are replaced on
 * `chat-actions.js` (`...real` spread); the character controller, the confirm
 * dialog setter, the chat controller slice and the navigation callbacks are
 * plain test-local doubles; `sonner`'s `toast.info` is replaced (`...real`
 * spread) to observe the forbidden-delete explanation.
 * `BottomSheet` / `ActionSheet` run real (Base UI Drawer mounts under
 * happy-dom), so the nested ⋮ sheets are exercised as nested drawers.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { brandId, type ChatBranch, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { CharacterChatsSheetProps } from "./CharacterChatsSheet.js";
import { formatRelativeTime, formatShortDate } from "../sidebar-utils.js";
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

const toastInfo = mock((_message: string): void => {});
const realSonner = await import("sonner");
mock.module("sonner", () => ({
	...realSonner,
	toast: { ...realSonner.toast, info: toastInfo },
}));

const { CharacterChatsSheet } = await import("./CharacterChatsSheet.js");

beforeEach(() => {
	activateBranchAction.mockClear();
	renameBranchAction.mockClear();
	toastInfo.mockClear();
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

function makeBranch(id: ChatBranchId, label: string, over: Partial<ChatBranch> = {}): ChatBranch {
	return {
		id,
		chatId: CHAT_1,
		parentBranchId: null,
		forkedFromMessageId: null,
		label,
		createdAt: "2026-01-01T00:00:00Z",
		...over,
	} as ChatBranch;
}

const CHATS: readonly ChatListItem[] = [
	makeChat(CHAT_1, "Moonlit Harbor"),
	makeChat(CHAT_2, "Winter Market", { activeBranchLabel: "Alt timeline" }),
	makeChat(CHAT_3, "Harbor Revisited"),
];
const BRANCHES: readonly ChatBranch[] = [makeBranch(BR_ROOT, "Main thread"), makeBranch(BR_ALT, "Side thread", { parentBranchId: BR_ROOT })];

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
	const chat = {
		handleFork: mock(async (_messageId?: string): Promise<void> => {}),
		handleDeleteActiveBranch: mock(async (): Promise<void> => {}),
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
			chat={chat}
			setConfirmDestroy={setConfirmDestroy}
			openChatImport={openChatImport}
			onClose={onClose}
			onSwitchChat={onSwitchChat}
			onCreateChat={onCreateChat}
			{...props}
		/>,
	);
	return { ...view, character, chat, setConfirmDestroy, onClose, onSwitchChat, onCreateChat, openChatImport };
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

/** The chat ⋮ button — the row's last button (RD-2: in flow at the row's right edge, after the line-2 badge). */
function chatMenuButton(row: HTMLElement): HTMLButtonElement {
	const buttons = row.querySelectorAll<HTMLButtonElement>("button");
	const btn = buttons[buttons.length - 1];
	if (!btn) throw new Error("no chat menu button in row");
	return btn;
}

/** The branch badge — the row's button labelled `sidebar_chat_branches` (RD-2: replaces the `branch_count` text toggle). */
function branchToggle(row: HTMLElement): HTMLButtonElement | undefined {
	return row.querySelector<HTMLButtonElement>('button[aria-label="sidebar_chat_branches"]') ?? undefined;
}

/** The branches block — the dashed-top container under the active chat row. */
function branchBlock(view: View): HTMLElement {
	const block = view.baseElement.querySelector<HTMLElement>("div.border-dashed");
	if (!block) throw new Error("no branches block");
	return block;
}

/** The branch rows of the block, in order. */
function branchRows(view: View): HTMLElement[] {
	return [...branchBlock(view).querySelectorAll<HTMLElement>("div.cursor-pointer")];
}

/** The branch row (`div.cursor-pointer`) whose label span reads `label`, plus its ⋮ button (the row's only button). */
function branchRow(view: View, label: string): { row: HTMLElement; menu: HTMLButtonElement } {
	const row = branchRows(view).find((el) => el.querySelector("span.truncate")?.textContent === label);
	if (!row) throw new Error(`no branch row for "${label}"`);
	const menu = row.querySelector<HTMLButtonElement>("button");
	if (!menu) throw new Error("no branch menu button in row");
	return { row, menu };
}

/** The button containing `text` (the action buttons carry an icon + a label). */
function buttonWithText(view: View, text: string): HTMLButtonElement {
	const btn = view.getByText(text).closest("button");
	if (!btn) throw new Error(`no button for "${text}"`);
	return btn;
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
	// RD-2 (behavior change: was → now, basis: owner-approved mockup): rows were cards
	// (bg-s2/30, border on the active one) with the chat's stored subtitle as line 2; they are
	// flat now and line 2 is the flyout's «when · N msgs».
	it("lists every chat with its title; the active chat is tinted with an accent bar, the others are flat", () => {
		const view = renderSheet();
		for (const c of CHATS) expect(view.getByText(c.title)).toBeTruthy();
		const active = chatRow(view, "Moonlit Harbor");
		const other = chatRow(view, "Winter Market");
		expect(active.className).toContain("bg-accent-dim");
		expect(other.className).not.toContain("bg-accent-dim");
		// No card chrome on any row: no background tile, no border.
		for (const row of [active, other]) {
			expect(row.className).not.toContain("bg-s2/30");
			expect(/(^|\s)border(\s|-|$)/.test(row.className)).toBe(false);
		}
		// The 3px accent bar sits on the active row only.
		const bar = active.querySelector<HTMLElement>('div[class*="w-[3px]"]');
		expect(bar).toBeTruthy();
		expect(bar!.className).toContain("bg-accent");
		expect(other.querySelector('div[class*="w-[3px]"]')).toBeNull();
		// Titles: accent + medium for the active chat, text-t1 for the rest.
		const activeTitle = active.querySelector("span.truncate")!;
		expect(activeTitle.className).toContain("text-accent-t");
		expect(activeTitle.className).toContain("font-medium");
		const otherTitle = other.querySelector("span.truncate")!;
		expect(otherTitle.className).toContain("text-t1");
		expect(otherTitle.className).not.toContain("font-medium");
	});

	it("line 2 is the flyout's «relative time · N msgs»; the chat's stored subtitle is not rendered", () => {
		const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		const view = renderSheet({
			chats: [
				makeChat(CHAT_1, "Moonlit Harbor", { updatedAt: recent, messageCount: 187 }),
				makeChat(CHAT_2, "Winter Market", { messageCount: 1 }),
			],
		});
		const stamps = (title: string) => [...chatRow(view, title).querySelectorAll("span.tabular-nums")].map((s) => s.textContent);
		expect(stamps("Moonlit Harbor")).toEqual([formatRelativeTime(recent), "187 msgs_short"]);
		expect(stamps("Winter Market")).toEqual([formatRelativeTime("2026-01-01T00:00:00Z"), "1 msgs_short"]);
		expect(formatRelativeTime(recent)).not.toBe("");
		expect(view.queryByText("Moonlit Harbor subtitle")).toBeNull();
		expect(view.queryByText("Winter Market subtitle")).toBeNull();
	});

	it("sizing: rows are at least 48px tall and the ⋮ touch target is 36px; titles ellipsize", () => {
		const view = renderSheet();
		for (const c of CHATS) {
			const row = chatRow(view, c.title);
			expect(row.className).toContain("min-h-[48px]");
			const menu = chatMenuButton(row);
			expect(menu.className).toContain("h-9");
			expect(menu.className).toContain("w-9");
			expect(row.querySelector("span.truncate")!.className).toContain("min-w-0");
		}
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
	// RD-2 (behavior change: was → now, basis: owner-approved mockup): the active chat carried a
	// «N branches» text toggle and the block was COLLAPSED until tapped; now the line-2 badge
	// (icon + count) collapses / expands a block that is OPEN by default.
	it("withBranches: the active chat's line 2 ends with the count badge and the block is open by default; the badge collapses and re-expands it", () => {
		const view = renderSheet();
		const row = chatRow(view, "Moonlit Harbor");
		const badge = branchToggle(row)!;
		expect(badge).toBeTruthy();
		expect(badge.textContent?.trim()).toBe(String(BRANCHES.length));
		// The badge is the last item of the row's second line («when · N msgs [badge]»).
		expect(badge.parentElement!.lastElementChild).toBe(badge);
		expect(badge.parentElement!.textContent).toContain("msgs_short");
		// Open by default.
		expect(view.getByText("sidebar_timeline_branches")).toBeTruthy();
		expect(view.getByText("Main thread")).toBeTruthy();
		expect(view.getByText("Side thread")).toBeTruthy();
		expect(badge.getAttribute("aria-expanded")).toBe("true");
		// Collapse.
		fireEvent.click(badge);
		expect(view.queryByText("sidebar_timeline_branches")).toBeNull();
		expect(view.queryByText("Main thread")).toBeNull();
		expect(branchToggle(chatRow(view, "Moonlit Harbor"))!.getAttribute("aria-expanded")).toBe("false");
		// Expand again.
		fireEvent.click(branchToggle(chatRow(view, "Moonlit Harbor"))!);
		expect(view.getByText("Main thread")).toBeTruthy();
		// The badge never switches chats.
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});

	it("the block sits right under the active chat row and nowhere else", () => {
		const view = renderSheet();
		const row = chatRow(view, "Moonlit Harbor");
		expect(row.nextElementSibling).toBe(branchBlock(view));
		expect(view.baseElement.querySelectorAll("div.border-dashed").length).toBe(1);
	});

	it("the badge sits only under the active chat, never under inactive ones", () => {
		const view = renderSheet();
		expect(branchToggle(chatRow(view, "Moonlit Harbor"))).toBeTruthy();
		expect(branchToggle(chatRow(view, "Winter Market"))).toBeUndefined();
		expect(branchToggle(chatRow(view, "Harbor Revisited"))).toBeUndefined();
	});

	it("withBranches=false: no badge, no block, no actions even when branches are passed", () => {
		const view = renderSheet({ withBranches: false, mode: "coauthor", chat: undefined });
		expect(branchToggle(chatRow(view, "Moonlit Harbor"))).toBeUndefined();
		expect(view.queryByText("Main thread")).toBeNull();
		expect(view.queryByText("sidebar_timeline_branches")).toBeNull();
		expect(view.queryByText("sidebar_fork_short")).toBeNull();
		expect(view.queryByText("sidebar_delete_branch_short")).toBeNull();
		expect(view.baseElement.querySelector("div.border-dashed")).toBeNull();
	});

	it("no badge or block without branches, nor when the active chat is not in the list", () => {
		const empty = renderSheet({ branches: [] });
		expect(branchToggle(chatRow(empty, "Moonlit Harbor"))).toBeUndefined();
		expect(empty.baseElement.querySelector("div.border-dashed")).toBeNull();
		empty.unmount();
		const elsewhere = renderSheet({ activeChatId: brandId<ChatId>("chat-elsewhere") });
		for (const c of CHATS) expect(branchToggle(chatRow(elsewhere, c.title))).toBeUndefined();
		expect(elsewhere.baseElement.querySelector("div.border-dashed")).toBeNull();
	});

	it("an unnamed branch falls back to the unnamed label; the active branch is tinted with an accent connector", () => {
		const view = renderSheet({ branches: [...BRANCHES, makeBranch(BR_UNNAMED, "", { parentBranchId: BR_ROOT })] });
		expect(view.getByText("sidebar_unnamed_branch")).toBeTruthy();
		// RD-2 (behavior change: was → now, basis: owner-approved mockup): the active branch row was
		// bg-accent-dim/50 with a round dot; it is the flyout's full bg-accent-dim + an accent connector.
		const active = branchRow(view, "Main thread").row;
		const idle = branchRow(view, "Side thread").row;
		expect(active.className).toContain("bg-accent-dim");
		expect(idle.className).not.toContain("bg-accent-dim");
		expect(active.querySelector("div.absolute")!.className).toContain("bg-accent");
		expect(idle.querySelector("div.absolute")!.className).toContain("bg-border");
		expect(active.querySelector("span.truncate")!.className).toContain("text-accent-t");
		expect(idle.querySelector("span.truncate")!.className).not.toContain("text-accent-t");
	});

	it("the block is a flat list with a left rail, a dashed top border and roomy rows", () => {
		const view = renderSheet();
		const block = branchBlock(view);
		expect(block.className).toContain("border-t");
		expect(block.className).toContain("border-dashed");
		expect(block.className).toContain("border-border2");
		expect(block.querySelector("div.border-l-2")).toBeTruthy();
		// Rows ≥ 44px, ⋮ buttons are the 36px touch target, one connector per row.
		const rows = branchRows(view);
		expect(rows.length).toBe(BRANCHES.length);
		for (const row of rows) {
			expect(row.className).toContain("min-h-[44px]");
			expect(row.querySelectorAll("div.absolute").length).toBe(1);
			const menu = row.querySelector("button")!;
			expect(menu.className).toContain("h-9");
			expect(menu.className).toContain("w-9");
		}
	});

	it("tapping a branch row activates it for the active chat without switching chats", () => {
		const view = renderSheet();
		fireEvent.click(branchRow(view, "Side thread").row);
		expect(activateBranchAction).toHaveBeenCalledWith(CHAT_1, BR_ALT);
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});

	it("branch line 2 is «N msgs · short date», with 0 when the count is missing", () => {
		const created = "2026-05-15T12:00:00Z";
		const view = renderSheet({
			branches: [
				makeBranch(BR_ROOT, "Main thread", { messageCount: 556, createdAt: created }),
				makeBranch(BR_ALT, "Side thread", { parentBranchId: BR_ROOT, createdAt: created }),
			],
		});
		const second = (label: string) => branchRow(view, label).row.querySelectorAll("span.truncate")[1]?.textContent;
		expect(second("Main thread")).toBe(`556 msgs_short · ${formatShortDate(created)}`);
		expect(second("Side thread")).toBe(`0 msgs_short · ${formatShortDate(created)}`);
		expect(formatShortDate(created)).not.toBe("");
	});
});

describe("CharacterChatsSheet — root branch label", () => {
	/** The labels the block shows, row by row. */
	function labels(view: View): (string | null | undefined)[] {
		return branchRows(view).map((r) => r.querySelector("span.truncate")?.textContent);
	}

	it("the root branch reads «Main» when its label equals the chat's title; a side branch with the same label keeps it", () => {
		const view = renderSheet({
			branches: [
				makeBranch(BR_ROOT, "Moonlit Harbor"),
				makeBranch(BR_ALT, "Moonlit Harbor", { parentBranchId: BR_ROOT }),
			],
		});
		expect(labels(view)).toEqual(["sidebar_main_branch", "Moonlit Harbor"]);
	});

	it("the root branch keeps its own label when it differs from the chat's title", () => {
		const view = renderSheet();
		expect(labels(view)).toEqual(["Main thread", "Side thread"]);
		expect(view.queryByText("sidebar_main_branch")).toBeNull();
	});

	it("an empty root label shows the unnamed label, not «Main» (the title is not empty)", () => {
		const view = renderSheet({
			branches: [makeBranch(BR_ROOT, ""), makeBranch(BR_ALT, "Side thread", { parentBranchId: BR_ROOT })],
		});
		expect(labels(view)).toEqual(["sidebar_unnamed_branch", "Side thread"]);
	});

	it("«Main» is a display label only: renaming the root seeds the input with its stored label", () => {
		const view = renderSheet({
			branches: [makeBranch(BR_ROOT, "Moonlit Harbor"), makeBranch(BR_ALT, "Side thread", { parentBranchId: BR_ROOT })],
		});
		fireEvent.click(branchRow(view, "sidebar_main_branch").menu);
		fireEvent.click(view.getByText("sidebar_rename"));
		expect(renameInput(view)!.value).toBe("Moonlit Harbor");
	});
});

describe("CharacterChatsSheet — branch actions (fork / delete)", () => {
	it("the two actions sit under the list, side by side, each at least 44px tall", () => {
		const view = renderSheet();
		const fork = buttonWithText(view, "sidebar_fork_short");
		const del = buttonWithText(view, "sidebar_delete_branch_short");
		expect(branchBlock(view).contains(fork)).toBe(true);
		expect(fork.parentElement).toBe(del.parentElement);
		// The actions row follows the last branch row in document order.
		const lastRow = branchRows(view).at(-1)!;
		expect(lastRow.compareDocumentPosition(fork) & 4 /* following */).toBeTruthy();
		for (const btn of [fork, del]) {
			expect(btn.className).toContain("h-11");
			expect(btn.className).toContain("flex-1");
			expect(btn.querySelector("svg")).toBeTruthy();
		}
	});

	it("«Branch» forks the active chat through the chat controller (no message anchor)", () => {
		const view = renderSheet();
		fireEvent.click(buttonWithText(view, "sidebar_fork_short"));
		expect(view.chat.handleFork).toHaveBeenCalledTimes(1);
		expect(view.chat.handleFork).toHaveBeenCalledWith(undefined);
		expect(view.onSwitchChat).not.toHaveBeenCalled();
	});

	it("«Delete» on a side branch raises the flyout's confirm; confirming deletes the active branch", () => {
		const view = renderSheet({ activeBranchId: BR_ALT });
		const del = buttonWithText(view, "sidebar_delete_branch_short");
		expect(del.getAttribute("aria-disabled")).toBe("false");
		expect(del.className).not.toContain("opacity-45");
		fireEvent.click(del);
		expect(view.setConfirmDestroy).toHaveBeenCalledTimes(1);
		const dialog = view.setConfirmDestroy.mock.calls[0][0];
		expect(dialog).toMatchObject({
			title: "sidebar_delete_branch",
			body: "sidebar_delete_branch_body",
			confirmLabel: "sidebar_delete_branch",
		});
		expect(view.chat.handleDeleteActiveBranch).not.toHaveBeenCalled();
		dialog.onConfirm();
		expect(view.chat.handleDeleteActiveBranch).toHaveBeenCalledTimes(1);
		expect(toastInfo).not.toHaveBeenCalled();
	});

	it("«Delete» is muted and explains itself with a toast when the active branch is the root", () => {
		const view = renderSheet({ activeBranchId: BR_ROOT });
		const del = buttonWithText(view, "sidebar_delete_branch_short");
		expect(del.getAttribute("aria-disabled")).toBe("true");
		expect(del.className).toContain("opacity-45");
		expect(del.className).toContain("cursor-not-allowed");
		fireEvent.click(del);
		expect(toastInfo).toHaveBeenCalledTimes(1);
		expect(toastInfo).toHaveBeenCalledWith("sidebar_switch_to_non_main");
		expect(view.setConfirmDestroy).not.toHaveBeenCalled();
		expect(view.chat.handleDeleteActiveBranch).not.toHaveBeenCalled();
	});

	it("«Delete» is muted with the same toast when the chat has a single branch", () => {
		const view = renderSheet({ branches: [makeBranch(BR_ROOT, "Main thread")], activeBranchId: BR_ROOT });
		const del = buttonWithText(view, "sidebar_delete_branch_short");
		expect(del.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(del);
		expect(toastInfo).toHaveBeenCalledWith("sidebar_switch_to_non_main");
		expect(view.setConfirmDestroy).not.toHaveBeenCalled();
	});

	it("«Branch» stays enabled when «Delete» is muted", () => {
		const view = renderSheet({ activeBranchId: BR_ROOT });
		const fork = buttonWithText(view, "sidebar_fork_short");
		expect(fork.getAttribute("aria-disabled")).toBeNull();
		expect(fork.className).not.toContain("opacity-45");
	});

	it("a host that passes no chat controller gets the block without the actions row", () => {
		const view = renderSheet({ chat: undefined });
		expect(view.getByText("Main thread")).toBeTruthy();
		expect(view.queryByText("sidebar_fork_short")).toBeNull();
		expect(view.queryByText("sidebar_delete_branch_short")).toBeNull();
	});
});

describe("CharacterChatsSheet — Co-Author rows", () => {
	it("render the same flat rows (line 2, tint, bar) and none of the branch UI", () => {
		const view = renderSheet({
			mode: "coauthor",
			withBranches: false,
			chat: undefined,
			branches: [],
			activeBranchId: null,
			emptyTitleKey: "coauthor.list_empty",
		});
		const active = chatRow(view, "Moonlit Harbor");
		expect(active.className).toContain("bg-accent-dim");
		expect(active.querySelector('div[class*="w-[3px]"]')).toBeTruthy();
		expect(chatRow(view, "Winter Market").className).not.toContain("bg-accent-dim");
		expect([...active.querySelectorAll("span.tabular-nums")].map((s) => s.textContent))
			.toEqual([formatRelativeTime("2026-01-01T00:00:00Z"), "3 msgs_short"]);
		// «↳ label» still reads under the inactive chat that has one.
		expect(view.getByText("↳ Alt timeline")).toBeTruthy();
		// No badge, block, header or actions anywhere.
		for (const c of CHATS) expect(branchToggle(chatRow(view, c.title))).toBeUndefined();
		expect(view.baseElement.querySelector("div.border-dashed")).toBeNull();
		for (const key of ["sidebar_timeline_branches", "sidebar_fork_short", "sidebar_delete_branch_short"]) {
			expect(view.queryByText(key)).toBeNull();
		}
	});
});

describe("CharacterChatsSheet — inactive chat branch line", () => {
	it("an inactive chat with an active-branch label shows the arrow line", () => {
		const view = renderSheet();
		const line = view.getByText("↳ Alt timeline");
		expect(line.className).toContain("text-t4");
		expect(chatRow(view, "Winter Market").contains(line)).toBe(true);
	});

	it("the arrow line stays even when the label equals the chat's title (owner ruling: shown whenever the label exists)", () => {
		const view = renderSheet({
			chats: [
				makeChat(CHAT_1, "Moonlit Harbor"),
				makeChat(CHAT_2, "Winter Market", { activeBranchLabel: "Winter Market" }),
			],
		});
		const line = view.getByText("↳ Winter Market");
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
	/** Taps the branch's ⋮ (RD-2: the branches block is open by default, no toggle tap first). */
	function openBranchMenu(view: View, label: string) {
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
