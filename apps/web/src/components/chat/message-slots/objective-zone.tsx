/**
 * Objective zone — INS-6.
 *
 * The ONLY Objective component that calls `registerMessageSlot`. Registers
 * into the `assistant_header_zone` slot (roles: ["assistant"], order: 1) so
 * `AssistantContextHeader` resolves it alongside identity and (later) the
 * Scene zone. `visible` returns false unless objective is enabled AND an
 * active task exists — so with objective off (or the route all-completed) the
 * zone is not resolved at all and the header reverts to identity-only / Scene.
 *
 * Two layouts, driven by the per-message `objectiveOpen` flag in the
 * header-zone-expansion store (the header itself reads the aggregate to grow
 * the avatar + draw separators — that machinery lives in AssistantContextHeader,
 * NOT here):
 *   • collapsed — one-line summary: [node][progress][active task][chevron].
 *   • expanded  — route actions (regenerate/check) + a row per task with a
 *                 node-state button (click = cycle status) and inline edit.
 *
 * Objective state is intentionally chat-global: every assistant header is a
 * live view of the same current route, not a historical per-message snapshot.
 * Route changes therefore update every mounted Objective zone. Scene differs:
 * its tracker is selected-variant scoped and must preserve cross-message isolation.
 *
 * Render-isolation (CHAT_FRONTEND_REFACTOR_PLAN contract + INSIGHTS_PLAN §6):
 * the snapshot store replaces `activeChat` WHOLESALE whenever any activeChat
 * field changes (snapshot-store.ts `if (!deepEqual(...)) draft.activeChat = next`),
 * so a selector returning the `ObjectiveState` object would re-render every
 * assistant header on unrelated activeChat mutations (messageCount, title,
 * tracker toggle, …). All subscriptions here return PRIMITIVES (boolean /
 * string), compared by `Object.is` → a zone re-renders only when the watched
 * value actually changes. The expanded route uses a JSON-string blob
 * (primitive) + `useMemo` reconstruction for the same reason. See the CS-6
 * note in CoauthorToolActivitySlot.tsx for why `useShallow` on freshly-rebuilt
 * objects does NOT work here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { registerMessageSlot, type MessageSlotContext } from "../../../lib/message-slot-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useHeaderZoneOpen, useHeaderZoneExpansionStore } from "../../../stores/header-zone-expansion.js";
import {
  checkObjectiveCompletionAction,
  generateObjectiveTasksAction,
  updateObjectiveTaskAction,
} from "../../../stores/api-actions/chat-actions.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import type { ObjectiveTask, ObjectiveTaskStatus } from "../../../api/types.js";

const STATUS_ORDER: ObjectiveTaskStatus[] = ["pending", "active", "completed", "abandoned"];

const EMPTY: ObjectiveTask[] = [];

/** Mirrors ObjectiveService.selectActiveTask (first 'active', else 'pending'). */
function pickActiveTask(tasks: ObjectiveTask[]): ObjectiveTask | null {
  return tasks.find((t) => t.status === "active") ?? tasks.find((t) => t.status === "pending") ?? null;
}

function getObjectiveVisibilitySnapshot(): string {
  const chat = useSnapshotStore.getState().activeChat;
  const enabled = chat?.insightsConfig?.objectiveEnabled ?? false;
  const activeTaskId = enabled
    ? pickActiveTask(chat?.insightsObjectiveState?.tasks ?? EMPTY)?.id ?? ""
    : "";
  return `${enabled ? "1" : "0"}:${activeTaskId}`;
}

function ObjectiveZone({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t } = useT();
  const open = useHeaderZoneOpen(messageId, "objectiveOpen");
  const toggle = useHeaderZoneExpansionStore((s) => s.toggle);
  const [busy, setBusy] = useState<"generate" | "check" | null>(null);
  const activeAction = useRef<{ chatId: ChatId; which: "generate" | "check"; controller: AbortController } | null>(null);
  const objectiveChatId = brandId<ChatId>(chatId);

  // ── Primitive selectors only (render-isolation — see file header). ──
  const objectiveEnabled = useSnapshotStore((s) => s.activeChat?.insightsConfig?.objectiveEnabled ?? false);
  const activeId = useSnapshotStore((s) => pickActiveTask(s.activeChat?.insightsObjectiveState?.tasks ?? EMPTY)?.id ?? null);
  const activeStatus = useSnapshotStore((s) => pickActiveTask(s.activeChat?.insightsObjectiveState?.tasks ?? EMPTY)?.status ?? null);
  const activeDesc = useSnapshotStore((s) => pickActiveTask(s.activeChat?.insightsObjectiveState?.tasks ?? EMPTY)?.description ?? null);
  const progress = useSnapshotStore((s) => {
    const tasks = s.activeChat?.insightsObjectiveState?.tasks ?? EMPTY;
    return `${tasks.filter((x) => x.status === "completed").length}/${tasks.length}`;
  });

  // ── Expanded route — a JSON-string blob (primitive → Object.is) so the zone
  //    only re-renders when the route CONTENT changes. Skipped while collapsed
  //    (returns a stable "" sentinel) to keep the common case cheap. ──
  const routeBlob = useSnapshotStore((s) => {
    if (!open) return "";
    const tasks = s.activeChat?.insightsObjectiveState?.tasks ?? EMPTY;
    return tasks.length ? JSON.stringify(tasks.map((tk) => [tk.id, tk.status, tk.description] as const)) : "";
  });
  const tasks = useMemo<ObjectiveTask[]>(() => {
    if (!routeBlob) return EMPTY;
    try {
      const parsed = JSON.parse(routeBlob) as [string, ObjectiveTaskStatus, string][];
      return parsed.map(([id, status, description]) => ({ id, status, description }));
    } catch {
      return EMPTY;
    }
  }, [routeBlob]);

  useEffect(() => {
    setBusy(null);
    return () => {
      const current = activeAction.current;
      if (current?.chatId !== objectiveChatId) return;
      activeAction.current = null;
      current.controller.abort();
    };
  }, [objectiveChatId]);

  function stop(which: "generate" | "check") {
    const current = activeAction.current;
    if (!current || current.chatId !== objectiveChatId || current.which !== which) return;
    activeAction.current = null;
    current.controller.abort();
    setBusy(null);
  }

  async function run(which: "generate" | "check", action: (id: ChatId, signal?: AbortSignal) => Promise<void>) {
    if (activeAction.current) return;
    const current = { chatId: objectiveChatId, which, controller: new AbortController() };
    activeAction.current = current;
    setBusy(which);
    try {
      await action(objectiveChatId, current.controller.signal);
    } catch (err) {
      if (current.controller.signal.aborted) return;
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    } finally {
      if (activeAction.current === current) {
        activeAction.current = null;
        setBusy(null);
      }
    }
  }

  // Backstop: `visible` already gates this, but a state race (toggle flipped
  // while the route is mutating) can momentarily leave no active task.
  if (!objectiveEnabled || !activeId || !activeStatus || !activeDesc) return null;

  // ── Collapsed: one-line summary (click anywhere to expand). ──
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => toggle(messageId, "objectiveOpen")}
        title={t("obj_zone_expand")}
        className={cn(
          "group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5",
          "text-[11px] font-medium text-t3 transition-colors hover:text-t2",
        )}
      >
        <NodeGlyph status={activeStatus} />
        <span className="shrink-0 tabular-nums text-t4">{progress}</span>
        <span className="min-w-0 flex-1 truncate">{activeDesc}</span>
        <Chevron open={false} />
      </button>
    );
  }

  // ── Expanded: route actions + vertical task list + inline edit. ──
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-accent"><Ic.target /></span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t4">{t("obj_zone_route")}</span>
        <span className="shrink-0 tabular-nums text-t4">{progress}</span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => busy === "generate" ? stop("generate") : void run("generate", generateObjectiveTasksAction)}
            disabled={busy !== null && busy !== "generate"}
            className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-accent disabled:opacity-40 md:h-5 md:w-5"
            title={t(busy === "generate" ? "obj_stop_button" : "obj_zone_regenerate")}
            aria-label={t(busy === "generate" ? "obj_stop_button" : "obj_zone_regenerate")}
          >
            {busy === "generate" ? <ActionSpinner /> : <Ic.regen />}
          </button>
          <button
            type="button"
            onClick={() => busy === "check" ? stop("check") : void run("check", checkObjectiveCompletionAction)}
            disabled={(busy !== null && busy !== "check") || (busy === null && tasks.length === 0)}
            className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-success-text disabled:opacity-40 md:h-5 md:w-5"
            title={t(busy === "check" ? "obj_stop_button" : "obj_zone_check")}
            aria-label={t(busy === "check" ? "obj_stop_button" : "obj_zone_check")}
          >
            {busy === "check" ? <ActionSpinner /> : <Ic.checkCircle />}
          </button>
          <button
            type="button"
            onClick={() => toggle(messageId, "objectiveOpen")}
            className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5"
            title={t("obj_zone_collapse")}
          >
            <Chevron open />
          </button>
        </div>
      </div>
      <ol className="flex flex-col">
        {tasks.map((task) => (
          <RouteRow key={task.id} chatId={objectiveChatId} task={task} />
        ))}
      </ol>
    </div>
  );
}

/** A single route row: node-state button (cycles status) + inline-edit description. */
function RouteRow({ chatId, task }: { chatId: ChatId; task: ObjectiveTask }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);

  async function cycleStatus() {
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length];
    try {
      await updateObjectiveTaskAction(chatId, task.id, { status: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    }
  }

  async function commitRename(value: string) {
    setEditing(false);
    if (value !== task.description) {
      try {
        await updateObjectiveTaskAction(chatId, task.id, { description: value });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
      }
    }
  }

  return (
    <li className="flex items-start gap-1.5 py-0.5">
      <button
        type="button"
        onClick={() => void cycleStatus()}
        title={t("obj_cycle_status")}
        className={cn(
          "mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors [&_svg]:h-2 [&_svg]:w-2",
          statusClass(task.status),
        )}
      >
        {task.status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
        {task.status === "completed" && <Ic.check />}
        {task.status === "abandoned" && <Ic.close />}
      </button>
      {editing ? (
        <input
          autoFocus
          defaultValue={task.description}
          onBlur={(e) => void commitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className={cn(
            "min-w-0 flex-1 rounded border border-border2 bg-s2 px-1.5 py-0.5",
            "font-ui text-[11px] text-t2 outline-none focus:border-accent",
          )}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={t("obj_edit_task")}
          className={cn(
            "min-w-0 flex-1 truncate text-left font-ui text-[11px] transition-colors hover:text-t2",
            task.status === "completed" && "text-success-text line-through",
            task.status === "abandoned" && "text-t4 line-through",
            (task.status === "pending" || task.status === "active") && (task.status === "active" ? "text-t2" : "text-t3"),
          )}
        >
          {task.description}
        </button>
      )}
    </li>
  );
}

function ActionSpinner() {
  return <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />;
}

/** Compact status indicator for the collapsed summary (non-interactive there). */
function NodeGlyph({ status }: { status: ObjectiveTaskStatus }) {
  return (
    <span className={cn("flex h-3 w-3 shrink-0 items-center justify-center rounded-full border [&_svg]:h-[7px] [&_svg]:w-[7px]", statusClass(status))}>
      {status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {status === "completed" && <Ic.check />}
    </span>
  );
}

function statusClass(status: ObjectiveTaskStatus): string {
  switch (status) {
    case "active":
      return "border-accent text-accent";
    case "completed":
      return "border-success-text text-success-text";
    case "abandoned":
      return "border-t4 text-t4";
    default:
      return "border-t4 text-t4";
  }
}

/** Inline chevron — no shared chevron icon exists (icons.tsx). Rotates with `open`. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-t4 transition-transform duration-150", open ? "rotate-180" : "rotate-0")}
    >
      <polyline points="3 6 8 11 13 6" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Registration — the ONLY Objective `registerMessageSlot` call. Wired into the
// header by AssistantContextHeader (assistant_header_zone resolution); side-effect
// import in MessageBlock.tsx triggers the registration at app load.
// ────────────────────────────────────────────────────────────────────────────
registerMessageSlot({
  id: "insights-objective-route",
  slot: "assistant_header_zone",
  order: 1,
  roles: ["assistant"],
  visibility: {
    getSnapshot: getObjectiveVisibilitySnapshot,
    subscribe: (_ctx, listener) => {
      let current = getObjectiveVisibilitySnapshot();
      return useSnapshotStore.subscribe(() => {
        const next = getObjectiveVisibilitySnapshot();
        if (next === current) return;
        current = next;
        listener();
      });
    },
  },
  visible: (ctx: MessageSlotContext) => {
    if (ctx.messageRole !== "assistant") return false;
    const chat = useSnapshotStore.getState().activeChat;
    if (!chat?.insightsConfig?.objectiveEnabled) return false;
    const tasks = chat.insightsObjectiveState?.tasks ?? EMPTY;
    return pickActiveTask(tasks) !== null;
  },
  render: (ctx) => <ObjectiveZone chatId={ctx.chatId} messageId={ctx.messageId} />,
});

export { ObjectiveZone };
