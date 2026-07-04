/**
 * RailCollapsedStrip — the shared middle of the collapsed mobile rail: the
 * Create/Import buttons, the character avatar column (max 5 + N-more), the
 * chat indicators for the active character, and the +new-chat button.
 * Shared by the RP `Rail` (play mode only) and `CoauthorRail` (E5e).
 *
 * What stays inline in each rail:
 *  - the build-mode middle icons (`buildPanels.map`) — RP-only, no coauthor
 *    counterpart;
 *  - the bottom quick-actions row — the launchers differ (RP: prompt-manager
 *    + scenario-memory + provider + tweaks; coauthor: modules + provider +
 *    tweaks);
 *  - the outer wrapper, hamburger, and edge-swipe handlers.
 *
 * The single real divergence — the mode passed to `handleCreateChat` when
 * starting a new chat from the collapsed rail — is parameterized via
 * `onCreateChat`: RP omits the mode arg (defaults to an RP chat), coauthor
 * forwards `"coauthor"`.
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

export interface RailCollapsedChat<TId extends string = string> {
  id: TId;
  title: string;
}

export function RailCollapsedStrip<TChatId extends string>({
  characters,
  selectedCharacterId,
  avatarSrc,
  chats,
  activeChatId,
  createManualLabel,
  importCharShortLabel,
  moreCharactersLabel,
  newChatLabel,
  onSelectCharacter,
  onSwitchChat,
  onCreateChat,
  onCreateCharacter,
  onImport,
  onMoreCharacters,
}: {
  characters: ReadonlyArray<RailCollapsedCharacter>;
  selectedCharacterId: string | null;
  avatarSrc: (c: RailCollapsedCharacter) => string | null;
  chats: ReadonlyArray<RailCollapsedChat<TChatId>>;
  activeChatId: TChatId | null;
  createManualLabel: string;
  importCharShortLabel: string;
  moreCharactersLabel: string;
  newChatLabel: string;
  onSelectCharacter: (id: string) => void;
  onSwitchChat: (id: TChatId) => void;
  onCreateChat: () => void;
  onCreateCharacter: () => void;
  onImport: () => void;
  onMoreCharacters: () => void;
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
      {/* Character avatars (max 5, +N more) — always all characters,
          not the filtered list, so the collapsed rail stays stable
          regardless of any active search in the expanded panel. */}
      {characters.slice(0, 5).map((c) => (
        <div
          key={c.id}
          className={cn(
            "flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-[background-color,border-radius,transform] duration-150 ease-out active:rounded-xl active:bg-s2 active:scale-[0.96]",
            selectedCharacterId === c.id && "rounded-xl bg-accent-dim ring-2 ring-accent",
          )}
          onClick={() => onSelectCharacter(c.id)}
          title={c.name}
        >
          {avatarSrc(c) ? (
            <img className="h-full w-full object-cover" src={avatarSrc(c)!} alt={c.name} />
          ) : (
            <span className={cn("flex h-full w-full items-center justify-center rounded-full font-ui text-sm", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>{initials(c.name)}</span>
          )}
        </div>
      ))}
      {characters.length > 5 && (
        <div
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-s3 font-ui text-[11px] font-medium text-t2 transition-[background-color,border-radius,transform] duration-150 ease-out active:rounded-xl active:bg-s2 active:scale-[0.96]"
          onClick={onMoreCharacters}
          title={moreCharactersLabel}
        >
          +{characters.length - 5}
        </div>
      )}
      <div className="my-0.5 h-px w-8 shrink-0 bg-border" />
      {/* Chat indicators for active character */}
      {chats.map((ch) => {
        const initial = (ch.title || "?").trim().charAt(0).toUpperCase() || "?";
        return (
          <div key={ch.id}
               className={cn(
                 "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full font-ui text-xs font-medium transition-all duration-150 active:rounded-xl active:bg-s2",
                 ch.id === activeChatId ? "rounded-xl bg-accent text-on-accent" : "bg-s3 text-t2",
               )}
               onClick={() => onSwitchChat(ch.id)}
               title={ch.title}>
            {initial}
          </div>
        );
      })}
      {/* + New chat in collapsed rail */}
      <div
        key="new-chat-collapsed"
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-border2 text-t3 transition-all active:bg-s3"
        onClick={onCreateChat}
        title={newChatLabel}
      >
        <Ic.plus />
      </div>
      <div className="my-0.5 h-px w-8 shrink-0 bg-border" />
    </>
  );
}
