/**
 * CollapsedCharacterStrip — the scrollable avatar column shown in the collapsed
 * sidebar. Shared by the RP `Sidebar` and `CoauthorSidebar` (E2, post-SF-4
 * dedup). 100% identical JSX between the two — each avatar toggles a flyout
 * (the flyout itself is extracted separately as `SidebarFlyout` / E4 because
 * it is mode-parameterized).
 *
 * The outer collapsed wrapper (`flex min-h-0 flex-1 flex-col items-center`),
 * the divider, and the mode-specific launcher (modules vs prompt+persona) stay
 * inline in each sidebar — only the reusable avatar list lives here.
 */
import type { RefObject } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import { initials } from "../app-shell-helpers.js";
import { tabAvatarSrc } from "../sidebar-utils.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import type { CharacterTab } from "../app-shell-types.js";

export function CollapsedCharacterStrip({
  characterTabs,
  activeChatCharacterId,
  activeChatId,
  flyoutCharId,
  flyoutAvatarRefs,
  setFlyoutAvatarPos,
  setFlyoutCharId,
}: {
  characterTabs: readonly CharacterTab[];
  activeChatCharacterId: string | undefined;
  activeChatId: ChatId | null;
  flyoutCharId: string | null;
  flyoutAvatarRefs: RefObject<Map<string, HTMLDivElement>>;
  setFlyoutAvatarPos: (pos: { top: number; bottom: number } | null) => void;
  setFlyoutCharId: (updater: (prev: string | null) => string | null) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-2 px-[7px]">
      {characterTabs.map((tab) => {
        const isMarked = tab.id === activeChatCharacterId || tab.chatId === activeChatId;
        return (
          <CustomTooltip key={tab.id} content={tab.name} side="right">
            <div
              ref={(el) => { if (el) flyoutAvatarRefs.current.set(tab.id, el); else flyoutAvatarRefs.current.delete(tab.id); }}
              className={cn(
                'relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-150',
                isMarked ? '' : 'hover:bg-s2',
              )}
              onClick={() => {
                // Flyout toggle only — selectedCharacterId is synced after a real chat switch.
                const r = flyoutAvatarRefs.current.get(tab.id)?.getBoundingClientRect();
                setFlyoutAvatarPos(r ? { top: r.top, bottom: r.bottom } : null);
                setFlyoutCharId(prev => prev === tab.id ? null : tab.id);
              }}
            >
              {/* Pill-индикатор для активного персонажа */}
              {isMarked && (
                <div className="absolute -left-[7px] top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-accent transition-all" />
              )}
              <span className={cn(
                'flex h-full w-full items-center justify-center overflow-hidden rounded-full font-ui text-sm',
                tabAvatarSrc(tab) ? 'bg-s3' : isMarked ? 'bg-accent text-on-accent' : 'bg-s3 text-t2',
                flyoutCharId === tab.id
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                  : (!tabAvatarSrc(tab) && isMarked) ? 'ring-1 ring-accent/50 ring-offset-2 ring-offset-surface' : '',
              )}>
                {tabAvatarSrc(tab) ? <img src={tabAvatarSrc(tab)!} alt={tab.name} className="h-full w-full object-cover" /> : initials(tab.name)}
              </span>
            </div>
          </CustomTooltip>
        );
      })}
    </div>
  );
}
