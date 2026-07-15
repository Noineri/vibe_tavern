/**
 * Scene zone — SCN-12.
 *
 * The ONLY Scene component that calls `registerMessageSlot`. Registers into the
 * `assistant_header_zone` slot (roles: ["assistant"], order: 2) so
 * `AssistantContextHeader` resolves it alongside identity + Objective (order 1).
 *
 * Two layouts, driven by the per-message `sceneOpen` flag in the
 * header-zone-expansion store (the header reads the aggregate to grow the avatar
 * + draw separators — that machinery lives in AssistantContextHeader, NOT here):
 *   • collapsed — one-line summary: [icon][kv summary][chevron].
 *   • expanded  — controls (Generate/Update/Edit/Delete, Cancel while generating)
 *                 + a recursive bounded read view of the selected variant's scene
 *                 state. `Edit Scene` opens the shared Modal/BottomSheet editor.
 *
 * VISIBILITY (the core of the focused-latest-header contract):
 *   - Tracker OFF → not resolved at all (true zero DOM).
 *   - Latest assistant message on the active branch → always mounts when Tracker
 *     is on + a variant is selected: `Generate Scene` (no record) or `Update
 *     Scene` (stale record) or the read view + permanent Update/Edit/Delete
 *     (valid record).
 *   - Older assistant message → mounts ONLY when its selected variant has a
 *     CURRENT VALID record; missing/stale older records stay absent (filled via
 *     Build → Insights → Scene → History, not the header).
 *
 * The visibility snapshot is a primitive encoding trackerEnabled + isLatest +
 * selectedVariantId + record-freshness, so the host re-resolves only when one of
 * those flips (render-isolation: a mutation for message A yields 0 commits for B).
 *
 * Variant ownership is immutable: every action keys off the selected variant's
 * `id`, never its mutable `variantIndex`. The generation cache
 * (scene-generation-store) is a UX hint; the server coordinator + the freshness
 * guards are the correctness boundary.
 *
 * Runner note: imports `./scene-editor.js` for the structured editor (SCN-12d).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { brandId, type ChatId, type SceneTrackerDsl } from "@vibe-tavern/domain";
import { registerMessageSlot, type MessageSlotContext } from "../../../lib/message-slot-registry.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useHeaderZoneOpen, useHeaderZoneExpansionStore } from "../../../stores/header-zone-expansion.js";
import { useIsSceneGenerating, useSceneGenerationStore } from "../../../stores/scene-generation-store.js";
import { useSceneRenderStore } from "../../../stores/scene-render-store.js";
import {
  generateSceneAction,
  editSceneAction,
  deleteSceneAction,
  cancelSceneAction,
  getSceneStatusAction,
} from "../../../stores/api-actions/chat-actions.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { Modal } from "../../shared/Modal.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { SceneStateView } from "../../shared/SceneStateView.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SceneEditorBody } from "./scene-editor.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers — pure, read the store by snapshot (called from getSnapshot + visible)
// ────────────────────────────────────────────────────────────────────────────

/** The active branch's latest assistant message id ("" when none). Iterates the
 *  ordered id list backwards so the common case (latest at the tail) is O(1). */
function getLatestAssistantMessageId(state: { messageOrder: string[]; messagesById: Record<string, { id: string; role?: string }> }): string {
  for (let i = state.messageOrder.length - 1; i >= 0; i--) {
    const msg = state.messagesById[state.messageOrder[i]];
    if (msg?.role === "assistant") return msg.id;
  }
  return "";
}

/** The selected variant id for a message ("" when none / no selection). */
function selectedVariantIdOf(state: { messagesById: Record<string, { variants?: { id: string }[]; selectedVariantIndex: number | null }> }, messageId: string): string {
  const msg = state.messagesById[messageId];
  if (!msg) return "";
  const idx = msg.selectedVariantIndex;
  return msg.variants?.[idx ?? -1]?.id ?? "";
}

/** Record freshness vs the live config (mirrors server isSceneRecordCurrent). */
function isRecordFresh(record: { schemaHash: string; configRevision: number } | null, config: { schemaHash: string; revision: number }): boolean {
  return !!record && record.schemaHash === config.schemaHash && record.configRevision === config.revision;
}

function getSceneVisibilitySnapshot(ctx: MessageSlotContext): string {
  const s = useSnapshotStore.getState();
  const enabled = s.activeChat?.insightsConfig?.trackerEnabled ?? false;
  const variantId = selectedVariantIdOf(s, ctx.messageId);
  const isLatest = ctx.messageId === getLatestAssistantMessageId(s);
  const config = s.activeChat?.insightsConfig?.tracker;
  const record = s.messagesById[ctx.messageId]?.sceneTracker ?? null;
  const fresh = config ? isRecordFresh(record, config) : false;
  return `${enabled ? 1 : 0}:${isLatest ? 1 : 0}:${variantId}:${fresh ? 1 : 0}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Zone component
// ────────────────────────────────────────────────────────────────────────────

function SceneZone({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const open = useHeaderZoneOpen(messageId, "sceneOpen");
  const toggle = useHeaderZoneExpansionStore((s) => s.toggle);
  const renderVariant = useSceneRenderStore((s) => s.variant);
  const objectiveChatId = brandId<ChatId>(chatId);

  // ── Primitive selectors only (render-isolation — see objective-zone header). ──
  const variantId = useSnapshotStore((s) => selectedVariantIdOf(s, messageId));
  const recordBlob = useSnapshotStore((s) => {
    const r = s.messagesById[messageId]?.sceneTracker ?? null;
    return r ? JSON.stringify(r) : "";
  });
  const configBlob = useSnapshotStore((s) => {
    const c = s.activeChat?.insightsConfig?.tracker;
    return c ? JSON.stringify([c.schema, c.schemaHash, c.revision]) : "";
  });
  const generating = useIsSceneGenerating(variantId);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeGen = useRef<{ variantId: string; controller: AbortController } | null>(null);

  const record = useMemo(() => (recordBlob ? (JSON.parse(recordBlob) as { sceneState: Record<string, unknown>; schemaHash: string; configRevision: number }) : null), [recordBlob]);
  const [schema, schemaHash, revision] = useMemo<[SceneTrackerDsl, string, number]>(() => {
    if (!configBlob) return [{}, "", 0];
    try {
      const [sc, h, r] = JSON.parse(configBlob) as [SceneTrackerDsl, string, number];
      return [sc ?? {}, h ?? "", typeof r === "number" ? r : 0];
    } catch {
      return [{}, "", 0];
    }
  }, [configBlob]);
  const fresh = isRecordFresh(record, { schemaHash, revision });
  const sceneState = record?.sceneState ?? null;

  // ── Hydrate the generating flag from the server on mount (latest only). The
  //    server coordinator is authoritative; this re-attaches a reload/multi-tab
  //    in-flight job to the cache so the header reflects it. Only the latest
  //    message can be auto-generating in SCN-12, so older zones skip the call. ──
  const isLatest = useSnapshotStore((s) => messageId === getLatestAssistantMessageId(s));
  useEffect(() => {
    if (!isLatest || !variantId) return;
    let cancelled = false;
    void (async () => {
      try {
        await getSceneStatusAction(objectiveChatId, targetOf(messageId, variantId, useSnapshotStore.getState()));
      } catch {
        /* non-authoritative hydration; ignore */
      }
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLatest, variantId, messageId]);

  useEffect(() => {
    return () => {
      const current = activeGen.current;
      if (current?.variantId !== variantId) return;
      activeGen.current = null;
      current.controller.abort();
    };
  }, [variantId]);

  function targetOf(msgId: string, varId: string, state: { messagesById: Record<string, { branchId?: string }> }) {
    return { branchId: state.messagesById[msgId]?.branchId ?? "", messageId: msgId, variantId: varId };
  }

  async function runGenerate() {
    if (!variantId || activeGen.current) return;
    const controller = new AbortController();
    activeGen.current = { variantId, controller };
    try {
      await generateSceneAction(objectiveChatId, targetOf(messageId, variantId, useSnapshotStore.getState()), controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) toast.error(err instanceof Error ? err.message : t("scn_zone_action_failed"));
    } finally {
      if (activeGen.current?.variantId === variantId) activeGen.current = null;
    }
  }

  async function runCancel() {
    const current = activeGen.current;
    activeGen.current = null;
    if (current) current.controller.abort();
    try {
      await cancelSceneAction(objectiveChatId, targetOf(messageId, variantId, useSnapshotStore.getState()));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("scn_zone_action_failed"));
    }
  }

  async function runDelete() {
    setConfirmDelete(false);
    try {
      await deleteSceneAction(objectiveChatId, targetOf(messageId, variantId, useSnapshotStore.getState()));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("scn_zone_action_failed"));
    }
  }

  async function runEdit(nextState: Record<string, unknown>) {
    setEditing(false);
    try {
      await editSceneAction(objectiveChatId, targetOf(messageId, variantId, useSnapshotStore.getState()), nextState);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("scn_zone_action_failed"));
    }
  }

  if (!variantId) return null;

  const hasRecord = !!record;

  // ── Collapsed: one-line kv summary (click to expand). ──
  if (!open) {
    return (
      <>
        <CustomTooltip content={t("scn_zone_expand")}>
          <button
            type="button"
            onClick={() => toggle(messageId, "sceneOpen")}
            aria-label={t("scn_zone_expand")}
            className={cn(
              "group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5",
              "text-[11px] font-medium text-t3 transition-colors hover:text-t2",
            )}
          >
            <SceneGlyph generating={generating} hasRecord={hasRecord} fresh={fresh} />
            <SceneKvSummary schema={schema} state={sceneState} placeholder={t(hasRecord ? (fresh ? "scn_zone_summary_fresh" : "scn_zone_summary_stale") : "scn_zone_summary_empty")} />
            <Chevron open={false} />
          </button>
        </CustomTooltip>
        {editing && <SceneEditorModal open={editing} isMobile={isMobile} schema={schema} state={sceneState ?? {}} onClose={() => setEditing(false)} onSave={runEdit} t={t} />}
      </>
    );
  }

  // ── Expanded: controls + recursive read view. ──
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-accent"><SceneGlyph generating={generating} hasRecord={hasRecord} fresh={fresh} /></span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-t4">{t("scn_zone_title")}</span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* Generate (no record) OR Update (stale/valid record). While generating → Cancel. */}
          {generating ? (
            <CustomTooltip content={t("scn_zone_cancel")}>
              <button
                type="button"
                onClick={() => void runCancel()}
                className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-danger md:h-5 md:w-5"
                aria-label={t("scn_zone_cancel")}
              >
                <ActionSpinner />
              </button>
            </CustomTooltip>
          ) : (
            <CustomTooltip content={t(hasRecord ? "scn_zone_update" : "scn_zone_generate")}>
              <button
                type="button"
                onClick={() => void runGenerate()}
                disabled={!hasRecord && !isLatest}
                className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-accent disabled:opacity-40 md:h-5 md:w-5"
                aria-label={t(hasRecord ? "scn_zone_update" : "scn_zone_generate")}
              >
                {hasRecord ? <Ic.regen /> : <Ic.plus />}
              </button>
            </CustomTooltip>
          )}
          {/* Edit (valid record only — editing a stale/wrong-schema record is meaningless). */}
          {fresh && (
            <CustomTooltip content={t("scn_zone_edit")}>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5"
                aria-label={t("scn_zone_edit")}
              >
                <Ic.edit />
              </button>
            </CustomTooltip>
          )}
          {/* Delete (any record present). */}
          {hasRecord && (
            <CustomTooltip content={t("scn_zone_delete")}>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-danger md:h-5 md:w-5"
                aria-label={t("scn_zone_delete")}
              >
                <Ic.del />
              </button>
            </CustomTooltip>
          )}
          <CustomTooltip content={t("scn_zone_collapse")}>
            <button
              type="button"
              onClick={() => toggle(messageId, "sceneOpen")}
              className="flex h-7 w-7 items-center justify-center rounded text-t4 transition-colors hover:bg-s2 hover:text-t2 md:h-5 md:w-5"
              aria-label={t("scn_zone_collapse")}
            >
              <Chevron open />
            </button>
          </CustomTooltip>
        </div>
      </div>

      {generating && (
        <div className="flex items-center gap-1.5 text-[11px] text-t4">
          <ActionSpinner />
          <span>{t("scn_zone_generating")}</span>
        </div>
      )}

      {/* Read view — rendered in the shared variant (selectable in the
          TrackerConfig Preview); stale records render dimmed. */}
      {hasRecord && sceneState && (
        <SceneStateView schema={schema} data={sceneState} variant={renderVariant} stale={!fresh} />
      )}
      {!hasRecord && !generating && (
        <p className="text-[11px] text-t4">{t("scn_zone_no_record")}</p>
      )}

      {editing && (
        <SceneEditorModal open={editing} isMobile={isMobile} schema={schema} state={sceneState ?? {}} onClose={() => setEditing(false)} onSave={runEdit} t={t} />
      )}
      {confirmDelete && (
        <ConfirmDelete open={confirmDelete} isMobile={isMobile} onCancel={() => setConfirmDelete(false)} onConfirm={() => void runDelete()} t={t} />
      )}
    </div>
  );
}

/** Collapsed one-line kv summary: first few scalar leaves as `key: value`. */
function SceneKvSummary({ schema, state, placeholder }: { schema: SceneTrackerDsl; state: Record<string, unknown> | null; placeholder: string }) {
  const parts = useMemo(() => {
    if (!state) return [] as string[];
    const out: string[] = [];
    for (const [key, node] of Object.entries(schema)) {
      if (node.$type === "string" || node.$type === "number" || node.$type === "boolean") {
        const v = state[key];
        if (v != null) out.push(`${key}: ${node.$type === "boolean" ? (v ? "✓" : "✗") : String(v)}`);
      }
      if (out.length >= 3) break;
    }
    return out;
  }, [schema, state]);
  if (!parts.length) return <span className="min-w-0 flex-1 truncate text-t4">{placeholder}</span>;
  return <span className="min-w-0 flex-1 truncate">{parts.join(" · ")}</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// Editor modal — desktop Modal / mobile BottomSheet (SCN-12d body in scene-editor).
// ────────────────────────────────────────────────────────────────────────────

function SceneEditorModal({ open, isMobile, schema, state, onClose, onSave, t }: {
  open: boolean;
  isMobile: boolean;
  schema: SceneTrackerDsl;
  state: Record<string, unknown>;
  onClose: () => void;
  onSave: (next: Record<string, unknown>) => void;
  t: TFunc;
}) {
  const body = <SceneEditorBody schema={schema} initial={state} onCancel={onClose} onSave={onSave} t={t} />;
  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose} title={t("scn_zone_edit")}>
        {body}
      </BottomSheet>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={t("scn_zone_edit")}>
      <div className="w-[min(92vw,560px)] max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-surface p-4">
        {body}
      </div>
    </Modal>
  );
}

function ConfirmDelete({ open, isMobile, onCancel, onConfirm, t }: {
  open: boolean;
  isMobile: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: TFunc;
}) {
  const body = (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-t2">{t("scn_zone_delete_confirm")}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-sm text-t3 hover:bg-s2">{t("scn_zone_delete_cancel")}</button>
        <button type="button" onClick={onConfirm} className="rounded bg-danger px-3 py-1.5 text-sm text-white hover:opacity-90">{t("scn_zone_delete")}</button>
      </div>
    </div>
  );
  if (isMobile) {
    return <BottomSheet open={open} onClose={onCancel} title={t("scn_zone_delete")}>{body}</BottomSheet>;
  }
  return <Modal open={open} onClose={onCancel} compact title={t("scn_zone_delete")}><div className="w-[min(92vw,400px)] rounded-xl border border-border bg-surface">{body}</div></Modal>;
}

// ────────────────────────────────────────────────────────────────────────────
// Glyphs / chrome
// ────────────────────────────────────────────────────────────────────────────

function SceneGlyph({ generating, hasRecord, fresh }: { generating: boolean; hasRecord: boolean; fresh: boolean }) {
  if (generating) return <ActionSpinner />;
  if (!hasRecord) return <span className="shrink-0 text-t4"><Ic.target /></span>;
  return <span className={cn("shrink-0", fresh ? "text-accent" : "text-warning")}><Ic.target /></span>;
}

function ActionSpinner() {
  return <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0 text-t4 transition-transform duration-150", open ? "rotate-180" : "rotate-0")}>
      <polyline points="3 6 8 11 13 6" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Registration — the ONLY Scene `registerMessageSlot` call. Wired into the
// header by AssistantContextHeader (assistant_header_zone resolution); side-effect
// import in MessageBlock.tsx triggers the registration at app load.
// ────────────────────────────────────────────────────────────────────────────
registerMessageSlot({
  id: "insights-scene-tracker",
  slot: "assistant_header_zone",
  order: 2,
  roles: ["assistant"],
  visibility: {
    getSnapshot: getSceneVisibilitySnapshot,
    subscribe: (_ctx, listener) => {
      // Re-resolve when EITHER the snapshot store (record/config/latest) OR the
      // generation cache flips. The cache is not in the snapshot primitive, but
      // its transitions can change `visible` indirectly only via record writes
      // (already covered by the snapshot store) — subscribing to it keeps the
      // host reactive to optimistic marks before the patch lands.
      const unsubSnapshot = useSnapshotStore.subscribe(() => listener());
      const unsubGen = useSceneGenerationStore.subscribe(() => listener());
      return () => { unsubSnapshot(); unsubGen(); };
    },
  },
  visible: (ctx: MessageSlotContext) => {
    if (ctx.messageRole !== "assistant") return false;
    const s = useSnapshotStore.getState();
    if (!s.activeChat?.insightsConfig?.trackerEnabled) return false;
    const msg = s.messagesById[ctx.messageId];
    if (!msg) return false;
    const variantId = msg.variants?.[msg.selectedVariantIndex ?? -1]?.id;
    if (!variantId) return false;
    const isLatest = ctx.messageId === getLatestAssistantMessageId(s);
    const config = s.activeChat.insightsConfig.tracker;
    const fresh = config ? isRecordFresh(msg.sceneTracker ?? null, config) : false;
    return isLatest || fresh;
  },
  render: (ctx) => <SceneZone chatId={ctx.chatId} messageId={ctx.messageId} />,
});

export { SceneZone };
