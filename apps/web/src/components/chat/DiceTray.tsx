import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { SegmentedControl } from "../shared/SegmentedControl.js";

interface DiceActorOption {
  id: string;
  name: string;
}

export interface DiceTrayProps {
  chatId: string;
  branchId: string;
  mode: DiceMode;
  definitions: DiceDefinitionsResponse;
  lane: DiceLaneState;
  character: DiceActorOption | null;
  persona: DiceActorOption | null;
  showTitle?: boolean;
}

interface CheckRowProps {
  scriptLabel: string;
  check: DiceDefinitionsResponse["scripts"][number]["checks"][number];
  existingRoll: DiceRollSnapshot | undefined;
  mode: DiceMode;
  rolling: boolean;
  onRoll: () => void;
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

function CheckRow({ scriptLabel, check, existingRoll, mode, rolling, onRoll }: CheckRowProps) {
  const { t } = useT();
  const replacing = mode === "normal" && existingRoll != null;
  const retrying = mode === "immersive" && existingRoll != null;
  const actionLabel = replacing
    ? t("dice_reroll")
    : retrying && existingRoll.policy === "replace"
      ? t("dice_roll_again_replace")
      : retrying
        ? t("dice_roll_again")
        : t("dice_roll");

  return (
    <div className="flex items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{check.label}</span>
          <span className="font-mono text-[calc(var(--ui-fs)-3px)] text-t3">{check.notation}</span>
        </div>
        <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3">{scriptLabel}</div>
        {check.help && <div className="mt-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t2">{check.help}</div>}
        {rolling && (
          <div className="mt-2">
            <DiceFaces
              faceShape={check.faceShape}
              notation={check.notation}
              size="sm"
              maxVisible={6}
              rollKey={`loading:${scriptLabel}:${check.id}`}
              loading={{ count: notationDiceCount(check.notation) }}
            />
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={rolling}
        onClick={onRoll}
        aria-label={t("dice_roll_check", { label: check.label })}
        className="min-h-9 shrink-0 rounded-md border border-accent/40 bg-accent-dim px-3 py-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-accent-t transition-colors hover:bg-accent/15 disabled:cursor-wait disabled:opacity-50"
      >
        {rolling ? t("dice_rolling") : actionLabel}
      </button>
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
            size="md"
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
            <span className="build-tag text-t2">{roll.actor.actorLabel}</span>
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
            size="sm"
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
        <span className="build-tag text-t2">{t(roll.resolution === "strict" ? "dice_resolution_strict" : "dice_resolution_narrative")}</span>
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

function RollGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <div className="px-1 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-wide text-t3">{title}</div>}
      {children}
    </section>
  );
}

export function DiceTray({ chatId, branchId, mode, definitions, lane, character, persona, showTitle = true }: DiceTrayProps) {
  const { t } = useT();
  const lastError = useDiceLastError(chatId, branchId);
  const roll = useDiceStore((state) => state.roll);
  const removeRoll = useDiceStore((state) => state.removeRoll);
  const clearLane = useDiceStore((state) => state.clearLane);
  const setIncluded = useDiceStore((state) => state.setIncluded);
  const chooseAttempt = useDiceStore((state) => state.chooseAttempt);
  const [rollingKeys, setRollingKeys] = useState<Set<string>>(() => new Set());

  const hasActorChecks = (actorType: DiceActorType) => definitions.scripts.some((script) =>
    script.checks.some((check) => check.actors.includes(actorType)),
  );
  const personaAvailable = persona != null && hasActorChecks("persona");
  const characterAvailable = character != null && hasActorChecks("character");
  const [actorType, setActorType] = useState<DiceActorType>(() => personaAvailable ? "persona" : "character");

  useEffect(() => {
    if (actorType === "persona" && !personaAvailable && characterAvailable) setActorType("character");
    if (actorType === "character" && !characterAvailable && personaAvailable) setActorType("persona");
  }, [actorType, characterAvailable, personaAvailable]);

  const actor = actorType === "persona" ? persona : character;
  const currentRolls = useMemo(() => lane.rolls.filter((item) => {
    if (item.actor.actorType === "character") return item.actor.actorId === character?.id;
    return item.actor.actorId === persona?.id;
  }), [character?.id, lane.rolls, persona?.id]);
  const staleRolls = useMemo(() => lane.rolls.filter((item) => !currentRolls.includes(item)), [currentRolls, lane.rolls]);
  const latestRoll = lane.rolls.at(-1);
  const latestAttempt = latestRoll ? finalAttempt(latestRoll) : null;

  const runRoll = async (scriptId: string, checkId: string) => {
    if (!actor) return;
    const key = `${scriptId}:${checkId}:${actorType}:${actor.id}`;
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

  return (
    <div className="flex max-h-[min(70vh,42rem)] min-w-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 pb-3 pt-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {showTitle && <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{t("dice_tray_title")}</span>}
          <span className={cn("text-[calc(var(--ui-fs)-3px)] text-t3", !showTitle && "ml-auto")}>{t(mode === "normal" ? "dice_tray_mode_normal" : "dice_tray_mode_immersive")}</span>
        </div>
        <SegmentedControl
          value={actorType}
          onChange={(value) => setActorType(value as DiceActorType)}
          compact
          fill
          options={[
            {
              value: "persona",
              label: t("dice_actor_persona"),
              disabled: !personaAvailable,
              tooltip: !persona ? t("dice_actor_persona_missing") : !personaAvailable ? t("dice_actor_no_checks") : undefined,
            },
            {
              value: "character",
              label: t("dice_actor_character"),
              disabled: !characterAvailable,
              tooltip: !characterAvailable ? t("dice_actor_no_checks") : undefined,
            },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {lastError && <div role="alert" className="m-3 rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-[calc(var(--ui-fs)-3px)] text-danger-text">{lastError}</div>}

        {!personaAvailable && !characterAvailable && (
          <EmptyState icon={<Ic.dice />} title={t("dice_no_actor_title")} sub={t("dice_no_actor_sub")} />
        )}

        {(personaAvailable || characterAvailable) && (
          <section className="border-b border-border">
            {definitions.scripts.map((script) => {
              const checks = script.checks.filter((check) => check.actors.includes(actorType));
              if (checks.length === 0) return null;
              return (
                <div key={script.scriptId}>
                  {checks.map((check) => {
                    const existingRoll = lane.rolls.find((item) => item.scriptId === script.scriptId && item.checkId === check.id && item.actor.actorType === actorType && item.actor.actorId === actor?.id);
                    const key = `${script.scriptId}:${check.id}:${actorType}:${actor?.id ?? "missing"}`;
                    return (
                      <CheckRow
                        key={check.id}
                        scriptLabel={script.scriptLabel}
                        check={check}
                        existingRoll={existingRoll}
                        mode={mode}
                        rolling={rollingKeys.has(key)}
                        onRoll={() => { void runRoll(script.scriptId, check.id); }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </section>
        )}

        <div className="space-y-3 p-3">
          {currentRolls.length > 0 && (
            <RollGroup>{currentRolls.map((item) => renderRoll(item, false))}</RollGroup>
          )}
          {staleRolls.length > 0 && (
            <RollGroup title={t("dice_stale_actor_group")}>
              <div className="mb-2 px-1 text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t3">{t("dice_stale_actor_help")}</div>
              {staleRolls.map((item) => renderRoll(item, true))}
            </RollGroup>
          )}
          {lane.rolls.length === 0 && (
            <div className="py-4 text-center text-[calc(var(--ui-fs)-3px)] text-t3">{t("dice_no_pending")}</div>
          )}
        </div>
      </div>

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
