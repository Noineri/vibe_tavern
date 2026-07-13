import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { ChatId } from "@vibe-tavern/domain";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { EmptyState } from "../../shared/empty-state.js";
import { inputCls, monoCls, lblCls } from "../fields/field-styles.js";
import { useT } from "../../../i18n/context.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import {
  generateObjectiveTasksAction,
  checkObjectiveCompletionAction,
  addObjectiveTaskAction,
  updateObjectiveTaskAction,
  deleteObjectiveTaskAction,
  setObjectiveDescriptionAction,
  updateObjectiveConfigAction,
} from "../../../stores/api-actions/chat-actions.js";
import type { ObjectiveState, ObjectiveTask, ObjectiveTaskStatus } from "../../../api/types.js";

/**
 * Objective Tracker config editor (INSIGHTS_PLAN INS-5). Shown inside the
 * Insights panel when the Objective toggle is ON. Lets the user set the
 * high-level goal, generate / check the task route via the LLM, and manually
 * edit the task tree (status cycle, inline rename, add, delete). An advanced
 * section tunes auto-check frequency, injection depth, and custom prompt
 * overrides (empty → the `.md` asset default).
 *
 * Reads the live state from the snapshot store (`activeChat.insightsObjectiveState`);
 * every mutating action round-trips the snapshot, so the tree refreshes on
 * completion. Inputs are UNCONTROLLED (defaultValue + onBlur save): the
 * objective description and task text are never clobbered by a background
 * auto-check syncing the snapshot mid-edit (auto-check touches task statuses,
 * not these fields, but uncontrolled avoids the race entirely).
 */
export function ObjectiveConfig({ chatId }: { chatId: ChatId }) {
  const { t } = useT();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const [busy, setBusy] = useState<"generate" | "check" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // `activeChat` is guaranteed by the parent (InsightsPanel guards no-chat), but
  // defend in case this is ever mounted standalone — never crash on a missing chat.
  const raw = activeChat?.insightsObjectiveState;
  const state: ObjectiveState = raw && typeof raw === "object" && Array.isArray(raw.tasks)
    ? (raw as ObjectiveState)
    : EMPTY_STATE;

  async function run(which: "generate" | "check", fn: (id: ChatId, signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    setBusy(which);
    const ctrl = new AbortController();
    try {
      await fn(chatId, ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    } finally {
      setBusy(null);
    }
  }

  const spinner = <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-s2/50 p-4">
      {/* Description */}
      <div>
        <label className={lblCls}>{t("obj_description_label")}</label>
        <AutoTextarea
          className={inputCls + " mt-1.5"}
          defaultValue={state.objectiveDescription}
          placeholder={t("obj_description_placeholder")}
          minRows={2}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== state.objectiveDescription) {
              setObjectiveDescriptionAction(chatId, v).catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
            }
          }}
        />
      </div>

      {/* Generate / Check */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("generate", (id, signal) => generateObjectiveTasksAction(id, signal))}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "generate" ? spinner : <Ic.plus />}
          {t("obj_generate_button")}
        </button>
        <button
          type="button"
          disabled={busy !== null || state.tasks.length === 0}
          onClick={() => void run("check", (id, signal) => checkObjectiveCompletionAction(id, signal))}
          className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:border-accent disabled:opacity-50"
        >
          {busy === "check" ? spinner : <Ic.checkCircle />}
          {t("obj_check_button")}
        </button>
      </div>

      {/* Task route */}
      <TaskRoute chatId={chatId} tasks={state.tasks} />

      {/* Advanced config */}
      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3 hover:text-t2"
        >
          <span className={cn("transition-transform")}>{Ic.caret(advancedOpen ? "d" : "r")}</span>
          {t("obj_advanced_label")}
        </button>
        {advancedOpen && <AdvancedConfig chatId={chatId} state={state} />}
      </div>
    </div>
  );
}

const EMPTY_STATE: ObjectiveState = {
  objectiveDescription: "",
  tasks: [],
  autoCheckFrequency: 0,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
};

// ─── Task route (ordered list + add) ────────────────────────────────────

function TaskRoute({ chatId, tasks }: { chatId: ChatId; tasks: ObjectiveTask[] }) {
  const { t } = useT();
  const [draft, setDraft] = useState("");

  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border2 bg-s2/40 px-3 py-4">
        <EmptyState
          icon={<Ic.target />}
          title={t("obj_empty_title")}
          sub={t("obj_empty_sub")}
        />
      </div>
    );
  }

  async function addTask() {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    try {
      await addObjectiveTaskAction(chatId, v);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    }
  }

  return (
    <div>
      <label className={lblCls}>{t("obj_route_label")}</label>
      <ol className="mt-1.5 space-y-1">
        {tasks.map((task, i) => (
          <TaskRow key={task.id} chatId={chatId} index={i} task={task} />
        ))}
      </ol>
      <div className="mt-2 flex gap-1.5">
        <input
          className={inputCls + " flex-1"}
          value={draft}
          placeholder={t("obj_add_task_placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTask(); } }}
        />
        <button
          type="button"
          onClick={() => void addTask()}
          disabled={!draft.trim()}
          className="inline-flex items-center justify-center rounded-md border border-border2 bg-s2 px-2.5 text-t2 hover:border-accent disabled:opacity-40"
          title={t("obj_add_task_button")}
        >
          <Ic.plus />
        </button>
      </div>
    </div>
  );
}

// ─── Single task row ────────────────────────────────────────────────────

const STATUS_ORDER: ObjectiveTaskStatus[] = ["pending", "active", "completed", "abandoned"];

function TaskRow({ chatId, index, task }: { chatId: ChatId; index: number; task: ObjectiveTask }) {
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
  async function saveDescription(v: string) {
    setEditing(false);
    if (v !== task.description) {
      try {
        await updateObjectiveTaskAction(chatId, task.id, { description: v });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
      }
    }
  }
  async function remove() {
    try {
      await deleteObjectiveTaskAction(chatId, task.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    }
  }

  return (
    <li className="group flex items-center gap-2 rounded-md border border-border bg-s2 px-2 py-1.5">
      <span className="w-5 shrink-0 text-center font-mono text-[10px] text-t4">{index + 1}</span>
      <StatusDot status={task.status} onClick={() => void cycleStatus()} title={t("obj_cycle_status")} />
      {editing ? (
        <input
          autoFocus
          defaultValue={task.description}
          className={inputCls + " flex-1 py-0.5"}
          onBlur={(e) => void saveDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") setEditing(false); }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn(
            "min-w-0 flex-1 truncate text-left font-ui text-[12px] hover:text-accent",
            task.status === "completed" && "text-success-text line-through",
            task.status === "abandoned" && "text-t4 line-through",
            (task.status === "pending" || task.status === "active") && "text-t2",
          )}
          title={t("obj_edit_task")}
        >
          {task.description}
        </button>
      )}
      <button
        type="button"
        onClick={() => void remove()}
        className="shrink-0 text-t4 opacity-0 transition-opacity hover:text-danger-text group-hover:opacity-100"
        title={t("obj_delete_task")}
      >
        <Ic.del />
      </button>
    </li>
  );
}

function StatusDot({ status, onClick, title }: { status: ObjectiveTaskStatus; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors", statusClass(status))}
    >
      {status === "active" && <span className="h-2 w-2 rounded-full bg-current" />}
      {status === "completed" && <Ic.check />}
      {status === "abandoned" && <Ic.close />}
    </button>
  );
}

function statusClass(status: ObjectiveTaskStatus): string {
  switch (status) {
    case "active": return "border-accent text-accent";
    case "completed": return "border-success-text text-success-text";
    case "abandoned": return "border-t4 text-t4";
    default: return "border-t4 text-t4";
  }
}

// ─── Advanced config (frequency / depth / prompts) ──────────────────────

function AdvancedConfig({ chatId, state }: { chatId: ChatId; state: ObjectiveState }) {
  const { t } = useT();

  function saveNumber(field: "autoCheckFrequency" | "injectionDepth", raw: string) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    updateObjectiveConfigAction(chatId, { [field]: n }).catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
  }
  function savePrompt(field: "generatePrompt" | "checkPrompt" | "injectPrompt", raw: string) {
    updateObjectiveConfigAction(chatId, { [field]: raw }).catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
  }

  return (
    <div className="mt-2 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={lblCls}>{t("obj_frequency_label")}</label>
          <input
            type="number"
            min={0}
            defaultValue={state.autoCheckFrequency}
            className={inputCls + " mt-1.5"}
            onBlur={(e) => saveNumber("autoCheckFrequency", e.target.value)}
          />
          <p className="mt-1 font-ui text-[10px] leading-relaxed text-t4">{t("obj_frequency_hint")}</p>
        </div>
        <div>
          <label className={lblCls}>{t("obj_depth_label")}</label>
          <input
            type="number"
            min={1}
            defaultValue={state.injectionDepth}
            className={inputCls + " mt-1.5"}
            onBlur={(e) => saveNumber("injectionDepth", e.target.value)}
          />
          <p className="mt-1 font-ui text-[10px] leading-relaxed text-t4">{t("obj_depth_hint")}</p>
        </div>
      </div>
      <PromptField
        label={t("obj_generate_prompt_label")}
        hint={t("obj_prompt_hint")}
        defaultValue={state.generatePrompt}
        onSave={(v) => savePrompt("generatePrompt", v)}
      />
      <PromptField
        label={t("obj_check_prompt_label")}
        hint={t("obj_prompt_hint")}
        defaultValue={state.checkPrompt}
        onSave={(v) => savePrompt("checkPrompt", v)}
      />
    </div>
  );
}

function PromptField({ label, hint, defaultValue, onSave }: { label: string; hint: string; defaultValue: string; onSave: (v: string) => void }) {
  return (
    <div>
      <label className={lblCls}>{label}</label>
      <AutoTextarea
        className={monoCls + " mt-1.5"}
        defaultValue={defaultValue}
        placeholder={hint}
        minRows={2}
        onBlur={(e) => { if (e.target.value !== defaultValue) onSave(e.target.value); }}
      />
    </div>
  );
}
