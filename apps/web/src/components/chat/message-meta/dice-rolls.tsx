// ────────────────────────────────────────────────────────────────────────────
// Dice rolls message-meta badge (DICE-F10)
// ────────────────────────────────────────────────────────────────────────────
// Registers the message-owned Dice-result badge that renders in user-message
// footers. One `roles: ["user"]` descriptor; the compact badge shows the
// roll(s) bound to THAT message, and a click opens a read-only detail of every
// roll (actor, captured script/check labels + revision, notation, all
// attempts, strict outcome/degree/constraint, mode, timestamp).
//
// Historical truth, frozen: rendering reads ONLY ctx.diceRolls — the immutable
// snapshots captured at roll time. It never consults the dice-store, the
// insights `diceEnabled` flag, or the live script definitions, so a historical
// badge survives Dice being disabled and is untouched by script rename/edit/
// delete. The badge is message-scoped by construction (one metaCtx per
// MessageBlock), so updating message A's rolls never re-renders message B's
// badge or replays its settle animation.
//
// Mirrors the tray's visual language (DiceFaces + attempt/outcome chrome from
// DiceTray's AttemptDetail/RollCard) but is read-only — no pending-lane
// handlers. Registered at module load; imported for side effects from
// ./badges.tsx (the meta-badge registration hub).
// ────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { DiceRollSnapshot } from "@vibe-tavern/domain";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useT } from "../../../i18n/context.js";
import { DiceFaces } from "../../shared/dice-faces.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { Ic } from "../../shared/icons.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import {
  registerMessageMeta,
  type MessageMetaDescriptor,
} from "../../../lib/message-meta-registry.js";

/** The adjudicated result total of a roll: strict `final.total`, else the
 *  chosen (or last) attempt's total. Null only when the roll has no attempts. */
function rollTotal(roll: DiceRollSnapshot): number | null {
  if (typeof roll.final?.total === "number") return roll.final.total;
  const chosen = roll.finalAttemptId
    ? roll.attempts.find((a) => a.attemptId === roll.finalAttemptId)
    : null;
  return (chosen ?? roll.attempts.at(-1) ?? null)?.total ?? null;
}

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function formatRollTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const TRIGGER_CLS =
  "inline-flex items-center gap-1 rounded font-ui text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors hover:text-t1 cursor-pointer";

/**
 * Compact badge rendered in the user-message footer. Single roll → dice icon +
 * mono total + check label + an inline `DiceFaces` row (xs, capped at 4).
 * Multiple rolls → dice icon + "{n} checks" summary (no inline row). Either
 * form opens the read-only detail (desktop Radix Popover, mobile BottomSheet).
 */
export function DiceRollsBadge({ rolls }: { rolls: DiceRollSnapshot[] }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const single = rolls.length === 1 ? rolls[0]! : null;
  const total = single ? rollTotal(single) : null;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className={TRIGGER_CLS} aria-label={t("dice_details_title")}>
            <Ic.dice />
            {single ? (
              <>
                {total != null && <span className="tabular-nums font-mono text-t2">{total}</span>}
                <span>{single.checkLabel}</span>
              </>
            ) : (
              <span>{t("dice_meta_checks", { count: rolls.length })}</span>
            )}
          </button>
        </Popover.Trigger>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={4}
              className="glass-blur z-[220] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              <DiceRollDetailContent rolls={rolls} />
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>

      {single && (
        <DiceFaces
          faceShape={single.faceShape}
          attempts={single.attempts}
          notation={single.notation}
          size="xs"
          maxVisible={4}
          rollKey={String(single.rollId)}
          excluded={!single.included}
          onOverflowClick={() => setOpen(true)}
        />
      )}

      {open && isMobile && (
        <BottomSheet open={true} onClose={() => setOpen(false)} title={t("dice_details_title")}>
          <DiceRollDetailContent rolls={rolls} />
        </BottomSheet>
      )}
    </>
  );
}

/** Read-only detail list rendered inside the popover (desktop) / sheet (mobile).
 *  Exported for direct testing without the Popover/portal harness. */
export function DiceRollDetailContent({ rolls }: { rolls: DiceRollSnapshot[] }) {
  return (
    <div className="max-h-[70vh] space-y-2 overflow-y-auto p-3">
      {rolls.map((roll) => (
        <DetailRollCard key={String(roll.rollId)} roll={roll} />
      ))}
    </div>
  );
}

function DetailRollCard({ roll }: { roll: DiceRollSnapshot }) {
  const { t } = useT();
  return (
    <div className="rounded-md border border-border bg-s2/70 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{roll.checkLabel}</span>
        <span className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{roll.notation}</span>
        <span className="build-tag">{roll.mode === "immersive" ? t("dice_tray_mode_immersive") : t("dice_tray_mode_normal")}</span>
      </div>
      <div
        className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3"
        title={t("dice_meta_captured_rev_title", { revision: roll.scriptRevision })}
      >
        {roll.actor.actorLabel} · {roll.scriptLabel}
      </div>
      {roll.attempts.map((attempt, index) => (
        <div key={attempt.attemptId} className="mt-2 rounded-md border border-border bg-surface/60 p-2">
          <div className="mb-1.5 flex items-center gap-2 text-[calc(var(--ui-fs)-3px)]">
            <span className="font-ui font-medium text-t2">{t("dice_attempt", { n: index + 1 })}</span>
            {(attempt.chosenFinal || attempt.attemptId === roll.finalAttemptId) && (
              <span className="build-tag text-success-text">{t("dice_final_attempt")}</span>
            )}
          </div>
          <DiceFaces
            faceShape={roll.faceShape}
            faces={attempt.faces}
            notation={roll.notation}
            size="md"
            maxVisible={attempt.faces.length}
            rollKey={attempt.attemptId}
            excluded={!roll.included}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[calc(var(--ui-fs)-3px)] text-t2">
            <span>{t("dice_subtotal")}: {attempt.subtotal}</span>
            <span>{t("dice_modifier")}: {formatModifier(attempt.modifier)}</span>
            <span className="font-semibold text-t1">{t("dice_total")}: {attempt.total}</span>
          </div>
          {attempt.grantReason && (
            <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t2">
              {t("dice_grant_reason")}: {attempt.grantReason}
            </div>
          )}
        </div>
      ))}
      {roll.final?.outcome && (
        <div className="mt-2 text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{roll.final.outcome}</div>
      )}
      {roll.final?.degree && (
        <div className="mt-1 text-[calc(var(--ui-fs)-3px)] text-t2">{roll.final.degree}</div>
      )}
      {roll.final?.constraint && (
        <div className="mt-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t2">
          {roll.final.constraint}
        </div>
      )}
      <div className="mt-1.5 text-[calc(var(--ui-fs)-4px)] text-t3/70">{formatRollTime(roll.createdAt)}</div>
    </div>
  );
}

/** The registered descriptor. Exported so tests can assert its role gate /
 *  visibility and drive its renderer without the process-global registry. */
export const diceRollsMetaDescriptor: MessageMetaDescriptor = {
  id: "dice-rolls",
  order: 5,
  roles: ["user"],
  visible: (ctx) => ctx.diceRolls.length > 0,
  render: (ctx) => <DiceRollsBadge rolls={ctx.diceRolls} />,
};

registerMessageMeta(diceRollsMetaDescriptor);
