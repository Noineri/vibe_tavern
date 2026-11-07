import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { AgentPlanOwner } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useAgentPlan } from "../../../hooks/use-agent-plan.js";
import {
  countRemaining,
  AgentPlanPanel,
} from "../agent-plan/AgentPlanPanel.js";
import { AgentPlanEditorModal } from "../agent-plan/AgentPlanEditorModal.js";
import { StoryCurtainTabs } from "../agent-plan/StoryCurtainTabs.js";
import { StoryDeckView } from "../agent-plan/StoryDeckView.js";
import { StoryCalendarView } from "../agent-plan/StoryCalendarView.js";
import {
  DEFAULT_STORY_CURTAIN_TAB,
  STORY_CURTAIN_TABS,
  useStoryCurtainTabStore,
} from "../../../stores/story-curtain-tab-store.js";

/**
 * AgentPlanSection (PM-6, EXPERIENCE_COPILOT_PLAN_MODE_PLAN; AS-6b2 moved
 * from the copilot editors' CopilotPlanSection) — the agent shell's mount of
 * the shared agent-plan mechanic, extracted from the shell when the
 * thread-scoped todo mechanic was removed (arch-gate file ratchet: the
 * shell's line budget shrinks by moving code out, never by growing).
 *
 * Owns ONE `useAgentPlan` subscription for the owner — the panel and the
 * editor modal read the SAME owner cache entry the shell's controller writes
 * into via the hook's `applyToolResult` (routed from `plan` tool results) —
 * plus the editor modal's local open state. The shell passes the streaming
 * lock; the model's rewrite and the user's edit can never race.
 *
 * Placement contract (unchanged from the todo-panel era): the caller pins this
 * section DIRECTLY below `AgentContextMeter` — it never scrolls with the
 * feed. The panel hides itself while the plan is empty.
 *
 * DR-9: a BRANCH owner (the sidechat's story plan) renders as the curtain
 * (mockup §5/§9 — this section is the mobile sidechat pane's mount; the
 * desktop sidechat drops the section entirely, P1, and the chat column's
 * strip becomes the story plan's desktop home, DR-11). Script/mini-app
 * owners pass no presentation props: today's inline panel, byte-identical.
 *
 * DK-6 (mockup §1/§7): the branch curtain gains its second header row — the
 * tab strip (events/deck/calendar with muted counts, remembered per chat,
 * default events) — and the per-tab bodies: the events tab keeps the
 * default body (the premise + the task list, byte-identical), the deck tab
 * renders `StoryDeckView`, the calendar tab `StoryCalendarView` (DK-9; its
 * chips open the editor here, focused on the clicked event). The tab row
 * lives HERE (not in the strip) because the curtain has TWO mounts — the
 * strip (desktop + the mobile Chat pane) and this section's AgentChatPane
 * mount (the mobile sidechat pane) — and the deck renders on BOTH
 * (responsive dual-mode canon).
 */
export function AgentPlanSection({
  owner,
  locked,
  actions,
  headerActionsBefore,
  showEditorInCollapsedRow,
  flashTitle,
  flashTone,
}: {
  owner: AgentPlanOwner;
  locked: boolean;
  /** DR-11: forwarded to the panel — the story strip's call-director
   *  (the `actions` slot: end of the collapsed row, after the editor button
   *  in the curtain header). */
  actions?: ReactNode;
  /** DR-11: forwarded — rendered in the curtain header BEFORE the editor
   *  button (§5's interleaved order); on the phone the curtain header's
   *  actions take their own row (§9). */
  headerActionsBefore?: ReactNode;
  /** DR-11: forwarded — the strip hides the editor button in its collapsed
   *  row (§1: the row carries only the call-director action; the curtain header
   *  keeps the editor button whatever this says). */
  showEditorInCollapsedRow?: boolean;
  /** DR-11: forwarded — the passed-check flash (§4, `agent_plan_story_flash_done`)
   *  on the success tint while set (curtain presentation only). */
  flashTitle?: string | null;
  /** DK-9: forwarded — the flash's tone (§6's accent promotion tone; the
   *  success tone is the default). */
  flashTone?: "success" | "accent";
}) {
  const { t } = useT();
  const { plan, save } = useAgentPlan(owner);
  const [editorOpen, setEditorOpen] = useState(false);
  // DK-9: a calendar CHIP opens the editor AT that event — the focus rides
  // into the editor modal (scroll + accent ring on the row); the plain
  // editor button clears it.
  const [editorFocusTaskId, setEditorFocusTaskId] = useState<string | null>(null);
  const openEventAt = (taskId: string) => {
    setEditorFocusTaskId(taskId);
    setEditorOpen(true);
  };
  const story = owner.kind === "chatBranch";

  // ── DK-6: the story curtain's tabs + bodies (curtain-only) ───────────────
  // The tab choice is remembered per chat in the plain tab store (default
  // events — the events body IS today's curtain). The events tab passes
  // NO body override (the panel renders its default premise + task list,
  // byte-identical); deck and calendar pass their bodies. The deck tab's
  // view needs the streaming lock (the director call disables while a
  // sidechat turn streams — the DR-12 rule).
  const chatId = story ? owner.chatId : null;
  const branchId = story ? owner.branchId : null;
  const tab = useStoryCurtainTabStore((s) =>
    chatId !== null ? (s.tabsByChat[chatId] ?? DEFAULT_STORY_CURTAIN_TAB) : DEFAULT_STORY_CURTAIN_TAB,
  );
  const curtainTabs =
    chatId !== null && branchId !== null ? (
      <StoryCurtainTabs chatId={chatId} branchId={branchId} eventsCount={countRemaining(plan.tasks)} />
    ) : undefined;
  const curtainBody =
    chatId === null || branchId === null
      ? undefined
      : tab === STORY_CURTAIN_TABS.deck
        ? <StoryDeckView chatId={chatId} branchId={branchId} locked={locked} />
        : tab === STORY_CURTAIN_TABS.calendar
          ? (
            <StoryCalendarView
              chatId={chatId}
              branchId={branchId}
              locked={locked}
              onOpenEvent={openEventAt}
            />
          )
          : undefined;

  // R4 (mockup §5): the revert-to-work write — the completed event becomes
  // the ONE active event, the currently-active one steps back to pending;
  // the write rides the hook's `save` (the editor's PUT — no new write
  // surface) and respects the same streaming lock.
  const revertTask = story
    ? (taskId: string) => {
      if (locked) return;
      void save({
        ...plan,
        tasks: plan.tasks.map((task) => (
          task.id === taskId
            ? { ...task, status: "active" }
            : task.status === "active"
              ? { ...task, status: "pending" }
              : task
        )),
      }).catch(() => {
        toast.error(t("agent_plan_revert_error"));
      });
    }
    : undefined;

  return (
    <>
      <AgentPlanPanel
        plan={plan}
        onOpenEditor={() => {
          setEditorFocusTaskId(null);
          setEditorOpen(true);
        }}
        locked={locked}
        presentation={story ? "curtain" : undefined}
        onRevertTask={revertTask}
        actions={actions}
        headerActionsBefore={headerActionsBefore}
        showEditorInCollapsedRow={showEditorInCollapsedRow}
        flashTitle={flashTitle}
        flashTone={flashTone}
        curtainTabs={curtainTabs}
        curtainBody={curtainBody}
      />
      {/* The editor locks (fields + save) while a turn streams so the model's
          rewrite and the user's edit can never race. */}
      <AgentPlanEditorModal
        owner={owner}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        locked={locked}
        focusTaskId={editorFocusTaskId}
      />
    </>
  );
}
