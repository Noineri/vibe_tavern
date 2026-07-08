/**
 * RailCollapsedStrip — the shared middle of the collapsed mobile/tablet rail:
 * the Create/Import buttons and the character avatar column — every
 * character, not a capped subset (the parent is overflow-y-scroll, so a long
 * roster scrolls). Shared by the RP `Rail` (play mode only) and
 * `CoauthorRail` (E5e).
 *
 * Chat selection no longer lives here — the collapsed strip is a pure
 * character switcher / launcher. Tapping an avatar opens a `CharacterChatsSheet`
 * (tablet bottom sheet listing that character's chats + branches); the rail's
 * chat circles were removed when that sheet landed. The expanded 260px panel
 * still carries the full character/chat/branch tree for search + sort +
 * tag-filter; this collapsed strip is the quick-launch surface.
 *
 * What stays inline in each rail:
 *  - the build-mode middle icons (`buildPanels.map`) — RP-only, no coauthor
 *    counterpart;
 *  - the bottom quick-actions row — the launchers differ (RP: prompt-manager
 *    + scenario-memory + provider + tweaks; coauthor: modules + provider +
 *    tweaks);
 *  - the outer wrapper, hamburger, and the `Drawer.SwipeArea` edge-swipe.
 *
 * Generic over the chat-id brand (`TChatId`) so callers can pass branded
 * `ChatId` lists and receive branded ids in `onSwitchChat` without a cast —
 * `handleSwitchChat(chatId: ChatId)` typechecks directly. Character ids stay
 * plain strings: `setSelectedCharacterId` takes `string | null`.
 */
import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { initials } from "../app-shell-helpers.js";

export interface RailCollapsedCharacter {
  id: string;
  name: string;
  avatarExt: string | null;
  avatarAssetId: string | null;
  updatedAt?: string | null;
}

export function RailCollapsedStrip({
  characters,
  selectedCharacterId,
  avatarSrc,
  createManualLabel,
  importCharShortLabel,
  onCharacterClick,
  onCreateCharacter,
  onImport,
}: {
  characters: ReadonlyArray<RailCollapsedCharacter>;
  selectedCharacterId: string | null;
  avatarSrc: (c: RailCollapsedCharacter) => string | null;
  createManualLabel: string;
  importCharShortLabel: string;
  /** Tap an avatar — opens the CharacterChatsSheet on that character. */
  onCharacterClick: (id: string) => void;
  onCreateCharacter: () => void;
  onImport: () => void;
}): ReactNode {
  return (
    <>
      {/* Create + Import */}
      <div className="flex w-full flex-col gap-1 px-2">
        <div className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg text-t3 transition-colors active:bg-s3"
             onClick={onCreateCharacter}
             title={createManualLabel}>
          <Ic.plus />
        </div>
        <div className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg text-t3 transition-colors active:bg-s3"
             onClick={onImport}
             title={importCharShortLabel}>
          <Ic.import />
        </div>
      </div>
      <div className="h-px w-8 shrink-0 bg-border" />
      {/* Character avatars — always ALL characters (not the filtered
          list), so the collapsed rail stays stable regardless of any active
          search in the expanded panel. The strip's parent is
          overflow-y-scroll, so a long roster scrolls. Tapping an avatar opens
          the CharacterChatsSheet (chat list + branches), not a bare character
          select — selectedCharacterId is synced after the real chat switch
          inside the sheet. */}
      {characters.map((c) => (
        <div
          key={c.id}
          className={cn(
            "flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-[background-color,border-radius,transform] duration-150 ease-out active:rounded-xl active:bg-s2 active:scale-[0.96]",
            selectedCharacterId === c.id && "rounded-xl bg-accent-dim ring-2 ring-accent",
          )}
          onClick={() => onCharacterClick(c.id)}
          title={c.name}
        >
          {avatarSrc(c) ? (
            <img className="h-full w-full object-cover" src={avatarSrc(c)!} alt={c.name} />
          ) : (
            <span className={cn("flex h-full w-full items-center justify-center rounded-full font-ui text-sm", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>{initials(c.name)}</span>
          )}
        </div>
      ))}
    </>
  );
}
