import { useEffect, useState, type ReactElement } from "react";
import type { StoryCard as StoryCardData, StoryDeck } from "@vibe-tavern/api-contracts";
import { toast } from "sonner";
import { StoryDeckForeignGoalsError } from "../../../api/agent-branch-deck-api.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useStoryDeck } from "../../../hooks/use-story-deck.js";
import { useT } from "../../../i18n/context.js";
import type Resources from "../../../i18n/resources.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { STORY_CURTAIN_TABS, useStoryCurtainTabStore } from "../../../stores/story-curtain-tab-store.js";
import { AutoTextarea } from "../auto-textarea.js";
import { BottomSheet } from "../BottomSheet.js";
import { DestructiveConfirmModal } from "../destructive-confirm-modal.js";
import { Ic } from "../icons.js";
import { Modal } from "../Modal.js";
import { modalPanelCls } from "../modal-helpers.js";
import { SegmentedControl } from "../SegmentedControl.js";
import { TextInput } from "../text-input.js";
import { STORY_CARD_SUIT_META, StoryCardBack, StoryCardFace, type StoryCardSuitName } from "./StoryCard.js";

/**
 * StoryCardDialog (DIRECTOR_DECK_CALENDAR_PLAN DK-7, mockup §2/§3/§7) — the
 * twist card's dialog: view (the big face + the footer actions), edit (the
 * suit/title/body fields with a live grid preview), draw (the face-down
 * back that flips to the face) and play (the 409 foreign-goals confirm +
 * retry). RESPONSIVE DUAL-MODE is canon: desktop the shared `Modal` with the
 * canon glass panel (`modalPanelCls`), phone the `BottomSheet` (§7: the
 * card, then the actions stacked, the primary full width) — same body,
 * two shells.
 *
 * Footer house rule (the Prompt-Manager ruling): item actions live in the
 * footer, never beside the title. View footer per §2: left the remove
 * action `story_deck_dialog_remove` (destructive → DestructiveConfirmModal
 * — a removal is unrecoverable) + `story_deck_dialog_edit`, right
 * `story_deck_dialog_close` + `story_deck_dialog_play_now` (primary). Draw
 * footer per §3: `story_deck_dialog_return` · `story_deck_dialog_play`
 * (primary).
 *
 * The streaming lock (`locked`, the DR-12 rule: director-affecting actions
 * disable while a sidechat turn streams) disables every DECK WRITE here —
 * play, remove, edit entry and the editor's save — the same scope the plan
 * editor applies to its fields+save; view/close stay live. The ask's
 * explicit case (play disables while locked) is covered by the same rule.
 *
 * Play (the DK-4a route): on the typed 409 `story_deck_foreign_goals` the
 * calm confirm offers the replace-goals override and retries with
 * `{ replaceForeignGoals: true }`; a successful play closes the dialog and
 * switches the curtain to the events tab — the plan panel's own
 * current-event highlight is the signal (no extra flash, per the plan).
 *
 * Layout arithmetic (AD-022, mockup §6's wrap rule): the view footer's four
 * RU buttons do not fit one 380px row at the default font — the footer
 * `flex-wrap`s, the left/right groups keeping their line identity (the same
 * answer §6 gives the plan editor's when-row (the dated-events row); no
 * copy is ever shortened). The suit control rides `wrap mobileFill` (§2's
 * note) for the same reason.
 *
 * Owner ruling 2026-11-07: the EDIT mode of an EXISTING card carries the
 * visible heading `story_deck_dialog_edit_title` (EN "Edit card") — the
 * same heading treatment the new-card editor has — in BOTH shells (the
 * desktop Modal header and the phone sheet title). The title is
 * phase-aware: the phase state lives in the shell (lifted from the body
 * through `onPhaseChange`) so both shells' titles track view→edit.
 */

/** What opened the dialog — a deck card (view/edit), a random draw, or the
 *  new-card editor (the dashed tile). */
export type StoryCardDialogRequest =
  | { kind: "card"; cardId: string }
  | { kind: "draw" }
  | { kind: "new" };

type DialogPhase = "view" | "edit" | "draw";

/** The mockup §3's rotateY flip duration. */
const DRAW_FLIP_DELAY_MS = 450;
/** System reduced-motion query (the dice-faces / resizable-side-pane idiom). */
const REDUCED_MOTION_MQ = "(prefers-reduced-motion: reduce)";

/** The suit options render THE ONE suit derivation (`STORY_CARD_SUIT_META`,
 *  K1) — this list only projects it into SegmentedControl options. */
const SUIT_OPTIONS: Array<{
  suit: StoryCardSuitName;
  labelKey: keyof Resources["en"];
  Glyph: (props?: { className?: string }) => ReactElement;
}> = (Object.keys(STORY_CARD_SUIT_META) as Array<StoryCardSuitName>).map((suit) => ({
  suit,
  labelKey: STORY_CARD_SUIT_META[suit].labelKey,
  Glyph: STORY_CARD_SUIT_META[suit].Glyph,
}));

const FIRST_SUIT: StoryCardSuitName = SUIT_OPTIONS[0]!.suit;

// ── Footer button chrome (canon clones) ─────────────────────────────────────
// The AvatarCropModal 37px pair (the vibe-tavern-frontend skill's modal
// footer canon); the danger arm retints the cancel shape (mockup §2 draws
// the remove action, `story_deck_dialog_remove`, as danger-colored footer
// text). disabled arms from the AgentPlanEditorModal footer.
const FOOTER_CANCEL_CLS =
  "h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50";
const FOOTER_PRIMARY_CLS =
  "h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
const FOOTER_DANGER_TEXT_CLS =
  "h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-danger-text transition-all hover:text-danger disabled:cursor-not-allowed disabled:opacity-50";
// The phone arms: the §7 stacked actions at the DR-11 44px target — the
// destructive-confirm arms' shapes (destructive-confirm-modal.tsx) retuned
// to min-h-11 (the story-deck empty-state call button's phone arm).
const PHONE_PRIMARY_CLS =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-accent px-[21px] font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
const PHONE_SECONDARY_CLS =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border bg-transparent px-3.5 font-ui text-[calc(var(--ui-fs)-1px)] text-t3 transition-colors duration-150 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50";
const PHONE_DESTRUCTIVE_CLS =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-danger bg-transparent px-3.5 font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-danger transition-colors duration-150 hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50";

function phaseFor(request: StoryCardDialogRequest): DialogPhase {
  if (request.kind === "new") return "edit";
  if (request.kind === "draw") return "draw";
  return "view";
}

/** Uniform pick over the deck (called once the deck is loaded — see the
 *  pick effect; never re-rolled within a draw session). */
function pickRandomCardId(deck: StoryDeck): string | null {
  if (deck.cards.length === 0) return null;
  return deck.cards[Math.floor(Math.random() * deck.cards.length)]!.id;
}

/** The shell title for the current request + phase. Phase-aware (owner
 *  ruling 2026-11-07): the EDIT mode of an EXISTING card carries the visible
 *  heading `story_deck_dialog_edit_title` (EN "Edit card") — the same
 *  heading treatment the new-card editor has — in both shells; the new-card
 *  editor keeps `story_deck_own_card`; view/draw keep their titles (the
 *  deck title on desktop, none on the phone sheet). */
function shellTitleKeyFor(request: StoryCardDialogRequest | null, phase: DialogPhase): "story_deck_own_card" | "story_deck_dialog_edit_title" | "story_deck_title" | null {
  if (request === null) return null;
  if (request.kind === "new") return "story_deck_own_card";
  if (request.kind === "card" && phase === "edit") return "story_deck_dialog_edit_title";
  return "story_deck_title";
}

/** The dialog's shells (desktop `Modal` / phone `BottomSheet`). The body
 *  renders from the LAST request through the close so the shells' exit
 *  animation keeps its content; a new request re-keys the body (fresh state
 *  per session) via the render-phase adjustment pattern. */
export function StoryCardDialog({
  chatId,
  branchId,
  locked,
  request,
  onClose,
}: {
  chatId: string;
  branchId: string;
  /** The streaming lock (DR-12) — deck writes disable while set. */
  locked: boolean;
  /** The current open request; `null` = closed. */
  request: StoryCardDialogRequest | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [lastRequest, setLastRequest] = useState<StoryCardDialogRequest | null>(request);
  const [session, setSession] = useState(0);
  // The phase lives HERE (the shell) so both shells' titles are phase-aware
  // (the owner ruling): the body lifts its transitions through
  // `onPhaseChange`. Reset per session with the same render-phase adjustment.
  const [phase, setPhase] = useState<DialogPhase>(() => (lastRequest !== null ? phaseFor(lastRequest) : "view"));
  if (request !== lastRequest && request !== null) {
    // React's "adjust state when a prop changes" pattern — applied during
    // render so the reopened dialog never paints the previous session.
    setLastRequest(request);
    setPhase(phaseFor(request));
    setSession((current) => current + 1);
  }
  const open = request !== null;
  const titleKey = shellTitleKeyFor(lastRequest, phase);
  const body =
    lastRequest !== null ? (
      <StoryCardBody
        key={session}
        chatId={chatId}
        branchId={branchId}
        locked={locked}
        mobile={isMobile}
        newCard={lastRequest.kind === "new"}
        request={lastRequest}
        phase={phase}
        onPhaseChange={setPhase}
        onClose={onClose}
      />
    ) : null;

  if (isMobile) {
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        title={titleKey !== null && (titleKey === "story_deck_own_card" || titleKey === "story_deck_dialog_edit_title") ? t(titleKey) : undefined}
      >
        {body}
      </BottomSheet>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={titleKey !== null ? t(titleKey) : ""} description={titleKey !== null ? t(titleKey) : ""}>
      {body}
    </Modal>
  );
}

/** One open session's content — state initializes from the request (the
 *  parent re-keys per session), so no reset effects exist. The phase is
 *  OWNED by the shell (lifted through `onPhaseChange`) so both shells'
 *  titles are phase-aware (the owner ruling); this body only transitions it. */
function StoryCardBody({
  chatId,
  branchId,
  locked,
  mobile,
  newCard,
  request,
  phase,
  onPhaseChange,
  onClose,
}: {
  chatId: string;
  branchId: string;
  locked: boolean;
  /** The phone shell (§7): actions stack, the primary goes full width. */
  mobile: boolean;
  /** The new-card editor (the tile's request) — its save closes the dialog
   *  (the flow's purpose fulfilled; the grid shows the created card). */
  newCard: boolean;
  request: StoryCardDialogRequest;
  /** The lifted phase (the shell's title derives from it). */
  phase: DialogPhase;
  /** The phase transitions (view → edit, edit-save → view). */
  onPhaseChange: (phase: DialogPhase) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const { deck, save, play } = useStoryDeck(chatId, branchId);
  const setPhase = onPhaseChange;
  // The editor's edits overlay the SOURCE card (never a copy taken at open
  // time): the deck GET resolves after the dialog mounts (the shared cache
  // starts at the empty deck), so a draft snapshot taken at mount would
  // show empty fields — the draft derives from the deck per render, the
  // state carries only what the user touched.
  const [edits, setEdits] = useState<{ suit?: StoryCardSuitName; title?: string; body?: string }>({});
  const [newCardId] = useState<string>(() => `card_${crypto.randomUUID()}`);
  const [drawnId, setDrawnId] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [foreignGoalsConfirmOpen, setForeignGoalsConfirmOpen] = useState(false);

  const viewedCard =
    request.kind === "card" ? deck.cards.find((card) => card.id === request.cardId) ?? null : null;
  const drawnCard = drawnId !== null ? deck.cards.find((card) => card.id === drawnId) ?? null : null;
  const draft: StoryCardData =
    request.kind === "new"
      ? { id: newCardId, suit: edits.suit ?? FIRST_SUIT, title: edits.title ?? "", body: edits.body ?? "" }
      : viewedCard !== null
        ? { ...viewedCard, ...edits }
        : { id: "", suit: edits.suit ?? FIRST_SUIT, title: edits.title ?? "", body: edits.body ?? "" };

  // §3: the drawn card is picked once — at the first render where the deck
  // is actually loaded (the pick effect; a pick at mount time would draw
  // from the empty pre-GET deck). The card starts face-down and flips after
  // a beat; reduced motion (the dice-faces idiom) shows the face at once —
  // no timer, no transition frame.
  useEffect(() => {
    if (phase !== "draw") return;
    setDrawnId((current) => current ?? pickRandomCardId(deck));
  }, [phase, deck]);
  useEffect(() => {
    if (phase !== "draw") return;
    if (window?.matchMedia?.(REDUCED_MOTION_MQ)?.matches ?? false) {
      setFlipped(true);
      return;
    }
    const timer = window.setTimeout(() => setFlipped(true), DRAW_FLIP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const saveDraft = async () => {
    if (request.kind === "draw" || locked || busy) return;
    if (draft.title.trim() === "") return; // a card must have a title
    const nextCards =
      request.kind === "new"
        ? [...deck.cards, draft]
        : viewedCard !== null
          ? deck.cards.map((card) => (card.id === viewedCard.id ? draft : card))
          : deck.cards;
    setBusy(true);
    try {
      await save({ cards: nextCards });
      if (newCard) onClose();
      else setPhase("view");
    } catch {
      toast.error(t("story_deck_dialog_save_error"));
    } finally {
      setBusy(false);
    }
  };

  const removeCard = async () => {
    if (request.kind !== "card" || locked || busy) return;
    setBusy(true);
    try {
      await save({ cards: deck.cards.filter((card) => card.id !== request.cardId) });
      onClose();
    } catch {
      toast.error(t("story_deck_dialog_save_error"));
    } finally {
      setBusy(false);
    }
  };

  const playCard = async (replaceForeignGoals: boolean) => {
    const cardId = request.kind === "card" ? request.cardId : request.kind === "draw" ? drawnId : null;
    if (cardId === null || locked || busy) return;
    setBusy(true);
    try {
      await play(cardId, replaceForeignGoals ? { replaceForeignGoals: true } : undefined);
      // Success: the curtain switches to the events tab — the plan panel's
      // own current-event highlight is the signal. The store read goes
      // through getState() (async-callback canon: the render closure holds
      // pre-action state).
      useStoryCurtainTabStore.getState().setTab(chatId, STORY_CURTAIN_TABS.events);
      onClose();
    } catch (error) {
      if (error instanceof StoryDeckForeignGoalsError) {
        setForeignGoalsConfirmOpen(true);
      } else {
        toast.error(t("story_deck_play_error"));
      }
    } finally {
      setBusy(false);
    }
  };

  // ── Pieces (shared between the two shells) ─────────────────────────────────

  const editorFields = (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div>
        <span className={lblCls}>{t("story_deck_field_suit")}</span>
        <SegmentedControl<StoryCardSuitName>
          value={draft.suit}
          onChange={(suit) => setEdits((current) => ({ ...current, suit }))}
          ariaLabel={t("story_deck_field_suit")}
          wrap
          mobileFill
          disabled={locked}
          options={SUIT_OPTIONS.map(({ suit, labelKey, Glyph }) => ({
            value: suit,
            label: (
              <span className="flex items-center gap-1.5">
                <Glyph className="h-3.5 w-3.5 shrink-0" />
                {t(labelKey)}
              </span>
            ),
          }))}
        />
      </div>
      <div>
        <label htmlFor="story-card-title" className={lblCls}>{t("story_deck_field_title")}</label>
        <TextInput
          id="story-card-title"
          value={draft.title}
          disabled={locked}
          onChange={(event) => setEdits((current) => ({ ...current, title: event.target.value }))}
        />
      </div>
      <div>
        <label htmlFor="story-card-body" className={lblCls}>{t("story_deck_field_body")}</label>
        <AutoTextarea
          id="story-card-body"
          value={draft.body}
          disabled={locked}
          minRows={3}
          onChange={(event) => setEdits((current) => ({ ...current, body: event.target.value }))}
        />
        <p className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t3">{t("story_deck_field_body_hint")}</p>
      </div>
    </div>
  );

  const editorPreview = (
    <div data-testid="story-card-dialog-preview" className="flex shrink-0 flex-col items-center gap-1.5">
      <span className="text-[calc(var(--ui-fs)-3px)] text-t4">{t("story_deck_dialog_preview")}</span>
      <StoryCardFace card={draft} size="grid" />
    </div>
  );

  // §3's flip: the back layer sits upright, the face layer pre-rotated 180°;
  // `flipped` turns the shell — backface-visibility swaps the layers
  // mid-rotation. The face mounts only when flipped (the DOM state the
  // tests pin; backface-visibility alone would keep both in the DOM).
  const flip = (
    <div data-testid="story-card-draw-stage" className="flex justify-center [perspective:900px]">
      <div
        data-testid="story-card-draw-flip"
        data-flipped={flipped ? "true" : "false"}
        className={cn(
          "relative h-[420px] w-[300px] transition-transform duration-[450ms] motion-reduce:transition-none [transform-style:preserve-3d]",
          flipped && "[transform:rotateY(180deg)]",
        )}
      >
        <StoryCardBack size="big" className="absolute inset-0 [backface-visibility:hidden]" />
        {flipped && drawnCard !== null && (
          <StoryCardFace
            card={drawnCard}
            size="big"
            className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]"
          />
        )}
      </div>
    </div>
  );

  const editorFooter = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        mobile ? "w-full pt-1" : "justify-end border-t border-border px-4 py-3",
      )}
    >
      <button
        type="button"
        data-testid="story-card-dialog-cancel"
        onClick={onClose}
        className={cn(mobile ? PHONE_SECONDARY_CLS : FOOTER_CANCEL_CLS, mobile && "flex-1")}
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        data-testid="story-card-dialog-save"
        disabled={draft.title.trim() === "" || locked || busy}
        onClick={() => {
          void saveDraft();
        }}
        className={cn(mobile ? PHONE_PRIMARY_CLS : FOOTER_PRIMARY_CLS, mobile && "flex-1")}
      >
        {t("story_deck_dialog_save")}
      </button>
    </div>
  );

  // ── Per-mode + per-shell assembly ───────────────────────────────────────────

  if (phase === "edit") {
    if (mobile) {
      return (
        <div data-testid="story-card-dialog" className="flex flex-col gap-3 px-4 pb-4">
          {editorFields}
          {editorPreview}
          {editorFooter}
        </div>
      );
    }
    return (
      <div data-testid="story-card-dialog" className={cn(modalPanelCls, "flex max-h-[calc(100vh-60px)] w-[620px] max-w-[calc(100vw-32px)] flex-col")}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-[18px] pb-3 pt-4">
          <h2 className="font-ui text-[calc(var(--ui-fs)+2px)] font-medium text-t1">
            {newCard ? t("story_deck_own_card") : t("story_deck_dialog_edit_title")}
          </h2>
          <button
            type="button"
            data-testid="story-card-dialog-editor-close"
            aria-label={t("story_deck_dialog_close")}
            title={t("story_deck_dialog_close")}
            onClick={onClose}
            className="ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t1"
          >
            <Ic.close />
          </button>
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-row gap-[18px] p-[18px]")}>
          {editorFields}
          {editorPreview}
        </div>
        {editorFooter}
      </div>
    );
  }

  if (phase === "draw") {
    if (mobile) {
      return (
        <div data-testid="story-card-dialog" className="flex flex-col items-center gap-3 px-4 pb-4">
          {flip}
          <button
            type="button"
            data-testid="story-card-dialog-play"
            disabled={locked || busy}
            onClick={() => {
              void playCard(false);
            }}
            className={cn(PHONE_PRIMARY_CLS, "w-full")}
          >
            {t("story_deck_dialog_play")}
          </button>
          <button
            type="button"
            data-testid="story-card-dialog-return"
            onClick={onClose}
            className={cn(PHONE_SECONDARY_CLS, "w-full")}
          >
            {t("story_deck_dialog_return")}
          </button>
        </div>
      );
    }
    return (
      <div data-testid="story-card-dialog" className={cn(modalPanelCls, "flex w-[380px] max-w-[calc(100vw-32px)] flex-col")}>
        <div className="pb-4 pt-[22px]">{flip}</div>
        {/* §3's draw footer is centered (`story_deck_dialog_return` ·
            `story_deck_dialog_play`). */}
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border px-4 py-3">
          <button type="button" data-testid="story-card-dialog-return" onClick={onClose} className={FOOTER_CANCEL_CLS}>
            {t("story_deck_dialog_return")}
          </button>
          <button
            type="button"
            data-testid="story-card-dialog-play"
            disabled={locked || busy}
            onClick={() => {
              void playCard(false);
            }}
            className={FOOTER_PRIMARY_CLS}
          >
            {t("story_deck_dialog_play")}
          </button>
        </div>
      </div>
    );
  }

  // View (§2): the big face + the footer actions (the house rule — actions
  // in the footer, never beside the title).
  if (mobile) {
    return (
      <div data-testid="story-card-dialog" className="flex flex-col items-center gap-3 px-4 pb-4">
        {viewedCard !== null && <StoryCardFace card={viewedCard} size="big" />}
        <button
          type="button"
          data-testid="story-card-dialog-play-now"
          disabled={locked || busy}
          onClick={() => {
            void playCard(false);
          }}
          className={cn(PHONE_PRIMARY_CLS, "w-full")}
        >
          {t("story_deck_dialog_play_now")}
        </button>
        <div className="flex w-full gap-2">
          <button
            type="button"
            data-testid="story-card-dialog-edit"
            disabled={locked || busy}
            onClick={() => setPhase("edit")}
            className={cn(PHONE_SECONDARY_CLS, "flex-1")}
          >
            {t("story_deck_dialog_edit")}
          </button>
          <button
            type="button"
            data-testid="story-card-dialog-remove"
            disabled={locked || busy}
            onClick={() => setRemoveConfirmOpen(true)}
            className={cn(PHONE_DESTRUCTIVE_CLS, "flex-1")}
          >
            {t("story_deck_dialog_remove")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-testid="story-card-dialog" className={cn(modalPanelCls, "flex w-[380px] max-w-[calc(100vw-32px)] flex-col")}>
      <div className="flex justify-center pb-4 pt-[22px]">
        {viewedCard !== null && <StoryCardFace card={viewedCard} size="big" />}
      </div>
      {/* The footer wraps (§6's rule): the left/right groups keep their line
          identity; under the default RU font the four buttons take two
          rows, at narrower fonts one (the mockup's single row). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="story-card-dialog-remove"
            disabled={locked || busy}
            onClick={() => setRemoveConfirmOpen(true)}
            className={FOOTER_DANGER_TEXT_CLS}
          >
            {t("story_deck_dialog_remove")}
          </button>
          <button
            type="button"
            data-testid="story-card-dialog-edit"
            disabled={locked || busy}
            onClick={() => setPhase("edit")}
            className={FOOTER_CANCEL_CLS}
          >
            {t("story_deck_dialog_edit")}
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" data-testid="story-card-dialog-close" onClick={onClose} className={FOOTER_CANCEL_CLS}>
            {t("story_deck_dialog_close")}
          </button>
          <button
            type="button"
            data-testid="story-card-dialog-play-now"
            disabled={locked || busy}
            onClick={() => {
              void playCard(false);
            }}
            className={FOOTER_PRIMARY_CLS}
          >
            {t("story_deck_dialog_play_now")}
          </button>
        </div>
      </div>
      {/* Removing a card is unrecoverable → the destructive confirm. */}
      {removeConfirmOpen && viewedCard !== null && (
        <DestructiveConfirmModal
          title={t("story_deck_dialog_remove_title")}
          body={t("story_deck_dialog_remove_body", { title: viewedCard.title })}
          confirmLabel={t("story_deck_dialog_remove")}
          onConfirm={() => {
            setRemoveConfirmOpen(false);
            void removeCard();
          }}
          onCancel={() => setRemoveConfirmOpen(false)}
        />
      )}
      {/* The typed 409 (the branch's goal tracker holds goals not from a
          plan): the calm confirm offers the replace-goals override. */}
      {foreignGoalsConfirmOpen && (
        <DestructiveConfirmModal
          tone="calm"
          title={t("story_deck_play_confirm_title")}
          body={t("story_deck_play_confirm_body")}
          confirmLabel={t("story_deck_dialog_play")}
          onConfirm={() => {
            setForeignGoalsConfirmOpen(false);
            void playCard(true);
          }}
          onCancel={() => setForeignGoalsConfirmOpen(false)}
        />
      )}
    </div>
  );
}
