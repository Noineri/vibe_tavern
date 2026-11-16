import { useCallback, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { useStoryDeck } from "../../../hooks/use-story-deck.js";
import { callDirector } from "../../../stores/sidechat-call-director-store.js";
import { Ic } from "../icons.js";
import { StoryCardBack, StoryCardFace } from "./StoryCard.js";
import { StoryCardDialog, type StoryCardDialogRequest } from "./StoryCardDialog.js";

/**
 * StoryDeckView (DIRECTOR_DECK_CALENDAR_PLAN DK-6, mockup §1/§7; the live
 * dialog is DK-7) — the story curtain's DECK tab body: the header (the
 * twist-deck title · the muted "N cards" count · the draw-random action ·
 * the refill action) over a wrap grid of card faces (132×184 desktop / two
 * per row on the phone, the mockup's width arithmetic) joined by the dashed
 * add-own-card tile.
 *
 * DK-7 wired the card actions live: a card face opens the card dialog
 * (`StoryCardDialog` — view/edit/remove/play), the draw action
 * (`story_deck_draw_random`) opens it in the draw mode (§3), the dashed
 * tile (and the empty state's muted link) open the new-card editor (§2).
 * The refill button has been live since DK-6: it runs the director-call
 * action with the deck's own message key, disabled while a sidechat turn
 * streams (the DR-12 rule the strip's call button applies).
 *
 * Empty deck (§7, both viewports, centered): two tilted card backs, the
 * title, the explanation line, the primary assemble-the-deck director call
 * and the add-own-card link. The deck header and grid are NOT drawn
 * in the empty state (§7's phone curtain: tabs → the centered block).
 *
 * Phone (§7): the header is ONLY the button row — the title group (the
 * cards glyph · the twist-deck title (story_deck_title) · the count) is
 * desktop-only (§1), hidden under max-md; nothing is lost — the tab row
 * directly above already carries the same count (the tab row's deck
 * count, StoryCurtainTabs). The two buttons take their own full-width
 * row (34 px per the mockup); the refill label switches to §7's short
 * label (story_deck_call_director_short) on the phone (the full label
 * (story_deck_call_director) + the glyph ≈187 px of content does not fit the
 * flex-1 half-row at 360–390 px — AD-022 layout arithmetic), the draw
 * label stays full (the mockup keeps it, it fits).
 */
export function StoryDeckView({
  chatId,
  branchId,
  locked,
}: {
  chatId: string;
  branchId: string;
  /** The streaming lock (a sidechat turn in flight) — the director call
   *  disables while set (the DR-12 rule); the card dialog's writes use the
   *  same prop. */
  locked: boolean;
}) {
  const { t } = useT();
  const { deck } = useStoryDeck(chatId, branchId);
  // The card dialog's open request (DK-7): a clicked card, the draw, or
  // the new-card editor.
  const [dialogRequest, setDialogRequest] = useState<StoryCardDialogRequest | null>(null);

  const callRefill = useCallback(() => {
    // The deck's own call message (DK-6's generalized callDirector param).
    void callDirector(chatId, branchId, "story_deck_call_director_message").catch(() => {
      toast.error(t("copilot_profile_assign_failed"));
    });
  }, [chatId, branchId, t]);

  return (
    <>
      {deck.cards.length === 0 ? (
        <div data-testid="story-deck-empty" className="flex flex-col items-center px-2.5 pb-2 pt-[18px] text-center">
          <div className="mb-3 flex shrink-0 justify-center">
            <StoryCardBack size="sm" className="-rotate-6" />
            <StoryCardBack size="sm" className="-ml-[60px] rotate-[5deg]" />
          </div>
          <div className="shrink-0 text-[calc(var(--ui-fs)+1px)] text-t1">{t("story_deck_empty_title")}</div>
          <p className="mb-3.5 mt-1 shrink-0 text-[calc(var(--ui-fs)-1px)] leading-normal text-t3">
            {t("story_deck_empty_hint")}
          </p>
          <button
            type="button"
            data-testid="story-deck-empty-call"
            disabled={locked}
            onClick={callRefill}
            className="flex min-h-11 w-full max-w-[280px] shrink-0 items-center justify-center rounded-md bg-accent px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 md:h-[37px]"
          >
            {t("story_deck_empty_call")}
          </button>
          <button
            type="button"
            data-testid="story-deck-empty-add"
            onClick={() => setDialogRequest({ kind: "new" })}
            className="mt-3 shrink-0 cursor-pointer text-[calc(var(--ui-fs)-1px)] text-t3 transition-colors hover:text-t1"
          >
            {t("story_deck_empty_add")}
          </button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5">
          <div data-testid="story-deck-header" className="flex w-full flex-wrap items-center gap-2">
            {/* §7: the title group is desktop-only (§1) — the phone header is
                just the buttons; the tab row above carries the same count. */}
            <span className="flex items-center gap-2 max-md:hidden">
              <Ic.cards className="shrink-0 text-accent" />
              <span className="whitespace-nowrap text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{t("story_deck_title")}</span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-t4">
                · {t("story_deck_cards_count", { count: deck.cards.length })}
              </span>
            </span>
            <div className="flex order-last w-full flex-wrap gap-2 md:order-none md:ml-auto md:w-auto">
              {/* DK-7's draw — opens the dialog face-down (§3). Drawing only
                  OPENS the dialog; the play inside carries the lock. */}
              <button
                type="button"
                data-testid="story-deck-draw"
                onClick={() => setDialogRequest({ kind: "draw" })}
                className={deckButtonCls}
              >
                <Ic.shuffle className="h-3.5 w-3.5 shrink-0" />
                {t("story_deck_draw_random")}
              </button>
              <button
                type="button"
                data-testid="story-deck-call-director"
                disabled={locked}
                onClick={callRefill}
                className={deckButtonCls}
              >
                <Ic.film className="h-3.5 w-3.5 shrink-0" />
                {/* §7's short label (story_deck_call_director_short) on the phone
                    (the full label bleeds out of the flex-1 half-row — AD-022);
                    §1's full on md+. */}
                <span className="md:hidden">{t("story_deck_call_director_short")}</span>
                <span className="hidden md:inline">{t("story_deck_call_director")}</span>
              </button>
            </div>
          </div>
          <div data-testid="story-deck-grid" className="flex flex-wrap gap-3">
            {deck.cards.map((card) => (
              // The face is the click target (§2: clicking a card opens it
              // large). The accessible name is the card's title — model
              // text, but an aria-label is the button's own name, not
              // rendered UI copy.
              <button
                key={card.id}
                type="button"
                data-testid="story-deck-card-open"
                data-card-id={card.id}
                aria-label={card.title}
                onClick={() => setDialogRequest({ kind: "card", cardId: card.id })}
                className="block cursor-pointer rounded-[14px] border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <StoryCardFace card={card} />
              </button>
            ))}
            {/* DK-7's card editor — the dashed tile opens the new-card
                editor (mockup §1 draws it in the grid). */}
            <button
              type="button"
              data-testid="story-deck-add-card"
              onClick={() => setDialogRequest({ kind: "new" })}
              className="flex h-[184px] w-[132px] shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 [&_svg]:h-5 [&_svg]:w-5 rounded-[10px] border-[1.5px] border-dashed border-border2 text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors hover:border-accent hover:text-t2 max-md:h-auto max-md:w-[calc(50%-6px)] max-md:aspect-[3/4]"
            >
              <Ic.plus />
              {t("story_deck_own_card")}
            </button>
          </div>
        </div>
      )}
      <StoryCardDialog
        chatId={chatId}
        branchId={branchId}
        locked={locked}
        request={dialogRequest}
        onClose={() => setDialogRequest(null)}
      />
    </>
  );
}

/** The deck header's compact button — the canon compact action shape at
 *  34 px on the phone (the mockup §7's drawn height), inline on desktop.
 *  forks: 1 — StoryCalendarView.tsx (cellButtonCls, the calendar tab's
 *  clock-move buttons). */
const deckButtonCls = cn(
  "flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-s3 px-2.5",
  "font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1",
  "disabled:cursor-not-allowed disabled:opacity-40",
  "max-md:h-[34px] max-md:min-w-0 max-md:flex-1 max-md:justify-center",
);
