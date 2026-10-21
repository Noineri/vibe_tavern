/**
 * RailCharacterBrowser — the phone rail drawer's body (header + scrolling
 * content; the host keeps its own bottom quick-actions panel): the RP rail in
 * play mode and the Co-Author rail mount this same component. Two screens,
 * mockup `RAIL_DRILL_IN_mockups/rail-drill-in.html` (owner-approved):
 *
 *  - Screen 1 «characters»: header (hamburger, title, «+» create, import icon),
 *    the search + sort + tag-filter row, and one row per character — avatar,
 *    name, «N chats · when», a chevron. Tapping a row selects the character
 *    (`setSelectedCharacterId`, as the old row did) and opens its screen 2.
 *  - Screen 2 «one character's chats»: header (back, avatar, name, «+» new chat
 *    for THIS character, ⋮ the character menu) over `CharacterChatsPanel` — the
 *    one implementation the tablet sheet renders too.
 *
 * Navigation: the drawer opens on screen 2 of the ACTIVE CHAT's character when
 * there is an active chat, else on screen 1 — re-applied on every open (the
 * `open` false→true edge, also while the closing drawer is still mounted).
 * Back returns to screen 1. Which screen shows lives here; everything the
 * screen-1 controls edit (search query, tag selection, the tag sheet) lives in
 * the host and survives a close/open of the drawer, and so does the sort mode
 * (navigation store).
 *
 * «N chats · when» is `summarizeChatsByCharacter` over the SAME mode bucket
 * `useSidebarChats` hands the panel (`sectionChats`, unscoped, no query) — the
 * count equals the rows the character's screen lists, with no second mode rule
 * here.
 *
 * Presentational otherwise: the host owns the sheets (character menu, tag
 * filter), the import pickers and the controllers, and passes callbacks.
 * Mode parameters (`mode`, `withBranches`, `emptyTitleKey`, `chat`) are the host's:
 * the Co-Author rail passes its own — no branches, no `chat`, its chats only.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import type { ChatBranch, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { ListSortToggle } from "../../shared/ListSortToggle.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import { useChatStore, useNavigationStore } from "../../../stores/index.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { initials } from "../app-shell-helpers.js";
import { useSidebarChats } from "../hooks/use-sidebar-chats.js";
import { formatRelativeTime, summarizeCharacterChats, summarizeChatsByCharacter, tabAvatarSrc, type CharacterChatsSummary } from "../sidebar-utils.js";
import type { CharacterTab } from "../app-shell-types.js";
import { CharacterChatsPanel } from "./character-chats-panel.js";
import type { BranchActionsController } from "./character-chats-branches.js";

/** The slice of a character the browser reads — a list entry or a tab both fit. */
export type RailBrowserCharacter = Pick<CharacterTab, "id" | "name" | "avatarAssetId" | "avatarExt" | "updatedAt">;

/** The screen-1 filter row's state. The host owns it (it must outlive the drawer's mount) and the tag sheet. */
export interface RailCharacterFilters {
	query: string;
	onQueryChange: (query: string) => void;
	/** How many tags the filter sheet has selected (drives the badge). */
	tagCount: number;
	tagsSheetOpen: boolean;
	onOpenTags: () => void;
}

export interface RailCharacterBrowserProps {
	/** The drawer is open — every false→true edge re-applies the opening rule. */
	open: boolean;
	/** The ACTIVE CHAT's character (null without an active chat) — the screen the drawer opens on. */
	activeCharacterId: string | null;
	/** Every character — the screen-2 header looks its character up here, so a search that hides it does not matter. */
	characters: readonly RailBrowserCharacter[];
	/** The searched, tag-filtered, sorted list screen 1 renders. */
	visibleCharacters: readonly RailBrowserCharacter[];
	/** Every chat (`useChatList()` — the sidebar list, independent of any active chat); the browser buckets it by mode itself. */
	chats: readonly ChatListItem[];
	selectedCharacterId: string | null;
	activeChatId: ChatId | null;
	/** Branches of the ACTIVE chat only (empty otherwise). */
	branches: readonly ChatBranch[];
	activeBranchId: ChatBranchId | null;
	filters: RailCharacterFilters;
	/** The hamburger — closes the drawer. */
	onClose: () => void;
	onCreateCharacter: () => void;
	onImportCharacter: () => void;
	/** Opens the host's character ⋮ sheet. */
	onOpenCharacterMenu: (characterId: string) => void;
	// ── screen 2 / the panel (same parameters as the tablet sheet) ──
	mode: "rp" | "coauthor";
	withBranches: boolean;
	emptyTitleKey: string;
	character: CharacterControllerActions;
	chat?: BranchActionsController;
	setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
	openChatImport: () => void;
	onSwitchChat: (id: ChatId) => void;
	/** New chat for the given character (screen-2 header «+» and the panel's empty state). */
	onCreateChat: (characterId: string) => void;
}

const NO_CHATS: CharacterChatsSummary = summarizeCharacterChats([]);

export function RailCharacterBrowser(props: RailCharacterBrowserProps) {
	const { open, activeCharacterId } = props;
	// Which character's screen is showing; null = screen 1. Seeded for the first
	// open; re-seeded on every false→true edge of `open` (state adjusted during
	// render, so the first painted frame is already the right screen).
	const [screenCharacterId, setScreenCharacterId] = useState<string | null>(open ? activeCharacterId : null);
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setScreenCharacterId(activeCharacterId);
	}

	// A character that vanished (deleted from its own ⋮ menu) falls back to screen 1.
	const screenCharacter = screenCharacterId ? props.characters.find((c) => c.id === screenCharacterId) ?? null : null;

	if (screenCharacter) {
		return <CharacterScreen key={screenCharacter.id} {...props} screenCharacter={screenCharacter} onBack={() => setScreenCharacterId(null)} />;
	}
	return (
		<CharactersScreen
			{...props}
			onOpenCharacter={(id) => {
				useChatStore.getState().setSelectedCharacterId(id);
				setScreenCharacterId(id);
			}}
		/>
	);
}

// ── Screen 1 ─────────────────────────────────────────────────────────────

interface CharactersScreenProps extends RailCharacterBrowserProps {
	onOpenCharacter: (characterId: string) => void;
}

function CharactersScreen({
	visibleCharacters, chats, selectedCharacterId, filters,
	onClose, onCreateCharacter, onImportCharacter, onOpenCharacter,
}: CharactersScreenProps) {
	const { t } = useT();
	const characterSortMode = useNavigationStore((s) => s.characterSortMode);
	const setCharacterSortMode = useNavigationStore((s) => s.setCharacterSortMode);

	// The mode bucket the character screens list, unscoped — one pass per character.
	const { sectionChats: bucketChats } = useSidebarChats({ allChats: chats, characterId: null, query: "" });
	const summaries = useMemo(() => summarizeChatsByCharacter(bucketChats), [bucketChats]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Header — the drawer's 48px row: hamburger, title, «+» and import */}
			<div className="flex h-[48px] shrink-0 items-center border-b border-border px-3">
				<div className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3" onClick={onClose}>
					<Ic.menu />
				</div>
				<Drawer.Title className="ml-2 min-w-0 flex-1 whitespace-nowrap font-ui text-[calc(var(--ui-fs)+1px)] font-semibold tracking-tight text-t1">
					{t("characters")}
				</Drawer.Title>
				<div className="flex shrink-0 gap-1.5">
					<HeaderButton accent label={t("create_manual")} onClick={onCreateCharacter}><Ic.plus /></HeaderButton>
					<HeaderButton label={t("import_char_short")} onClick={onImportCharacter}><Ic.import /></HeaderButton>
				</div>
			</div>

			{/* Search + sort + tag-filter row. No section header on mobile — just the
			    controls, compact. Tags open a bottom sheet (the host's TagFilterSheet). */}
			<div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
				<SearchInput
					className="min-w-0 flex-1"
					value={filters.query}
					onChange={(e) => filters.onQueryChange(e.target.value)}
					placeholder={t("search_name_placeholder")}
				/>
				<ListSortToggle mode={characterSortMode} onChange={setCharacterSortMode} className="shrink-0" />
				<div className="relative shrink-0">
					<button
						type="button"
						className={cn(
							"flex h-[30px] w-8 items-center justify-center rounded border bg-s2 transition-colors active:bg-s3",
							filters.tagsSheetOpen || filters.tagCount > 0 ? "border-accent text-accent-t" : "border-border text-t3",
						)}
						onClick={filters.onOpenTags}
						aria-label={t("filter_by_tags")}
					>
						<Ic.filter />
					</button>
					{filters.tagCount > 0 && (
						<span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-ui text-[9px] font-bold text-on-accent">
							{filters.tagCount}
						</span>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
				{visibleCharacters.length === 0 && (
					<div className="px-3 py-6 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
						{t("search_no_results")}
					</div>
				)}
				{visibleCharacters.map((c) => {
					const selected = selectedCharacterId === c.id;
					const avatarSrc = tabAvatarSrc(c);
					return (
						<button
							key={c.id}
							type="button"
							className={cn(
								"flex min-h-[48px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] active:bg-s3",
								selected && "bg-s2",
							)}
							onClick={() => onOpenCharacter(c.id)}
						>
							<span className={cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg", selected ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
								{avatarSrc ? <img className="h-full w-full object-cover" src={avatarSrc} alt={c.name} /> : initials(c.name)}
							</span>
							{/* Name = user data (ellipsizes); line 2 = authored copy (wraps, never cut). */}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-ui text-[calc(var(--ui-fs)-1px)] text-t1">{c.name}</span>
								<span className="font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t3">{summaryLine(t, summaries.get(c.id) ?? NO_CHATS)}</span>
							</span>
							<span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-t4">{Ic.caret("r")}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** «N chats · when», or «No chats» (no time) for a character without any. */
function summaryLine(t: TFunc, summary: CharacterChatsSummary): string {
	if (summary.count === 0) return t("rail_no_chats");
	const count = t("chat_count", { count: summary.count });
	const when = formatRelativeTime(summary.newestUpdatedAt);
	return when ? `${count} · ${when}` : count;
}

// ── Screen 2 ─────────────────────────────────────────────────────────────

interface CharacterScreenProps extends RailCharacterBrowserProps {
	screenCharacter: RailBrowserCharacter;
	onBack: () => void;
}

function CharacterScreen({
	screenCharacter, chats, activeChatId, branches, activeBranchId,
	mode, withBranches, emptyTitleKey, character, chat, setConfirmDestroy, openChatImport,
	onBack, onOpenCharacterMenu, onSwitchChat, onCreateChat,
}: CharacterScreenProps) {
	const { t } = useT();
	// This character's rows — the same derivation the screen-1 count reads, scoped.
	const { sectionChats } = useSidebarChats({ allChats: chats, characterId: screenCharacter.id, query: "" });
	const avatarSrc = tabAvatarSrc(screenCharacter);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Header — back, avatar, name, «+» new chat for this character, ⋮ its menu */}
			<div className="flex h-[48px] shrink-0 items-center gap-2 border-b border-border px-3">
				<button
					type="button"
					className="relative flex h-[30px] w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors before:absolute before:-inset-x-2.5 before:-inset-y-[7px] before:content-[''] active:bg-s3"
					aria-label={t("back")}
					onClick={onBack}
				>
					{Ic.caret("l")}
				</button>
				<span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-s3 font-ui text-[calc(var(--ui-fs)-4px)] text-t2">
					{avatarSrc ? <img className="h-full w-full object-cover" src={avatarSrc} alt={screenCharacter.name} /> : initials(screenCharacter.name)}
				</span>
				<Drawer.Title className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)+0px)] font-semibold tracking-tight text-t1" title={screenCharacter.name}>
					{screenCharacter.name}
				</Drawer.Title>
				<div className="flex shrink-0 gap-1.5">
					<HeaderButton accent label={t("new_chat")} onClick={() => onCreateChat(screenCharacter.id)}><Ic.plus /></HeaderButton>
					<HeaderButton label={t("sidebar_character_actions")} onClick={() => onOpenCharacterMenu(screenCharacter.id)}><Ic.ellipsis /></HeaderButton>
				</div>
			</div>

			{/* Body — the panel (chat search, chats, branches, ⋮ menus). A flex column that
			    does not scroll itself: the panel's search stays pinned and its list ("fill")
			    takes the remaining height and scrolls. */}
			<div className="flex min-h-0 flex-1 flex-col pt-2">
				<CharacterChatsPanel
					chats={sectionChats}
					activeChatId={activeChatId}
					branches={branches}
					activeBranchId={activeBranchId}
					withBranches={withBranches}
					emptyTitleKey={emptyTitleKey}
					mode={mode}
					character={character}
					chat={chat}
					setConfirmDestroy={setConfirmDestroy}
					openChatImport={openChatImport}
					onSwitchChat={onSwitchChat}
					onCreateChat={() => onCreateChat(screenCharacter.id)}
					listSizing="fill"
				/>
			</div>
		</div>
	);
}

// ── Shared header chrome ─────────────────────────────────────────────────

/** 30px header icon button (the mockup's size) with a 44px hit area; `accent` = the outlined «+». */
function HeaderButton({ label, accent, onClick, children }: { label: string; accent?: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			className={cn(
				"relative flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-md border bg-s2 transition-colors before:absolute before:-inset-[7px] before:content-[''] active:bg-s3",
				accent ? "border-accent/40 text-accent-t" : "border-border text-t3",
			)}
			aria-label={label}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
