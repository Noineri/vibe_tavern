/**
 * ChatListSection — shared scaffolding for the RP and co-author chat lists.
 *
 * Owns the invariant list chrome that `Sidebar` (RP) and `CoauthorSidebar`
 * (co-author) duplicated byte-identically: the `<section>` shell, the
 * `<ListSectionHeader/>` slot, and the two empty-state branches (no chats at
 * all / no chats match the search). The row body is the deliberate fork between
 * the two surfaces, so it is injected via `renderRow` rather than selected by a
 * variant flag — the fork is the design, not duplication to merge away.
 *
 * `sectionChats` IS the filtered list both callers previously mapped: verified
 * that `useSidebarChats` returns `sectionChats` as the exact same reference as
 * `rpVisibleChats` / `coauthorVisibleChats` for the active nav mode, so mapping
 * it here is equivalent to the inline `.map` it replaces. `chats` is the
 * unfiltered character-scoped list, used only to distinguish "no chats at all"
 * from "no chats match the search".
 *
 * Two empty-state keys are passed separately because the surfaces genuinely
 * differ: RP shows `search_no_results` for the no-match branch; co-author reuses
 * `coauthor.list_empty` for both. This divergence is preserved as-is (not
 * unified) — choosing one wording is a UX call, outside this refactor's scope.
 */
import type { ReactNode } from "react";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { useT } from "../../../i18n/context.js";
import type Resources from "../../../i18n/resources.js";

export interface ChatListSectionProps {
	/** The `<section>` element className — differs: RP `flex-1`, co-author `max-h-[50%]`. */
	readonly sectionClassName: string;
	/** The `<ListSectionHeader/>` (caller renders it with its own title/sort/import/create props). */
	readonly header: ReactNode;
	/** Character-scoped chat list (drives the "no chats at all" branch). */
	readonly chats: readonly ChatListItem[];
	/** Filtered subset for the active mode — mapped into rows, and drives the "no match" branch. */
	readonly sectionChats: readonly ChatListItem[];
	/** The active chat id, used to flag the active row. */
	readonly activeChatId: ChatListItem["id"] | null;
	/** i18n key shown when `chats` is empty (RP `sidebar_send_a_message`; co-author `coauthor.list_empty`). */
	readonly emptyAllKey: keyof Resources["en"];
	/** i18n key shown when `chats` is non-empty but `sectionChats` is empty (RP `search_no_results`; co-author `coauthor.list_empty`). */
	readonly emptyFilteredKey: keyof Resources["en"];
	/** Row factory — receives the chat item and its active flag. The fork between RP and co-author rows lives here. */
	readonly renderRow: (chatItem: ChatListItem, isActive: boolean) => ReactNode;
}

export function ChatListSection({
	sectionClassName,
	header,
	chats,
	sectionChats,
	activeChatId,
	emptyAllKey,
	emptyFilteredKey,
	renderRow,
}: ChatListSectionProps) {
	const { t } = useT();
	return (
		<section className={sectionClassName}>
			{header}
			{chats.length === 0 ? (
				<div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">{t(emptyAllKey)}</div>
			) : sectionChats.length === 0 ? (
				<div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">{t(emptyFilteredKey)}</div>
			) : (
				sectionChats.map((chatItem) => renderRow(chatItem, chatItem.id === activeChatId))
			)}
		</section>
	);
}
