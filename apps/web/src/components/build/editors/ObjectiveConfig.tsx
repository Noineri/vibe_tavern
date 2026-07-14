import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import type { ChatId } from "@vibe-tavern/domain";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { EmptyState } from "../../shared/empty-state.js";
import { Toggle } from "../../shared/Toggle.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { inputCls, monoCls, inputPad, lblCls } from "../fields/field-styles.js";
import { useT } from "../../../i18n/context.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import {
  generateObjectiveTasksAction,
  checkObjectiveCompletionAction,
  addObjectiveTaskAction,
  updateObjectiveTaskAction,
  reorderObjectiveTasksAction,
  deleteObjectiveTaskAction,
  setObjectiveDescriptionAction,
  updateObjectiveConfigAction,
} from "../../../stores/api-actions/chat-actions.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
import type { ObjectiveState, ObjectiveTask, ObjectiveTaskStatus } from "../../../api/types.js";

/**
 * Objective Tracker config editor (INSIGHTS_PLAN INS-5). Shown inside the
 * Insights panel when the Objective toggle is ON. Lets the user set the
 * high-level goal, generate / check the task route via the LLM, and manually
 * edit the task tree (status cycle, inline rename, add, delete), and pin a
 * separate secondary provider/model (or follow the chat model) exactly like
 * auto-summary. An advanced section tunes auto-check frequency, injection
 * depth, and custom prompt overrides (empty → the `.md` asset default).
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
  const activeAction = useRef<{ chatId: ChatId; which: "generate" | "check"; controller: AbortController } | null>(null);

  // `activeChat` is guaranteed by the parent (InsightsPanel guards no-chat), but
  // defend in case this is ever mounted standalone — never crash on a missing chat.
  const raw = activeChat?.insightsObjectiveState;
  // Backward compatibility: existing chats may carry an ObjectiveState written
  // before the secondary-model fields existed. Merge defaults instead of
  // casting the raw JSON wholesale; otherwise an absent `useChatModel` would
  // render as false and incorrectly suggest a separate model was configured.
  const state: ObjectiveState = raw && typeof raw === "object" && Array.isArray(raw.tasks)
    ? {
        ...EMPTY_STATE,
        ...raw,
        useChatModel: typeof raw.useChatModel === "boolean" ? raw.useChatModel : true,
        providerProfileId: typeof raw.providerProfileId === "string" ? raw.providerProfileId : null,
        model: typeof raw.model === "string" ? raw.model : null,
      }
    : EMPTY_STATE;

  useEffect(() => {
    setBusy(null);
    return () => {
      const current = activeAction.current;
      if (current?.chatId !== chatId) return;
      activeAction.current = null;
      current.controller.abort();
    };
  }, [chatId]);

  function stop(which: "generate" | "check") {
    const current = activeAction.current;
    if (!current || current.chatId !== chatId || current.which !== which) return;
    activeAction.current = null;
    current.controller.abort();
    setBusy(null);
  }

  async function run(which: "generate" | "check", fn: (id: ChatId, signal: AbortSignal) => Promise<void>) {
    if (activeAction.current) return;
    const current = { chatId, which, controller: new AbortController() };
    activeAction.current = current;
    setBusy(which);
    try {
      await fn(chatId, current.controller.signal);
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

  const spinner = <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-s2/50 p-4">
      {/* Description */}
      <div>
        <label className={lblCls}>{t("obj_description_label")}</label>
        <AutoTextarea
          className={inputCls + " mt-1.5"}
          style={inputPad}
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
          disabled={busy !== null && busy !== "generate"}
          onClick={() => busy === "generate" ? stop("generate") : void run("generate", generateObjectiveTasksAction)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "generate" ? spinner : <Ic.plus />}
          {t(busy === "generate" ? "obj_stop_button" : "obj_generate_button")}
        </button>
        <button
          type="button"
          disabled={(busy !== null && busy !== "check") || (busy === null && state.tasks.length === 0)}
          onClick={() => busy === "check" ? stop("check") : void run("check", checkObjectiveCompletionAction)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:border-accent disabled:opacity-50"
        >
          {busy === "check" ? spinner : <Ic.checkCircle />}
          {t(busy === "check" ? "obj_stop_button" : "obj_check_button")}
        </button>
      </div>

      {/* Task route */}
      <TaskRoute chatId={chatId} tasks={state.tasks} />

      {/* Model selection (secondary insight model — mirrors Summary) */}
      <ModelSelector chatId={chatId} state={state} />

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
  contextWindow: 10,
  injectionDepth: 1,
  generatePrompt: "",
  checkPrompt: "",
  injectPrompt: "",
  useChatModel: true,
  providerProfileId: null,
  model: null,
};

// ─── Task route (ordered list + add) ────────────────────────────────────

function TaskRoute({ chatId, tasks }: { chatId: ChatId; tasks: ObjectiveTask[] }) {
  const { t } = useT();
  const [draft, setDraft] = useState("");

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

  async function moveTask(index: number, offset: -1 | 1) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= tasks.length) return;
    const taskIds = tasks.map((task) => task.id);
    [taskIds[index], taskIds[targetIndex]] = [taskIds[targetIndex], taskIds[index]];
    try {
      await reorderObjectiveTasksAction(chatId, taskIds);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("obj_action_failed"));
    }
  }

  return (
    <div>
      <label className={lblCls}>{t("obj_route_label")}</label>
      {tasks.length === 0 ? (
        <div className="mt-1.5 rounded-md border border-dashed border-border2 bg-s2/40 px-3 py-4">
          <EmptyState
            icon={<Ic.target />}
            title={t("obj_empty_title")}
            sub={t("obj_empty_sub")}
          />
        </div>
      ) : (
        <ol className="mt-1.5 space-y-1">
          {tasks.map((task, index) => (
            <TaskRow
              key={task.id}
              chatId={chatId}
              index={index}
              task={task}
              taskCount={tasks.length}
              onMove={(offset) => void moveTask(index, offset)}
            />
          ))}
        </ol>
      )}
      <div className="mt-2 flex gap-1.5">
        <input
          className={inputCls + " flex-1"}
          style={inputPad}
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

function TaskRow({ chatId, index, task, taskCount, onMove }: { chatId: ChatId; index: number; task: ObjectiveTask; taskCount: number; onMove: (offset: -1 | 1) => void }) {
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
          className={inputCls + " flex-1"}
          style={inputPad}
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
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="flex h-6 w-6 items-center justify-center text-t4 hover:text-t2 disabled:opacity-25"
          title={t("obj_move_task_up")}
          aria-label={t("obj_move_task_up")}
        >
          {Ic.caret("u")}
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === taskCount - 1}
          className="flex h-6 w-6 items-center justify-center text-t4 hover:text-t2 disabled:opacity-25"
          title={t("obj_move_task_down")}
          aria-label={t("obj_move_task_down")}
        >
          {Ic.caret("d")}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          className="shrink-0 text-t4 transition-opacity hover:text-danger-text md:opacity-0 md:group-hover:opacity-100"
          title={t("obj_delete_task")}
        >
          <Ic.del />
        </button>
      </div>
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

// ─── Model selection (secondary insight model — mirrors Summary) ───────

function ModelSelector({ chatId, state }: { chatId: ChatId; state: ObjectiveState }) {
  const { t } = useT();
  const profiles = useProviderDataStore((s) => s.profiles);
  const activeProvider = useMemo(() => profiles.find((p) => p.isActive) ?? profiles[0] ?? null, [profiles]);
  const useChatModel = state.useChatModel;
  const pinnedModel = state.model;

  // The provider whose models we list + use: the chat's active one when
  // `useChatModel`, else the pinned `providerProfileId`.
  const profileId = useChatModel ? (activeProvider?.id ?? "") : (state.providerProfileId ?? "");
  const profile = profiles.find((p) => p.id === profileId) ?? null;

  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  useEffect(() => {
    if (!profileId) { setModels([]); return; }
    let cancelled = false;
    setLoadingModels(true);
    fetchProviderModelsAction(profileId)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models.map((m) => ({ id: m.id, label: m.label ?? m.id })));
      })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [profileId]);

  function save(patch: Partial<Pick<ObjectiveState, "useChatModel" | "providerProfileId" | "model">>) {
    updateObjectiveConfigAction(chatId, patch)
      .catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
  }

  const providerOptions = useMemo(() => profiles.map((p) => ({ id: p.id, label: p.name })), [profiles]);
  // "Use chat model" is strict: show and use the active chat provider's
  // default model, ignoring any secondary pin preserved for when the toggle is
  // turned back off. This mirrors Summary's locked provider+model controls.
  const effectiveModel = (
    useChatModel
      ? (profile?.defaultModel ?? "")
      : (pinnedModel ?? profile?.defaultModel ?? "")
  ).trim();

  return (
    <div className="border-t border-border pt-3">
      <label className={lblCls}>{t("obj_model_label")}</label>
      <label className="mb-2 mt-1.5 flex items-center gap-2 font-ui text-[12px] text-t2">
        <Toggle checked={useChatModel} onChange={(v) => save({ useChatModel: v })} />
        {t("obj_use_chat_model")}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <DropdownSelect
          value={profileId}
          options={providerOptions}
          onChange={(id) => save({ providerProfileId: id, model: null })}
          disabled={useChatModel}
          placeholder={t("obj_provider_label")}
          searchPlaceholder={t("obj_provider_label")}
        />
        <div className="flex items-center gap-1.5">
          <DropdownSelect
            value={effectiveModel}
            options={models}
            onChange={(id) => save({ model: id })}
            disabled={useChatModel || !profileId || loadingModels}
            placeholder={loadingModels ? "…" : t("obj_model_label")}
            searchPlaceholder={t("obj_model_label")}
            className="flex-1"
          />
          <button
            type="button"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-40",
              pinnedModel ? "border-accent bg-accent-dim text-accent" : "border-border text-t4 hover:text-t3",
            )}
            title={pinnedModel ? t("obj_model_unpin") : t("obj_model_pin")}
            onClick={() => save({ model: pinnedModel ? null : (effectiveModel || null) })}
            disabled={useChatModel || !effectiveModel}
          >
            {pinnedModel ? <Ic.starFilled /> : <Ic.star />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Advanced config (frequency / depth / prompts) ──────────────────────

function AdvancedConfig({ chatId, state }: { chatId: ChatId; state: ObjectiveState }) {
  const { t } = useT();

  function saveNumber(field: "autoCheckFrequency" | "contextWindow" | "injectionDepth", raw: string) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    updateObjectiveConfigAction(chatId, { [field]: n }).catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
  }
  function savePrompt(field: "generatePrompt" | "checkPrompt" | "injectPrompt", raw: string) {
    updateObjectiveConfigAction(chatId, { [field]: raw }).catch((err) => toast.error(err instanceof Error ? err.message : t("obj_action_failed")));
  }

  return (
    <div className="mt-2 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className={lblCls}>{t("obj_frequency_label")}</label>
          <input
            type="number"
            min={0}
            defaultValue={state.autoCheckFrequency}
            className={inputCls + " mt-1.5"}
            style={inputPad}
            onBlur={(e) => saveNumber("autoCheckFrequency", e.target.value)}
          />
          <p className="mt-1 font-ui text-[10px] leading-relaxed text-t4">{t("obj_frequency_hint")}</p>
        </div>
        <div>
          <label className={lblCls}>{t("obj_context_window_label")}</label>
          <input
            type="number"
            min={1}
            defaultValue={state.contextWindow}
            className={inputCls + " mt-1.5"}
            style={inputPad}
            onBlur={(e) => saveNumber("contextWindow", e.target.value)}
          />
          <p className="mt-1 font-ui text-[10px] leading-relaxed text-t4">{t("obj_context_window_hint")}</p>
        </div>
        <div>
          <label className={lblCls}>{t("obj_depth_label")}</label>
          <input
            type="number"
            min={1}
            defaultValue={state.injectionDepth}
            className={inputCls + " mt-1.5"}
            style={inputPad}
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
      <PromptField
        label={t("obj_inject_prompt_label")}
        hint={t("obj_prompt_hint")}
        defaultValue={state.injectPrompt}
        onSave={(v) => savePrompt("injectPrompt", v)}
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
        style={inputPad}
        defaultValue={defaultValue}
        placeholder={hint}
        minRows={2}
        onBlur={(e) => { if (e.target.value !== defaultValue) onSave(e.target.value); }}
      />
    </div>
  );
}
