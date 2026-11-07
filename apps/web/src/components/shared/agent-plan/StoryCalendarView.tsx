import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import {
  addStoryDay,
  brandId,
  compareStoryTime,
  findSceneClockField,
  nextStoryDayPart,
  SCENE_CLOCK_MARKER,
  STORY_DAY_PART,
  withStoryClockFields,
  type ChatId,
  type StoryClock,
  type StoryDayPart,
} from "@vibe-tavern/domain";
import type { AgentPlanTask } from "@vibe-tavern/api-contracts";
import { editSceneAction, updateInsightsConfigAction } from "../../../stores/api-actions/chat-actions.js";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { useStorySceneClock } from "../../../hooks/use-story-scene-clock.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useT } from "../../../i18n/context.js";
import type Resources from "../../../i18n/resources.js";
import { cn } from "../../../lib/cn.js";
import { listHeaderCls } from "../../../lib/field-tokens.js";
import { ActionSheet } from "../ActionSheet.js";
import { getModalPortal } from "../modal-helpers.js";
import { Ic } from "../icons.js";
import { ScrollArea } from "../scroll-area.js";
import { NodeGlyph } from "./AgentPlanPanel.js";
import { PART_LABEL_KEYS } from "./story-event-time.js";

/**
 * StoryCalendarView (DIRECTOR_DECK_CALENDAR_PLAN DK-9, mockup §5/§8) — the
 * story curtain's CALENDAR tab body: the clock header (the record's date
 * label in the RP font · the story_cal_day_line caption ("Day N · part") ·
 * the story_cal_next_part ("→ Next") and story_cal_add_day ("+1 day") actions
 * — both write the latest valid scene record through the EXISTING scene edit
 * route, night wraps to the next day's morning) over the day×part grid, and
 * the undated list below it.
 *
 * Grid (§5): one column per day from day 1 to max(today, the last dated
 * event) + 1, four part rows with their glyphs (sunrise/sun/sunset/moon —
 * adopted through the icons registry). Past cells muted, the current cell
 * ringed in accent; dated events render as chips in their (day, part) cell —
 * completed struck through; a chip opens the plan editor at that event (the
 * section's open path). An empty open cell shows «+» and opens the assign
 * list (§5 desktop popover / §8 phone ActionSheet — the responsive dual-mode
 * canon, the ImageGenFineTuningChip shape) with the undated pending events;
 * choosing one sets the event's `at` through the plan hook's save (the SAME
 * write the editor uses — ONE assign path, the parent's). The list opens
 * only when undated pending events exist — an empty list is never drawn.
 *
 * Many days → horizontal scroll (the thin ScrollArea lane), today scrolled
 * into view on mount. Phone (§8): the label column 52 px + three 110 px day
 * columns visible, chips WRAP inside their cell (event titles are user data —
 * wrap, never truncate); the today column header drops its story_cal_day_today
 * suffix (§8's phone drawing) and the part rows drop their glyphs (they do
 * not fit the 52 px column — AD-022 arithmetic).
 *
 * Off state (§8, no marked day field in the chat's scene schema): the
 * calendar-event icon, the title, the explanation, and story_cal_enable —
 * adds STORY_CLOCK_SCENE_FIELDS to the live schema through the EXISTING
 * tracker config write (`updateInsightsConfigAction`, the InsightsPanel /
 * TrackerConfig seam; schemaHash/revision are recomputed server-side by
 * `applySceneTrackerConfigPatch`) and turns the Scene Tracker on when it was
 * off — then the hint under the button names the cost (the ordinary model
 * call). Scene injection off (`tracker.injectLastN === 0` — the same scalar
 * the prompt assembly gates on): one muted line under the header.
 */
export function StoryCalendarView({
  chatId,
  branchId,
  locked,
  onOpenEvent,
}: {
  chatId: string;
  branchId: string;
  /** The streaming lock (the DR-12 rule): the clock writes and the assign
   *  save disable while a sidechat turn streams — the same scope the plan
   *  editor applies to its fields+save. */
  locked: boolean;
  /** A chip click — opens the existing plan editor modal at that event (the
   *  section owns the modal; this view never mounts a second one). */
  onOpenEvent: (taskId: string) => void;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { clockOn, clock, target, sceneState, schema } = useStorySceneClock();
  const trackerEnabled = useSnapshotStore((s) => s.activeChat?.insightsConfig.trackerEnabled ?? false);
  const injectLastN = useSnapshotStore((s) => {
    const n = s.activeChat?.insightsConfig.tracker?.injectLastN;
    return typeof n === "number" ? n : 1;
  });
  const { plan, save } = useAgentPlan({ kind: "chatBranch", chatId, branchId });
  const [enabling, setEnabling] = useState(false);
  // The phone assign sheet's cell (§8); the desktop popover keeps its open
  // state per cell (CellPlus).
  const [sheetCell, setSheetCell] = useState<{ day: number; part: StoryDayPart } | null>(null);

  const partLabel = (part: StoryDayPart | null): string =>
    part === null ? "—" : t(PART_LABEL_KEYS[part]);

  // ── Writes ──────────────────────────────────────────────────────────────────

  // The clock moves: rewrite the marked day (and part) fields of the latest
  // valid record through the EXISTING scene edit route — never a new write
  // surface. The free-form date label stays out of the write: it is the
  // model's display text (the tracker hint keeps it consistent on the next
  // reply); the rankable clock is day+part.
  const writeClock = (next: { day: number; part: StoryDayPart | null }) => {
    if (target === null || sceneState === null || locked) return;
    const dayKey = findSceneClockField(schema, SCENE_CLOCK_MARKER.day)?.key;
    if (dayKey === undefined) return;
    const partKey = findSceneClockField(schema, SCENE_CLOCK_MARKER.part)?.key;
    const nextSceneState: Record<string, unknown> = { ...sceneState, [dayKey]: next.day };
    // A null part (the day's start) is only storable when the part field is
    // unmarked — a marked part field keeps its last value on a move whose
    // target part is null (writing nothing preserves the unreadable value the
    // reader then still reads as null).
    if (partKey !== undefined && next.part !== null) nextSceneState[partKey] = next.part;
    void editSceneAction(brandId<ChatId>(chatId), {
      branchId,
      messageId: target.messageId,
      variantId: target.variantId,
    }, nextSceneState).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t("scn_zone_action_failed"));
    });
  };

  // The enable write (§8): add the canonical clock fields to the live schema
  // (the domain adder — idempotent, never destroys an authored byte) and turn
  // the tracker on when it was off.
  const enableTime = () => {
    if (enabling) return;
    setEnabling(true);
    void updateInsightsConfigAction(brandId<ChatId>(chatId), {
      insightsConfig: {
        tracker: { schema: withStoryClockFields(schema) },
        ...(trackerEnabled ? {} : { trackerEnabled: true }),
      },
    })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t("insights_save_failed"));
      })
      .finally(() => setEnabling(false));
  };

  // Assigning an undated event to a cell: the `at` stamp through the plan
  // hook's save — the SAME write the editor uses (the PUT; no new route).
  // ONE path: the desktop popover rows, the phone sheet rows and the sheet's
  // own action all land here.
  const assignTask = (taskId: string, cell: { day: number; part: StoryDayPart }) => {
    if (locked) return;
    void save({
      ...plan,
      tasks: plan.tasks.map((task) => (
        task.id === taskId ? { ...task, at: { day: cell.day, part: cell.part } } : task
      )),
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t("agent_plan_revert_error"));
    });
  };

  // ── Derived (the grid's data) ───────────────────────────────────────────────

  const today = clock?.day ?? 0;
  const lastDatedDay = useMemo(
    () => plan.tasks.reduce((max, task) => Math.max(max, task.at?.day ?? 0), 0),
    [plan.tasks],
  );
  const lastDay = Math.max(today, lastDatedDay) + 1;
  const days = useMemo(() => Array.from({ length: lastDay }, (_, index) => index + 1), [lastDay]);
  // Dated events keyed by cell: a null part ranks with morning (the domain
  // rule), so its chip shows in the morning row.
  const eventsByCell = useMemo(() => {
    const map = new Map<string, AgentPlanTask[]>();
    for (const task of plan.tasks) {
      if (task.at === undefined) continue;
      const row = task.at.part ?? STORY_DAY_PART.morning;
      const key = `${task.at.day}:${row}`;
      const list = map.get(key);
      if (list) list.push(task);
      else map.set(key, [task]);
    }
    return map;
  }, [plan.tasks]);
  const undatedPending = useMemo(
    () => plan.tasks.filter((task) => task.at === undefined && task.status === "pending"),
    [plan.tasks],
  );

  // ── Today scrolled into view on mount ───────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  const labelCol = isMobile ? 52 : 64;
  const cellW = isMobile ? 110 : 128;
  useEffect(() => {
    if (scrolledRef.current) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    scrolledRef.current = true;
    const todayDay = clock?.day ?? 1;
    viewport.scrollLeft = Math.max(0, labelCol + (todayDay - 1) * cellW - 8);
  }, [clock, labelCol, cellW]);

  // ── The off state (§8) — before the grid, after every hook ─────────────────
  if (!clockOn) {
    return (
      <div data-testid="story-cal-off" className="flex flex-col items-center px-5 pb-3.5 pt-2.5 text-center">
        <span className="flex shrink-0 justify-center text-accent [&_svg]:h-6 [&_svg]:w-6"><Ic.calendarEvent /></span>
        <div className="mt-2 shrink-0 text-[calc(var(--ui-fs)+1px)] text-t1">{t("story_cal_off_title")}</div>
        <p className="mb-3 mt-1 shrink-0 text-[calc(var(--ui-fs)-1px)] leading-normal text-t3">{t("story_cal_off_hint")}</p>
        <button
          type="button"
          data-testid="story-cal-enable"
          disabled={enabling}
          onClick={enableTime}
          className="flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-accent px-[18px] font-ui text-[calc(var(--ui-fs)-1px)] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("story_cal_enable")}
        </button>
        {/* The tracker-off hint: names the cost (§8) — shown only when this
            click will also turn the tracker on. */}
        {!trackerEnabled && (
          <p data-testid="story-cal-enable-tracker-hint" className="mt-2 shrink-0 text-[calc(var(--ui-fs)-4px)] leading-relaxed text-t4">
            {t("story_cal_enable_tracker_hint")}
          </p>
        )}
      </div>
    );
  }

  const cellState = (day: number, part: StoryDayPart): "past" | "now" | "open" => {
    if (clock === null) return "open";
    const order = compareStoryTime({ day, part }, clock);
    if (order < 0) return "past";
    if (order === 0) return "now";
    return "open";
  };

  return (
    <div className="flex min-w-0 flex-col">
      {/* The clock header (§5 desktop / §8 phone): the date label, the
          day·part line, the no-record hint, and the two clock-move buttons
          (their own full-width row on the phone — the wrap). */}
      <div data-testid="story-cal-header" className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2">
        {clock?.label !== null && clock?.label !== undefined && clock.label !== "" && (
          <span className="font-body text-[calc(var(--ui-fs)+1px)] text-t1">{clock.label}</span>
        )}
        <span className="flex items-center gap-1.5 whitespace-nowrap font-ui text-[calc(var(--ui-fs)-2px)] text-t2">
          <span className="shrink-0 text-accent"><Ic.clock /></span>
          {clock !== null
            ? t("story_cal_day_line", { day: clock.day, part: partLabel(clock.part) })
            : t("story_cal_day_line_unset")}
        </span>
        {clock === null && (
          <span data-testid="story-cal-no-record-hint" className="text-[calc(var(--ui-fs)-3px)] text-t3">
            {t("story_cal_no_record_hint")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2 max-md:w-full max-md:flex-1">
          <button
            type="button"
            data-testid="story-cal-next-part"
            disabled={target === null || locked}
            onClick={() => {
              if (clock !== null) writeClock(nextStoryDayPart(clock));
            }}
            className={cellButtonCls}
          >
            {t("story_cal_next_part")}
          </button>
          <button
            type="button"
            data-testid="story-cal-add-day"
            disabled={target === null || locked}
            onClick={() => {
              if (clock !== null) writeClock(addStoryDay(clock));
            }}
            className={cellButtonCls}
          >
            {t("story_cal_add_day")}
          </button>
        </div>
      </div>
      {/* Scene injection off (§8): one muted line under the header — the
          tracker still tracks, the model just never sees it. */}
      {injectLastN === 0 && (
        <div data-testid="story-cal-inject-off" className="flex items-center gap-1.5 pb-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
          <span className="shrink-0"><Ic.eyeOff /></span>
          <span>{t("story_cal_inject_off")}</span>
        </div>
      )}
      {/* CNR-8o: the grid rides the thin horizontal ScrollArea lane. */}
      <ScrollArea
        orientation="horizontal"
        scrollbarSize="thin"
        data-testid="story-cal-scroll"
        className="w-full overflow-hidden rounded-lg border border-border2"
        viewportProps={{ ref: viewportRef }}
      >
        <div
          data-testid="story-cal-grid"
          className="grid"
          style={{ gridTemplateColumns: `${labelCol}px repeat(${days.length}, ${cellW}px)` }}
        >
          {/* Header row: the corner + one cell per day (the today column
              carries the "· today" suffix of story_cal_day_today on desktop;
              §8's phone drops it). */}
          <div className="border-b border-r border-border2" />
          {days.map((day) => {
            const isToday = clock !== null && day === clock.day;
            return (
              <div
                key={`h${day}`}
                data-testid={`story-cal-day-header-${day}`}
                className={cn(
                  "flex items-center justify-center border-b border-r border-border2 px-1 py-1 text-center font-ui text-[calc(var(--ui-fs)-4px)] font-medium",
                  isToday ? "text-accent" : "text-t3",
                )}
              >
                {isToday && !isMobile
                  ? t("story_cal_day_today", { day })
                  : t("story_cal_day_column", { day })}
              </div>
            );
          })}
          {/* The four part rows. */}
          {PART_ROWS.map(({ part, Glyph, labelKey }) => (
            <CellRow
              key={part}
              part={part}
              glyph={<span className="shrink-0"><Glyph /></span>}
              label={t(labelKey)}
              mobile={isMobile}
              days={days}
              clock={clock}
              cellState={cellState}
              eventsByCell={eventsByCell}
              undated={undatedPending}
              onOpenEvent={onOpenEvent}
              onPick={assignTask}
              onMobileAssign={setSheetCell}
              partLabel={partLabel}
            />
          ))}
        </div>
      </ScrollArea>
      {/* §8's phone assign sheet (the shared ActionSheet; its built-in
          cancel is the shared cancel key). */}
      <ActionSheet
        open={sheetCell !== null && isMobile}
        onClose={() => setSheetCell(null)}
        title={sheetCell !== null
          ? t("story_cal_assign_title", { day: sheetCell.day, part: partLabel(sheetCell.part) })
          : ""}
        items={sheetCell === null ? [] : undatedPending.map((task) => ({
          icon: <NodeGlyph status={task.status} />,
          label: task.title,
          action: () => {
            if (sheetCell !== null) assignTask(task.id, sheetCell);
          },
        }))}
      />
      {/* Below the grid (§5): the undated events in plan order. */}
      <div className="mt-3">
        <div data-testid="story-cal-undated-title" className={cn(listHeaderCls, "mb-1")}>{t("story_cal_undated_title")}</div>
        <ol data-testid="story-cal-undated-list" className="flex flex-col">
          {plan.tasks.filter((task) => task.at === undefined).map((task) => (
            <li key={task.id} className="flex items-center gap-1.5 py-0.5">
              <NodeGlyph status={task.status} />
              <span
                className={cn(
                  "min-w-0 flex-1 font-ui text-[calc(var(--ui-fs)-3px)]",
                  task.status === "completed" && "text-success-text line-through",
                  task.status === "abandoned" && "text-t4 line-through",
                  task.status === "active" && "text-t2",
                  task.status === "pending" && "text-t3",
                )}
              >
                {task.title}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ─── Cell internals ─────────────────────────────────────────────────────────────

/** The four part rows in story order with their glyphs (§5) — the same
 *  STORY_DAY_PART order the domain derives everything from. */
const PART_ROWS: Array<{
  part: StoryDayPart;
  Glyph: () => ReactNode;
  labelKey: keyof Resources["en"];
}> = [
  { part: STORY_DAY_PART.morning, Glyph: Ic.sunrise, labelKey: "story_clock_part_morning" },
  { part: STORY_DAY_PART.day, Glyph: Ic.sun, labelKey: "story_clock_part_day" },
  { part: STORY_DAY_PART.evening, Glyph: Ic.sunset, labelKey: "story_clock_part_evening" },
  { part: STORY_DAY_PART.night, Glyph: Ic.moon, labelKey: "story_clock_part_night" },
];

/** Localized day-part labels — DK-10 moved the map to story-event-time.ts
 *  (the chip formatter reads the same ONE derivation). */


/** The part rows' label cell — desktop the glyph + the label (§5), phone the
 *  label alone (§8; the glyph does not fit the 52 px column). */
function CellRow({
  part,
  glyph,
  label,
  mobile,
  days,
  clock,
  cellState,
  eventsByCell,
  undated,
  onOpenEvent,
  onPick,
  onMobileAssign,
  partLabel,
}: {
  part: StoryDayPart;
  glyph: ReactNode;
  label: string;
  mobile: boolean;
  days: number[];
  clock: StoryClock | null;
  cellState: (day: number, part: StoryDayPart) => "past" | "now" | "open";
  eventsByCell: Map<string, AgentPlanTask[]>;
  undated: AgentPlanTask[];
  onOpenEvent: (taskId: string) => void;
  onPick: (taskId: string, cell: { day: number; part: StoryDayPart }) => void;
  onMobileAssign: (cell: { day: number; part: StoryDayPart }) => void;
  partLabel: (part: StoryDayPart | null) => string;
}) {
  return (
    <>
      <div className="flex items-center gap-1 border-b border-r border-border2 px-1 py-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t3">
        {!mobile && glyph}
        <span>{label}</span>
      </div>
      {days.map((day) => {
        const state = cellState(day, part);
        const chips = eventsByCell.get(`${day}:${part}`) ?? [];
        return (
          <div
            key={`${day}:${part}`}
            data-testid={`story-cal-cell-${day}-${part}`}
            data-cell-state={state}
            className={cn(
              "relative border-b border-r border-border2 p-1",
              state === "past" && "bg-s2/40",
              state === "now" && "ring-2 ring-inset ring-accent",
            )}
          >
            {chips.map((task) => (
              <button
                key={task.id}
                type="button"
                data-testid="story-cal-chip"
                data-task-id={task.id}
                onClick={() => onOpenEvent(task.id)}
                className={cn(
                  "mb-0.5 block w-full cursor-pointer rounded-[5px] border border-border2 bg-s2 px-1.5 py-0.5 text-left font-ui text-[calc(var(--ui-fs)-3px)] leading-snug transition-colors last:mb-0 hover:bg-s3 hover:text-t1",
                  task.status === "completed" && "border-success-text/30 text-success-text line-through",
                  task.status === "abandoned" && "text-t4 line-through",
                )}
              >
                {task.title}
              </button>
            ))}
            {/* The «+» affordance only on empty OPEN cells with something to
                assign — an empty list is never drawn. */}
            {state !== "past" && chips.length === 0 && undated.length > 0 && (
              <CellPlus
                day={day}
                part={part}
                mobile={mobile}
                label={partLabel(part)}
                dayNumber={day}
                undated={undated}
                onPick={onPick}
                onMobileAssign={onMobileAssign}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** The empty cell's «+» affordance: phone a plain button that opens the
 *  ActionSheet (the parent's cell state), desktop a Radix popover trigger —
 *  ONE Popover.Root owns the click on both platforms, its content
 *  desktop-only (the ImageGenFineTuningChip dual-mode shape). */
function CellPlus({
  day,
  part,
  mobile,
  label,
  dayNumber,
  undated,
  onPick,
  onMobileAssign,
}: {
  day: number;
  part: StoryDayPart;
  mobile: boolean;
  /** The localized part word in the story_cal_assign_title caption. */
  label: string;
  dayNumber: number;
  undated: AgentPlanTask[];
  onPick: (taskId: string, cell: { day: number; part: StoryDayPart }) => void;
  onMobileAssign: (cell: { day: number; part: StoryDayPart }) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const caption = t("story_cal_assign_title", { day: dayNumber, part: label });
  const plus = (
    <button
      type="button"
      data-testid={`story-cal-plus-${dayNumber}-${part}`}
      data-day={dayNumber}
      data-part={part}
      aria-label={caption}
      className="absolute inset-0 flex h-full w-full cursor-pointer items-center justify-center text-t4 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 max-md:opacity-50"
      onClick={mobile ? () => onMobileAssign({ day: dayNumber, part }) : undefined}
    >
      <Ic.plus />
    </button>
  );
  if (mobile) return plus;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{plus}</Popover.Trigger>
      <Popover.Portal container={getModalPortal() ?? document.body}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          data-testid="story-cal-assign-list"
          className="glass-blur z-[220] w-[230px] rounded-lg border border-border2 bg-glass-bg p-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none"
        >
          <div className="px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{caption}</div>
          {undated.map((task) => (
            <button
              key={task.id}
              type="button"
              data-testid="story-cal-assign-option"
              data-task-id={task.id}
              onClick={() => {
                setOpen(false);
                onPick(task.id, { day: dayNumber, part });
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
            >
              <NodeGlyph status={task.status} />
              <span className="min-w-0">{task.title}</span>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** fork #1 of StoryDeckView.tsx (deckButtonCls) — the curtain body's compact
 *  button at the §8 phone height (34 px, flex-1 half-row); the deck's twin
 *  carries the forks count. */
const cellButtonCls = cn(
  "flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-s3 px-2.5",
  "font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1",
  "disabled:cursor-not-allowed disabled:opacity-40",
  "max-md:h-[34px] max-md:min-w-0 max-md:flex-1 max-md:justify-center",
);
