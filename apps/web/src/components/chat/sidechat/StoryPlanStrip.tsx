/**
 * StoryPlanStrip (DIRECTOR_MODE_PLAN DR-11) — the chat column's story-plan
 * row: the active branch's story plan as a compact, CONSTANT-height strip
 * pinned above the message list, shared by the desktop surface and the
 * mobile Chat pane (mount: the first child of `PlayModeChatPane`).
 *
 * Renders NOTHING while the active branch's plan is empty — without a plan
 * the chat is exactly as before this unit; the strip disappears only when
 * the plan is emptied in the editor (A8 keeps it after the last event
 * completes: the story-done label, `agent_plan_story_done`).
 *
 * Composition, not a fork: the strip is a thin mount of the shared
 * `AgentPlanSection` — the SAME `useAgentPlan` owner cache, editor modal,
 * and R4 revert write the mobile sidechat pane uses — extended with the
 * strip's curtain extras: no editor button in the collapsed row (§1),
 * check-now label (`story_plan_check_now`) before the editor button in the curtain header (§5's
 * interleaved order, the panel's `headerActionsBefore` slot), and
 * call-the-director label (`story_plan_call_director`) through the `actions` slot (the row's text-button
 * chrome, `agentPlanTextButtonCls`).
 *
 * Seams — each ONE path, never a second:
 * - plan: `useAgentPlan` (chatBranch owner = chat + active branch) — the
 *   section's own subscription; the strip only REFRESHES that entry
 *   (`refreshAgentPlan`) whenever the chat's objective state changes in the
 *   snapshot (the same seam the objective zone reads). The tracker executes
 *   the current event and the server's follow-back writes completed
 *   statuses into the plan row — the re-GET is how the row learns the next
 *   event; there is no second fetch path and no second objective
 *   derivation.
 * - passed-check flash (R4): the projection copies plan event ids into
 *   goal ids 1:1 (`projectStoryPlanGoals`), so a goal-status transition of
 *   the plan's CURRENT event IS "the check passed this event" — the strip
 *   shows the passed-check flash (`agent_plan_story_flash_done`) on the success tint for ~6 s, then the
 *   refreshed plan's next event. No toast (§4).
 * - streaming: the sidechat turn's `isSending` is controller-local state;
 *   the shell's controller mirrors it (keyed by owner) into
 *   `useAgentStreamingStore` — a one-way derived view; the strip subscribes
 *   for the sidechat of the same chat+branch and disables the call-director
 *   action while it streams (§4).
 * - check-now (`story_plan_check_now`, P3): the goal tracker's EXISTING manual check —
 *   `checkObjectiveCompletionAction`, the same api-action the objective
 *   zone's check button runs, moved here from the message headers (§8).
 *
 * DR-12: the strip owns the call itself — it already reads the active
 * chat/branch from the snapshot, so `onCallDirector` stays an override
 * (tests / future callers) and the default handler runs the
 * `callDirector` store action (open + switch + one queued message). The
 * button is ENABLED while a handler exists (always, since DR-12) and
 * disabled only while a sidechat turn streams (§4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useAgentStreamingStore } from "../../../stores/agent-streaming-store.js";
import { checkObjectiveCompletionAction } from "../../../stores/api-actions/chat-actions.js";
import { refreshAgentPlan, useAgentPlan } from "../../../hooks/use-agent-plan.js";
import { AgentPlanSection } from "../../shared/agent-shell/AgentPlanSection.js";
import { agentPlanTextButtonCls, pickCurrent } from "../../shared/agent-plan/AgentPlanPanel.js";
import { selectSidechatOwner } from "./sidechat-host.js";
import { agentOwnerKey } from "../../../lib/agent-host-registry.js";
import { callDirector } from "../../../stores/sidechat-call-director-store.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";

/** §4: the flash lingers ~6 s before the row moves to the next event.
 *  Exported for the strip's tests (the parked-timer pin). */
export const STORY_PLAN_FLASH_MS = 6000;

export function StoryPlanStrip({ onCallDirector }: { onCallDirector?: () => void } = {}) {
  const { t } = useT();
  const chatId = useSnapshotStore((s) => s.activeChat?.id ?? null);
  const branchId = useSnapshotStore((s) => s.activeChat?.activeBranchId ?? null);
  // The branch plan's owner — the SAME cache entry the section subscribes to
  // (a second subscription to one cache is the shell's own pattern).
  const planOwner = chatId !== null && branchId !== null
    ? { kind: "chatBranch" as const, chatId, branchId }
    : undefined;
  const { plan } = useAgentPlan(planOwner);
  // Keep the flash detection reading the plan the CURRENT render sees.
  const planRef = useRef(plan);
  planRef.current = plan;

  // ── Streaming mirror (the sidechat of THIS chat+branch) ──────────────────
  const sidechatOwner = selectSidechatOwner(
    chatId !== null ? { id: chatId } : null,
    branchId !== null ? { id: branchId } : null,
  );
  const streamingKey = sidechatOwner !== null ? agentOwnerKey(sidechatOwner) : null;
  const streaming = useAgentStreamingStore((s) => streamingKey !== null && Boolean(s.streaming[streamingKey]));

  // ── The passed-check flash + the plan refresh (R4) ───────────────────────
  // The chat's objective state — the SAME store seam the objective zone
  // reads. The strip subscribes to the state object (one mounted instance,
  // not a per-message zone — the wholesale activeChat replace re-renders it,
  // a cheap single-node cost) and derives a PRIMITIVE revision for the
  // effect's dep, so the flash/refresh logic runs once per real goal-status
  // change. The ref carries the value into the effect (the render this
  // effect follows IS the moment the revision changed — no getState needed).
  const objectiveState = useSnapshotStore((s) => s.activeChat?.insightsObjectiveState);
  const objectiveRef = useRef(objectiveState);
  objectiveRef.current = objectiveState;
  const goalRevision = useMemo(
    () => (objectiveState?.shortTermGoals ?? []).map((goal) => `${goal.id}:${goal.status}`).join(","),
    [objectiveState],
  );
  const [flashTitle, setFlashTitle] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goalStatusesRef = useRef<ReadonlyMap<string, string>>(new Map());

  const stopFlash = useCallback(() => {
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setFlashTitle((current) => (current === null ? current : null));
  }, []);

  useEffect(() => {
    const state = objectiveRef.current;
    const next = new Map((state?.shortTermGoals ?? []).map((goal) => [goal.id, goal.status] as const));
    const previous = goalStatusesRef.current;
    goalStatusesRef.current = next;
    // First sight of this chat's goals (mount, or a tracker that just got
    // its goals): nothing passed yet — the hook's own mount GET covers it.
    if (previous.size === 0) return;
    if (planOwner === undefined) return;
    // The objective state moved — the server's follow-back has (or is about
    // to have) written the new statuses into the plan row: re-run the plan's
    // one GET so the row learns the next current event.
    refreshAgentPlan(planOwner);
    // The flash: the plan's CURRENT event (the cached plan, pre-refresh)
    // just turned completed in the tracker — goal ids ARE event ids.
    const current = pickCurrent(planRef.current.tasks);
    if (
      current !== null &&
      next.get(current.id) === "completed" &&
      previous.get(current.id) !== "completed"
    ) {
      stopFlash();
      setFlashTitle(current.title);
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null;
        setFlashTitle(null);
      }, STORY_PLAN_FLASH_MS);
    }
    // The effect intentionally runs on the objective REVISION only — the
    // refs (plan, owner literal) always carry the current render's values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalRevision]);

  // A chat/branch switch (or unmount) drops any live flash — it belongs to
  // the switched-away conversation's event.
  useEffect(() => stopFlash, [stopFlash, chatId, branchId]);

  // ── Check-now — the tracker's existing manual check (P3) ────────
  const [checkBusy, setCheckBusy] = useState(false);
  const checkAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // Chat switch / unmount aborts an in-flight manual check (the objective
    // zone's cleanup pattern — a late settle must not reset another chat's
    // busy flag).
    return () => {
      const current = checkAbortRef.current;
      if (current === null) return;
      checkAbortRef.current = null;
      current.abort();
      setCheckBusy(false);
    };
  }, [chatId]);

  async function runCheck(): Promise<void> {
    if (checkBusy || chatId === null) return;
    const controller = new AbortController();
    checkAbortRef.current = controller;
    setCheckBusy(true);
    try {
      await checkObjectiveCompletionAction(brandId<ChatId>(chatId), controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    } finally {
      if (checkAbortRef.current === controller) {
        checkAbortRef.current = null;
        setCheckBusy(false);
      }
    }
  }

  // ── Call the director (DR-12) ───────────────────────────────────────
  // The default handler runs the store action; the catch reuses the
  // assignment-failure copy — the switch is the same (chat, kind) write the
  // profile surfaces make, and the action still opens + queues on failure
  // (its own ordering contract, see the store's module doc).
  const callDirectorDefault = useCallback(() => {
    if (chatId === null || branchId === null) return;
    void callDirector(chatId, branchId).catch(() => {
      toast.error(t("copilot_profile_assign_failed"));
    });
  }, [chatId, branchId, t]);
  const callDirectorHandler = onCallDirector ?? callDirectorDefault;

  if (planOwner === undefined) return null;
  // Empty plan → no strip: `PlayModeChatPane` renders byte-identically (the
  // panel's own emptiness rule, mirrored so the modal never mounts either).
  if (plan.tasks.length === 0 && plan.goal === "" && plan.constraints.length === 0) return null;

  const checkNowButton = (
    <button
      type="button"
      data-testid="story-plan-check-now"
      data-busy={checkBusy ? "true" : "false"}
      disabled={checkBusy}
      onClick={() => void runCheck()}
      className={agentPlanTextButtonCls}
    >
      {t("story_plan_check_now")}
    </button>
  );
  // §4/§1: the row's text-button chrome composed with `shrink-0
  // whitespace-nowrap` (the base already carries shrink-0). Disabled while a
  // sidechat turn streams; enabled whenever a handler exists — DR-12 wired
  // the default (the store action), so the interim no-handler state is gone.
  const callDirectorButton = (
    <button
      type="button"
      data-testid="story-plan-call-director"
      disabled={streaming}
      onClick={callDirectorHandler}
      className={cn(agentPlanTextButtonCls, "whitespace-nowrap")}
    >
      {t("story_plan_call_director")}
    </button>
  );

  return (
    <AgentPlanSection
      owner={planOwner}
      locked={streaming}
      showEditorInCollapsedRow={false}
      headerActionsBefore={checkNowButton}
      actions={callDirectorButton}
      flashTitle={flashTitle}
    />
  );
}
