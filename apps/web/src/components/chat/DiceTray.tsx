import { useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import type {
  DiceActorType,
  DiceDefinitionsResponse,
  DiceLaneState,
  DiceMode,
  DiceRollSnapshot,
} from "../../api/types.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { useDiceLastError, useDiceStore } from "../../stores/dice-store.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { DiceFaces } from "../shared/dice-faces.js";
import { EmptyState } from "../shared/empty-state.js";
import { Ic, Icons } from "../shared/icons.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { CustomTooltip } from "../shared/Tooltip.js";

interface DiceActorOption {
  id: string;
  name: string;
}

type CheckDef = DiceDefinitionsResponse["scripts"][number]["checks"][number];
type ScriptDef = DiceDefinitionsResponse["scripts"][number];

export interface DiceTrayProps {
  chatId: string;
  branchId: string;
  mode: DiceMode;
  definitions: DiceDefinitionsResponse;
  lane: DiceLaneState;
  character: DiceActorOption | null;
  persona: DiceActorOption | null;
  /** Per-script actor distribution (Rework R1). null = each check uses its
   *  declared actors; a record overrides per script (full freedom). Mirrors the
   *  backend resolver's `resolveEffectiveActors`. */
  diceActorBindings: Record<string, DiceActorType[]> | null;
  showTitle?: boolean;
}

function notationDiceCount(notation: string): number {
  const match = notation.match(/^(\d*)d/i);
  if (!match) return 1;
  const count = Number(match[1] || "1");
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function finalAttempt(roll: DiceRollSnapshot) {
  return roll.attempts.find((attempt) => attempt.attemptId === roll.finalAttemptId)
    ?? roll.attempts.at(-1)
    ?? null;
}

// ─── Roll button (one per actor on each check row) ───────────────────────────
// Replaces the actor SegmentedControl + persistent single-check selection model
// (Rework R3). Each check renders an independent button per available+effective
// actor; clicking rolls (or rerolls) directly — no selection step, which also
// removes the mobile reroll dead-button failure mode (the old reroll required a
// selected check that did not sync reliably inside the BottomSheet).

type ActorBtnState = "idle" | "rolling" | "ready" | "again";

function ActorRollButton({
  actorType,
  state,
  checkId,
  checkLabel,
  onClick,
}: {
  actorType: DiceActorType;
  state: ActorBtnState;
  checkId: string;
  checkLabel: string;
  onClick: () => void;
}) {
  const { t } = useT();
  const noun = actorType === "persona" ? t("dice_persona") : t("dice_character");
  const isReroll = state === "ready" || state === "again";
  const action = state === "idle" ? t("dice_roll") : isReroll ? t("dice_reroll") : t("dice_rolling");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "rolling"}
      data-testid={`roll-btn-${actorType}-${checkId}`}
      aria-label={`${action} — ${checkLabel} (${noun})`}
      title={`${action} — ${noun}`}
      className={cn(
        "flex min-h-9 items-center justify-center gap-1 rounded-md border px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium transition-colors",
        isReroll
          ? "border-accent/50 bg-accent-dim text-accent-t hover:bg-accent/20"
          : "border-border2 bg-s2 text-t2 hover:border-t3 hover:text-t1",
        state === "rolling" && "cursor-wait opacity-60",
      )}
    >
      {state === "ready" && <Icons.regen />}
      {state === "again" && <Ic.plus />}
      <span>{state === "rolling" ? t("dice_rolling") : noun}</span>
    </button>
  );
}

interface CheckRowProps {
  scriptId: string;
  scriptLabel: string;
  check: CheckDef;
  personaState: ActorBtnState | null;
  characterState: ActorBtnState | null;
  onRoll: (actorType: DiceActorType) => void;
}

function CheckRow({ scriptId, scriptLabel, check, personaState, characterState, onRoll }: CheckRowProps) {
  const { t } = useT();
  const anyRolling = personaState === "rolling" || characterState === "rolling";
  return (
    <div className="flex items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{check.label}</span>
          <span className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{check.notation}</span>
        </div>
        <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3">{scriptLabel}</div>
        {check.help && <div className="mt-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t2">{check.help}</div>}
        {anyRolling && (
          <div className="mt-2">
            <DiceFaces
              faceShape={check.faceShape}
              notation={check.notation}
              size="sm"
              maxVisible={6}
              rollKey={`loading:${scriptId}:${check.id}`}
              loading={{ count: notationDiceCount(check.notation) }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {personaState && (
          <ActorRollButton actorType="persona" state={personaState} checkId={check.id} checkLabel={check.label} onClick={() => onRoll("persona")} />
        )}
        {characterState && (
          <ActorRollButton actorType="character" state={characterState} checkId={check.id} checkLabel={check.label} onClick={() => onRoll("character")} />
        )}
      </div>
    </div>
  );
}

function PolicyBadge({ roll }: { roll: DiceRollSnapshot }) {
  const { t } = useT();
  if (!roll.policy) return null;
  const keys = {
    replace: "dice_policy_replace",
    keep_best: "dice_policy_keep_best",
    keep_worst: "dice_policy_keep_worst",
    choose: "dice_policy_choose",
  } as const;
  return <span className="build-tag text-t2">{t(keys[roll.policy])}</span>;
}

function AttemptDetail({ roll }: { roll: DiceRollSnapshot }) {
  const { t } = useT();
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{roll.checkLabel}</span>
        <span className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{roll.notation}</span>
      </div>
      {roll.attempts.map((attempt, index) => (
        <div key={attempt.attemptId} className="rounded-md border border-border bg-s2/70 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[calc(var(--ui-fs)-3px)]">
            <span className="font-ui font-medium text-t2">{t("dice_attempt", { n: index + 1 })}</span>
            {(attempt.chosenFinal || attempt.attemptId === roll.finalAttemptId) && (
              <span className="build-tag text-success-text">{t("dice_final_attempt")}</span>
            )}
          </div>
          <DiceFaces
            faceShape={roll.faceShape}
            faces={attempt.faces}
            notation={roll.notation}
            size="lg"
            maxVisible={attempt.faces.length}
            rollKey={attempt.attemptId}
            excluded={!roll.included}
          />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[calc(var(--ui-fs)-3px)] text-t2">
            <span>{t("dice_subtotal")}: {attempt.subtotal}</span>
            <span>{t("dice_modifier")}: {formatModifier(attempt.modifier)}</span>
            <span className="font-semibold text-t1">{t("dice_total")}: {attempt.total}</span>
          </div>
          {attempt.grantReason && <div className="mt-1 text-[calc(var(--ui-fs)-3px)] text-t2">{t("dice_grant_reason")}: {attempt.grantReason}</div>}
        </div>
      ))}
    </div>
  );
}

interface RollCardProps {
  roll: DiceRollSnapshot;
  mode: DiceMode;
  stale: boolean;
  onRemove: () => void;
  onIncludedChange: (included: boolean) => void;
  onChoose: (attemptId: string) => void;
}

function RollCard({ roll, mode, stale, onRemove, onIncludedChange, onChoose }: RollCardProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [detailOpen, setDetailOpen] = useState(false);
  const attempt = finalAttempt(roll);
  const unresolvedChoose = roll.policy === "choose" && roll.finalAttemptId === null;

  return (
    <div
      className={cn(
        "rounded-lg border bg-surface/70 p-3 shadow-sm",
        unresolvedChoose ? "border-warning/60" : "border-border",
        !roll.included && "opacity-70",
      )}
      data-roll-id={roll.rollId}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{roll.checkLabel}</span>
            <span className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{roll.notation}</span>
          </div>
          <div className="mt-1 text-[calc(var(--ui-fs)-3px)] text-t3">{roll.scriptLabel}</div>
        </div>
        {(mode === "normal" || stale) && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t("dice_remove_roll")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-t3 transition-colors hover:bg-danger-dim hover:text-danger-text"
          >
            <Icons.Trash />
          </button>
        )}
      </div>

      {attempt && (
        <div className="mt-3">
          <DiceFaces
            faceShape={roll.faceShape}
            faces={attempt.faces}
            notation={roll.notation}
            size="lg"
            maxVisible={6}
            rollKey={roll.rollId}
            excluded={!roll.included}
            onOverflowClick={() => setDetailOpen(true)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[calc(var(--ui-fs)-3px)] text-t2">
            <span>{t("dice_subtotal")}: {attempt.subtotal}</span>
            <span>{t("dice_modifier")}: {formatModifier(attempt.modifier)}</span>
            <span className="font-semibold text-t1">{t("dice_total")}: {roll.final?.total ?? attempt.total}</span>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <CustomTooltip content={t(roll.resolution === "strict" ? "dice_resolution_strict_tip" : "dice_resolution_narrative_tip")}>
          <span className="build-tag cursor-help text-t2">{t(roll.resolution === "strict" ? "dice_resolution_strict" : "dice_resolution_narrative")}</span>
        </CustomTooltip>
        <PolicyBadge roll={roll} />
        {stale && <span className="build-tag text-warning-text">{t("dice_stale_actor_badge")}</span>}
        {!roll.included && <span className="build-tag text-t3">{t("dice_excluded_badge")}</span>}
      </div>

      {roll.retryReason && <div className="mt-2 text-[calc(var(--ui-fs)-3px)] text-t2">{t("dice_retry_reason")}: {roll.retryReason}</div>}
      {roll.final?.outcome && <div className="mt-2 text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{roll.final.outcome}</div>}
      {roll.final?.degree && <div className="mt-1 text-[calc(var(--ui-fs)-3px)] text-t2">{roll.final.degree}</div>}
      {roll.final?.constraint && <div className="mt-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t2">{roll.final.constraint}</div>}

      {unresolvedChoose && (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning-dim px-2.5 py-2 text-[calc(var(--ui-fs)-3px)] text-warning-text">
          {t("dice_choose_required")}
        </div>
      )}

      {roll.policy === "choose" && (
        <div className="mt-3 space-y-1.5">
          {roll.attempts.map((item, index) => {
            const chosen = item.attemptId === roll.finalAttemptId || item.chosenFinal === true;
            return (
              <div key={item.attemptId} className="flex flex-wrap items-center gap-2 rounded-md bg-s2 px-2.5 py-2 text-[calc(var(--ui-fs)-3px)]">
                <span className="text-t2">{t("dice_attempt", { n: index + 1 })}</span>
                <span className="font-mono font-semibold text-t1">{item.total}</span>
                {chosen ? (
                  <span className="ml-auto text-success-text">{t("dice_chosen")}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onChoose(item.attemptId)}
                    aria-label={t("dice_choose_attempt")}
                    className="ml-auto min-h-9 rounded-md px-2.5 text-accent-t transition-colors hover:bg-accent-dim"
                  >
                    {t("dice_choose_this")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <Popover.Root open={!isMobile && detailOpen} onOpenChange={setDetailOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="min-h-9 rounded-md px-2.5 text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            >
              {t("dice_details")}
            </button>
          </Popover.Trigger>
          {!isMobile && (
            <Popover.Portal container={getModalPortal() ?? undefined}>
              <Popover.Content
                side="top"
                align="end"
                sideOffset={6}
                className="glass-blur z-[230] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none"
              >
                <AttemptDetail roll={roll} />
              </Popover.Content>
            </Popover.Portal>
          )}
        </Popover.Root>

        {mode === "immersive" && (
          <button
            type="button"
            onClick={() => onIncludedChange(!roll.included)}
            aria-label={t(roll.included ? "dice_exclude_roll" : "dice_include_roll")}
            className={cn(
              "min-h-9 rounded-md px-2.5 text-[calc(var(--ui-fs)-3px)] transition-colors",
              roll.included ? "text-t2 hover:bg-s2 hover:text-t1" : "text-accent-t hover:bg-accent-dim",
            )}
          >
            {t(roll.included ? "dice_exclude_from_send" : "dice_undo_exclusion")}
          </button>
        )}
      </div>

      {isMobile && detailOpen && (
        <BottomSheet open={true} onClose={() => setDetailOpen(false)} title={t("dice_details_title")}>
          <AttemptDetail roll={roll} />
        </BottomSheet>
      )}
    </div>
  );
}

function ResultColumn({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  const { t } = useT();
  return (
    <section className="space-y-2">
      <div className="px-1 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-wide text-t3">{title}</div>
      {empty ? (
        <div className="rounded-md border border-dashed border-border2 px-2 py-3 text-center text-[calc(var(--ui-fs)-3px)] text-t4">{t("dice_no_pending")}</div>
      ) : (
        children
      )}
    </section>
  );
}

export function DiceTray({
  chatId,
  branchId,
  mode,
  definitions,
  lane,
  character,
  persona,
  diceActorBindings,
  showTitle = true,
}: DiceTrayProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const lastError = useDiceLastError(chatId, branchId);
  const roll = useDiceStore((state) => state.roll);
  const removeRoll = useDiceStore((state) => state.removeRoll);
  const clearLane = useDiceStore((state) => state.clearLane);
  const setIncluded = useDiceStore((state) => state.setIncluded);
  const chooseAttempt = useDiceStore((state) => state.chooseAttempt);
  const [rollingKeys, setRollingKeys] = useState<Set<string>>(() => new Set());

  // Effective actors per check: an explicit chat binding REPLACES the declared
  // actors (full freedom — expand or narrow); otherwise declared wins. Mirrors
  // the backend `resolveEffectiveActors` so tray button visibility matches
  // server-enforced roll eligibility exactly.
  const effectiveActors = (scriptId: string, check: CheckDef): readonly DiceActorType[] =>
    diceActorBindings?.[scriptId] ?? check.actors;

  const personaAvailable = persona != null && definitions.scripts.some((s) =>
    s.checks.some((c) => effectiveActors(s.scriptId, c).includes("persona")));
  const characterAvailable = character != null && definitions.scripts.some((s) =>
    s.checks.some((c) => effectiveActors(s.scriptId, c).includes("character")));

  // Flatten checks for the roll-button region (R3: no actor selector, no
  // persistent single-check selection — every check is directly rollable).
  const allChecks = useMemo(() => {
    const out: Array<{ scriptId: string; scriptLabel: string; check: CheckDef }> = [];
    for (const script of definitions.scripts) {
      for (const check of script.checks) {
        out.push({ scriptId: script.scriptId, scriptLabel: script.scriptLabel, check });
      }
    }
    return out;
  }, [definitions]);

  const actorFor = (type: DiceActorType): DiceActorOption | null => (type === "persona" ? persona : character);

  const rollFor = (scriptId: string, checkId: string, actorType: DiceActorType) =>
    lane.rolls.find((item) =>
      item.scriptId === scriptId
      && item.checkId === checkId
      && item.actor.actorType === actorType
      && item.actor.actorId === actorFor(actorType)?.id,
    );

  const actorState = (scriptId: string, check: CheckDef, actorType: DiceActorType): ActorBtnState | null => {
    const actor = actorFor(actorType);
    if (!actor) return null; // no persona/character loaded → no button
    if (!effectiveActors(scriptId, check).includes(actorType)) return null; // not bound in this chat
    if (rollingKeys.has(`${scriptId}:${check.id}:${actorType}`)) return "rolling";
    const existing = rollFor(scriptId, check.id, actorType);
    if (!existing) return "idle";
    if (mode === "normal") return "ready"; // reroll (replace)
    return existing.policy === "replace" ? "ready" : "again"; // immersive retry
  };

  const runRoll = async (scriptId: string, checkId: string, actorType: DiceActorType) => {
    const actor = actorFor(actorType);
    if (!actor) return;
    const key = `${scriptId}:${checkId}:${actorType}`;
    setRollingKeys((current) => new Set(current).add(key));
    try {
      await roll(chatId, branchId, { scriptId, checkId, actorType, actorId: actor.id, mode });
    } finally {
      setRollingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  // Split pending results by actor for the side-by-side columns (R3).
  const personaRolls = useMemo(() => lane.rolls.filter((r) =>
    r.actor.actorType === "persona" && r.actor.actorId === persona?.id), [lane.rolls, persona?.id]);
  const characterRolls = useMemo(() => lane.rolls.filter((r) =>
    r.actor.actorType === "character" && r.actor.actorId === character?.id), [lane.rolls, character?.id]);
  const currentIds = useMemo(() => new Set([...personaRolls, ...characterRolls].map((r) => r.rollId)),
    [personaRolls, characterRolls]);
  const staleRolls = useMemo(() => lane.rolls.filter((r) => !currentIds.has(r.rollId)), [lane.rolls, currentIds]);
  const latestRoll = lane.rolls.at(-1);
  const latestAttempt = latestRoll ? finalAttempt(latestRoll) : null;

  const renderRoll = (item: DiceRollSnapshot, stale: boolean) => (
    <RollCard
      key={item.rollId}
      roll={item}
      mode={mode}
      stale={stale}
      onRemove={() => { void removeRoll(chatId, branchId, item.rollId); }}
      onIncludedChange={(included) => { void setIncluded(chatId, branchId, item.rollId, included); }}
      onChoose={(attemptId) => { void chooseAttempt(chatId, branchId, item.rollId, attemptId); }}
    />
  );

  // ── Checks region: one row per check, a roll/reroll button per effective actor.
  const checksRegion = (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-2 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-wide text-t3">
        {t("dice_check_pick")}
      </div>
      {allChecks.length === 0 ? (
        <div className="px-3 py-4 text-center text-[calc(var(--ui-fs)-3px)] text-t4">{t("dice_no_checks_any")}</div>
      ) : (
        allChecks.map(({ scriptId, scriptLabel, check }) => (
          <CheckRow
            key={`${scriptId}:${check.id}`}
            scriptId={scriptId}
            scriptLabel={scriptLabel}
            check={check}
            personaState={actorState(scriptId, check, "persona")}
            characterState={actorState(scriptId, check, "character")}
            onRoll={(type) => { void runRoll(scriptId, check.id, type); }}
          />
        ))
      )}
    </div>
  );

  // ── Results: persona | character side by side (wide) or stacked (narrow).
  const resultsInner = (
    <div className={cn(isMobile ? "space-y-4" : "grid grid-cols-2 gap-3")}>
      <ResultColumn title={t("dice_persona")} empty={personaRolls.length === 0}>
        {personaRolls.map((r) => renderRoll(r, false))}
      </ResultColumn>
      <ResultColumn title={t("dice_character")} empty={characterRolls.length === 0}>
        {characterRolls.map((r) => renderRoll(r, false))}
      </ResultColumn>
      {staleRolls.length > 0 && (
        <section className="space-y-2 space-y-3 col-span-full">
          <div className="px-1 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-wide text-t3">
            {t("dice_stale_actor_group")}
          </div>
          <div className="mb-2 px-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t3">{t("dice_stale_actor_help")}</div>
          {staleRolls.map((r) => renderRoll(r, true))}
        </section>
      )}
    </div>
  );

  const noActor = !personaAvailable && !characterAvailable;

  return (
    <div className="flex max-h-[min(70vh,42rem)] min-w-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 pb-3 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {showTitle && <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{t("dice_tray_title")}</span>}
          <span className={cn("text-[calc(var(--ui-fs)-3px)] text-t3", !showTitle && "ml-auto")}>{t(mode === "normal" ? "dice_tray_mode_normal" : "dice_tray_mode_immersive")}</span>
        </div>
      </div>

      {noActor ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState icon={<Ic.dice />} title={t("dice_no_actor_title")} sub={t("dice_no_actor_sub")} />
          {staleRolls.length > 0 && (
            <div className="space-y-3 p-3">
              <div className="px-1 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-wide text-t3">{t("dice_stale_actor_group")}</div>
              <div className="mb-2 px-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t3">{t("dice_stale_actor_help")}</div>
              {staleRolls.map((r) => renderRoll(r, true))}
            </div>
          )}
        </div>
      ) : isMobile ? (
        // Narrow / BottomSheet: checks sticky on top, only results scroll.
        <div className="flex min-h-0 flex-1 flex-col" data-dice-layout="narrow">
          <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border">{checksRegion}</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {lastError && <div role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-[calc(var(--ui-fs)-3px)] text-danger-text">{lastError}</div>}
            {resultsInner}
          </div>
        </div>
      ) : (
        // Wide: checks on the left, persona|character results on the right.
        <div className="flex min-h-0 flex-1" data-dice-layout="wide">
          <div className="w-[15rem] shrink-0 overflow-y-auto border-r border-border">{checksRegion}</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {lastError && <div role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-[calc(var(--ui-fs)-3px)] text-danger-text">{lastError}</div>}
            {resultsInner}
          </div>
        </div>
      )}

      {mode === "normal" && lane.rolls.length > 0 && (
        <div className="shrink-0 border-t border-border p-3">
          <button
            type="button"
            onClick={() => { void clearLane(chatId, branchId); }}
            aria-label={t("dice_clear_lane")}
            className="min-h-10 w-full rounded-md border border-border px-3 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors hover:border-danger/50 hover:bg-danger-dim hover:text-danger-text"
          >
            {t("dice_clear_all")}
          </button>
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {latestRoll && latestAttempt
          ? t("dice_roll_announcement", { actor: latestRoll.actor.actorLabel, label: latestRoll.checkLabel, total: latestRoll.final?.total ?? latestAttempt.total })
          : ""}
      </span>
    </div>
  );
}
