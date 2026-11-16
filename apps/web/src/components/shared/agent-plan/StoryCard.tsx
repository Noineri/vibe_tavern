import type { ReactElement } from "react";
import type { StoryCard as StoryCardData } from "@vibe-tavern/api-contracts";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import type Resources from "../../../i18n/resources.js";
import { Ic } from "../icons.js";

/**
 * StoryCard (DIRECTOR_DECK_CALENDAR_PLAN DK-6, mockup §1) — a twist card's
 * FACE: suit chip top (glyph + label), the tone-tinted art zone (the suit
 * glyph), the title in the RP font (`font-body` — the message font, the
 * mockup's `--rp`), the body clamped to three lines (the mockup's
 * identification-context rule: the full text is one click away in the DK-7
 * dialog — sanctioned, not truncation), and the rotated corner glyph. The
 * card's bottom suit accent IS the corner glyph (the mockup draws no
 * separate bottom band).
 *
 * Every tone rides the theme's tokens (plan ruling K1 — threat=danger,
 * encounter=info, discovery=success, mystery=warning, change=accent): the suit
 * map below is the ONE place deriving a suit into its tone classes, label
 * key and glyph — every suit consumer reads this map and only renders it.
 * The mockup's hexes are never hardcoded.
 *
 * Sizes (mockup §1/§2/§4): `grid` 132×184 — the deck grid's compact face,
 * two cards per row on the phone (column width, `aspect-[3/4]`); `sm`
 * 96×134 — the proposal fan's compact face (DK-8); `big` 300×420 — the
 * DK-7 dialog's open face. Titles and bodies are MODEL text, so they opt
 * into page translation (the plan panel's `translate="yes"` rule,
 * 2026-10-24).
 */

/** Suit → { i18n label key, glyph, tone classes } — the ONE derivation (K1). */
export const STORY_CARD_SUIT_META = {
  threat: {
    labelKey: "story_deck_suit_threat",
    Glyph: Ic.flame,
    textCls: "text-danger-text",
    dimBgCls: "bg-danger-dim",
    dimBorderCls: "border-danger-dim",
  },
  encounter: {
    labelKey: "story_deck_suit_encounter",
    Glyph: Ic.users,
    textCls: "text-info-text",
    dimBgCls: "bg-info-dim",
    dimBorderCls: "border-info-dim",
  },
  discovery: {
    labelKey: "story_deck_suit_discovery",
    Glyph: Ic.key,
    textCls: "text-success-text",
    dimBgCls: "bg-success-dim",
    dimBorderCls: "border-success-dim",
  },
  mystery: {
    labelKey: "story_deck_suit_mystery",
    Glyph: Ic.eye,
    textCls: "text-warning-text",
    dimBgCls: "bg-warning-dim",
    dimBorderCls: "border-warning-dim",
  },
  change: {
    labelKey: "story_deck_suit_change",
    Glyph: Ic.cloudStorm,
    textCls: "text-accent-t",
    dimBgCls: "bg-accent-dim",
    dimBorderCls: "border-accent-dim",
  },
} as const satisfies Record<
  StoryCardData["suit"],
  {
    labelKey: keyof Resources["en"];
    Glyph: (props?: { className?: string }) => ReactElement;
    textCls: string;
    dimBgCls: string;
    dimBorderCls: string;
  }
>;

export type StoryCardSuitName = StoryCardData["suit"];

export type StoryCardSize = "grid" | "sm" | "big";

/** The face's per-size geometry (mockup §1 `.sc`, `.sc.sm`, `.sc.big`) —
 *  each branch carries the WHOLE class set for its concern, so no two
 *  branches fight (cn is join-only; conflicting utilities coexist). */
const CARD_CLS: Record<
  StoryCardSize,
  { card: string; frame: string; chip: string; chipGlyph: string; art: string; artGlyph: string; title: string; body: string; corner: string }
> = {
  grid: {
    card: "h-[184px] w-[132px] rounded-[10px] max-md:h-auto max-md:w-[calc(50%-6px)] max-md:aspect-[3/4]",
    frame: "inset-1 rounded-[7px]",
    chip: "px-2.5 pt-[9px] text-[calc(var(--ui-fs)-4px)]",
    chipGlyph: "h-3.5 w-3.5",
    art: "mx-2.5 mt-2 h-11 max-md:h-[60px]",
    artGlyph: "h-6 w-6",
    title: "px-2.5 pt-2 text-[calc(var(--ui-fs))]",
    body: "px-2.5 pt-1 text-[calc(var(--ui-fs)-3px)] leading-snug line-clamp-3",
    corner: "bottom-[7px] right-[9px] h-3 w-3",
  },
  sm: {
    card: "h-[134px] w-24 rounded-[10px]",
    frame: "inset-1 rounded-[7px]",
    chip: "px-2 pt-[7px] text-[calc(var(--ui-fs)-5px)]",
    chipGlyph: "h-3.5 w-3.5",
    art: "mx-2 mt-1.5 h-7",
    artGlyph: "h-[17px] w-[17px]",
    title: "px-2 pt-1.5 text-[calc(var(--ui-fs)-2px)]",
    body: "px-2 pt-[3px] text-[calc(var(--ui-fs)-4px)] leading-snug line-clamp-2",
    corner: "bottom-[7px] right-[9px] h-3 w-3",
  },
  big: {
    card: "h-[420px] w-[300px] rounded-[14px]",
    frame: "inset-1.5 rounded-[10px]",
    chip: "px-5 pt-[18px] text-[calc(var(--ui-fs)-2px)]",
    chipGlyph: "h-[18px] w-[18px]",
    art: "mx-5 mt-3.5 h-[110px]",
    artGlyph: "h-[54px] w-[54px]",
    title: "px-5 pt-4 text-[calc(var(--ui-fs)+8px)]",
    body: "px-5 pt-2 text-[calc(var(--ui-fs))] leading-normal text-t2",
    corner: "bottom-3 right-4 h-[18px] w-[18px]",
  },
};

export function StoryCardFace({
  card,
  size = "grid",
  className,
}: {
  card: StoryCardData;
  size?: StoryCardSize;
  className?: string;
}) {
  const { t } = useT();
  const meta = STORY_CARD_SUIT_META[card.suit];
  const cls = CARD_CLS[size];
  return (
    <div
      data-testid="story-card"
      data-suit={card.suit}
      data-card-id={card.id}
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border border-border2 bg-bg shadow-sm",
        cls.card,
        className,
      )}
    >
      {/* The mockup's `::before` inner frame — tinted by the suit's dim tone. */}
      <span aria-hidden className={cn("pointer-events-none absolute border", cls.frame, meta.dimBorderCls)} />
      {/* Suit chip — glyph + uppercase label, the suit's text tone. */}
      <div className={cn("flex shrink-0 items-center gap-1 font-semibold uppercase tracking-[0.06em]", cls.chip, meta.textCls)}>
        <meta.Glyph className={cn("shrink-0", cls.chipGlyph)} />
        {t(meta.labelKey)}
      </div>
      {/* The art zone — the suit glyph on the dim tint. */}
      <div className={cn("flex shrink-0 items-center justify-center rounded-md", cls.art, meta.dimBgCls, meta.textCls)}>
        <meta.Glyph className={cn("shrink-0", cls.artGlyph)} />
      </div>
      {/* Title — the RP font (`font-body`), model text → translate=yes. */}
      <div translate="yes" className={cn("shrink-0 whitespace-pre-wrap font-body leading-tight text-t1", cls.title)}>
        {card.title}
      </div>
      {/* Body — clamped to three lines (two on sm) in the grid sizes; the
          big (dialog) face shows the full body. */}
      {card.body !== "" && (
        <p translate="yes" className={cn("whitespace-pre-wrap text-t3", cls.body)}>
          {card.body}
        </p>
      )}
      {/* Corner glyph — the same suit glyph, rotated, bottom-right (the
          card's bottom suit accent). */}
      <span aria-hidden className={cn("absolute rotate-180", cls.corner, meta.textCls)}>
        <meta.Glyph className="h-full w-full" />
      </span>
    </div>
  );
}

/** The card BACK (mockup §3/§7) — the accent field with a fine diagonal
 *  weave and the cards seal. `sm` is the empty deck's tilted pair (§7);
 *  `big` is DK-7's face-down draw (§3). */
export function StoryCardBack({ size = "sm", className }: { size?: "sm" | "big"; className?: string }) {
  return (
    <div
      data-testid="story-card-back"
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-accent bg-accent bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.12)_0_6px,transparent_6px_12px)]",
        size === "sm" ? "h-[134px] w-24" : "h-[420px] w-[300px] rounded-[14px]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("pointer-events-none absolute inset-1 rounded-[7px] border border-white/45", size === "big" && "inset-1.5 rounded-[10px]")}
      />
      <span
        className={cn(
          "flex items-center justify-center rounded-full border-[1.5px] border-white/60 text-on-accent",
          size === "sm" ? "h-10 w-10" : "h-[58px] w-[58px]",
        )}
      >
        <Ic.cards className={size === "sm" ? "h-[18px] w-[18px]" : "h-[26px] w-[26px]"} />
      </span>
    </div>
  );
}
