import { useT } from "../../../i18n/context.js";
import { useStoryDeck } from "../../../hooks/use-story-deck.js";
import {
  DEFAULT_STORY_CURTAIN_TAB,
  STORY_CURTAIN_TABS,
  useStoryCurtainTabStore,
  type StoryCurtainTab,
} from "../../../stores/story-curtain-tab-store.js";
import { SegmentedControl } from "../SegmentedControl.js";

/**
 * StoryCurtainTabs (DIRECTOR_DECK_CALENDAR_PLAN DK-6, mockup §1/§7) — the
 * story curtain's SECOND header row: the SegmentedControl
 * "events N · deck N · calendar" strip (RU labels via the story_deck_tab_*
 * keys) under the DR-9 header (which stays exactly as it is). Counts are
 * muted (events = the header's remaining count, deck = cards.length,
 * calendar none — the disabled muted placeholder, DK-9 fills it). The
 * choice is remembered per chat in the plain tab store (default events —
 * the events body is today's curtain, byte-identical).
 *
 * Phone (§7): `mobileFill` — the row is full width, three equal segments on
 * one line (the mockup's budget: ≈280px < 343px). Desktop: natural inline
 * sizing.
 *
 * Mounts only while the curtain is OPEN (the panel renders the slot
 * inside the overlay) — the deck GET runs from here for the count, one
 * fetch per branch through `useStoryDeck`'s cache.
 */
export function StoryCurtainTabs({
  chatId,
  branchId,
  eventsCount,
}: {
  chatId: string;
  branchId: string;
  /** The events tab's muted count — the SAME remaining count the curtain
   *  header derives (the section passes it; never a second derivation). */
  eventsCount: number;
}) {
  const { t } = useT();
  const tab = useStoryCurtainTabStore((s) => s.tabsByChat[chatId] ?? DEFAULT_STORY_CURTAIN_TAB);
  const setTab = useStoryCurtainTabStore((s) => s.setTab);
  const { deck } = useStoryDeck(chatId, branchId);
  const countCls = "text-[calc(var(--ui-fs)-3px)] tabular-nums text-t4";
  return (
    <div data-testid="story-curtain-tabs" className="border-b border-border pb-2">
      <SegmentedControl<StoryCurtainTab>
        value={tab}
        onChange={(next) => setTab(chatId, next)}
        ariaLabel={t("story_deck_tabs_aria")}
        mobileFill
        options={[
          {
            value: STORY_CURTAIN_TABS.events,
            label: (
              <>
                {t("story_deck_tab_events")} <span className={countCls}>{eventsCount}</span>
              </>
            ),
          },
          {
            value: STORY_CURTAIN_TABS.deck,
            label: (
              <>
                {t("story_deck_tab_deck")} <span className={countCls}>{deck.cards.length}</span>
              </>
            ),
          },
          { value: STORY_CURTAIN_TABS.calendar, label: t("story_deck_tab_calendar") },
        ]}
      />
    </div>
  );
}
