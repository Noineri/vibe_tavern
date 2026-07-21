/**
 * Message AI editor modal (MAE-51, MESSAGE_AI_EDITOR_PLAN Wave 5 item 1).
 *
 * One non-virtualized Modal that reads its target from the ephemeral
 * `useMessageAiEditorStore` (NOT from props threaded through Virtuoso rows),
 * so an in-flight generation survives MessageBlock unmount and at most one
 * editor can be open at a time. Mounted once by `PlayMode` outside the
 * virtualized message list.
 *
 * Two user-selected workflows on top of the shared MAE-41 runner /
 * MAE-42 word-diff / MAE-43 editor store / MAE-32 guarded mutations:
 *
 * - Edit (default): diff-preview the candidate against the variant selected
 *   at open time, then Apply through a guarded PATCH carrying
 *   `expectedVariantId`. A 409 (selection changed or variant deleted mid-
 *   flight) shows a conflict state and NEVER overwrites; success closes.
 *
 * - Merge: star ≥ 2 immutable variants in the jump browser (MAE-53), then
 *   Save-as-new-variant via `createMessageVariantAction` carrying source IDs
 *   plus the runner's done-metadata provenance. Success clears that
 *   message's stars and closes.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: cancel, provider error, empty output,
 * modal close, and stale target never mutate canonical state. No action
 * fires before the explicit Apply (edit) or Save (merge) click.
 *
 * The automatic-context block is informational only — it describes the RP
 * context the backend will assemble (character, persona, chat preset,
 * summary/lore presence), never editable here. Source rows adapt to mode:
 * a single read-only row for Edit; the removable starred set for Merge
 * (remove = unstar = `toggleStar`).
 */
// allow: SIZE_OK — single-surface modal following the existing AiAssistantModal
// (874 LOC) / ProviderModal (762 LOC) pattern. Owns ONE responsibility ("the
// message AI editor modal"); the source-list concern is already extracted to
// message-ai-editor-source-list.tsx. Splitting header/body/footer further
// would create artificial components with no separate consumer and require
// passing 10+ modal-state props (parameter-bloat smell).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatId, MessageId, MessageVariantId } from "@vibe-tavern/domain";

import { Modal } from "../shared/Modal.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { MessageReasoning } from "./MessageReasoning.js";
import { TextDiffPreview, buildWordDiff, type TextDiffWordSummary } from "../shared/TextDiffPreview.js";
import { AiAssistantConnectionFields } from "../shared/ai-assistant/AiAssistantConnectionFields.js";
import { useAiAssistantRunner } from "../shared/ai-assistant/use-ai-assistant-runner.js";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { useMessageAiEditorStore, type MessageAiEditorMode } from "../../stores/message-ai-editor-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import {
  createMessageVariantAction,
  editMessageAction,
} from "../../stores/api-actions/chat-actions.js";
import type { AppMessage } from "../../api/types.js";
import {
  MessageAiEditorSourceList,
  toSourceRow,
  type SourceRow,
} from "./message-ai-editor-source-list.js";

// ─── Conflict detection ────────────────────────────────────────────────
// `editMessageAction` throws a plain Error whose message is the backend's
// conflict() payload, produced ONLY by the guarded-edit stale-variant path
// (`chat-application-service.ts`). Stable unique substring, pinned by the
// MAE-31 API test; the server owns this string.
const CONFLICT_MARKER = "selected message variant changed";

function isConflictError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(CONFLICT_MARKER);
}

// ─── Component ─────────────────────────────────────────────────────────

/**
 * Single mounted message AI editor. Reads its open state and target from
 * the ephemeral editor store; renders nothing when no target is set.
 */
export function MessageAiEditorModal() {
  const { t, tDynamic } = useT();
  const isMobile = useIsMobile();

  const target = useMessageAiEditorStore((s) => s.target);
  const starredByMessage = useMessageAiEditorStore((s) => s.starredVariantIdsByMessage);
  const closeEditor = useMessageAiEditorStore((s) => s.closeEditor);
  const toggleStar = useMessageAiEditorStore((s) => s.toggleStar);
  const clearStars = useMessageAiEditorStore((s) => s.clearStars);

  const messagesById = useSnapshotStore((s) => s.messagesById);
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const character = useSnapshotStore((s) => s.character);
  const persona = useSnapshotStore((s) => s.persona);

  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);

  const isOpen = target !== null;
  const targetMessageId = target?.targetMessageId ?? null;
  const targetChatId = target?.targetChatId ?? null;

  // The canonical target message read LIVE from the snapshot — if it (or the
  // selected source variant for edit) disappears mid-session, the modal
  // surfaces a non-destructive stale-target state and blocks Apply/Save.
  const targetMessage = targetMessageId !== null ? messagesById[targetMessageId] ?? null : null;

  // Active mode starts from the requested mode but the user may switch via
  // the SegmentedControl. Reset whenever a new target opens.
  const [activeMode, setActiveMode] = useState<MessageAiEditorMode>("message_edit");
  const [instruction, setInstruction] = useState("");
  const [conflict, setConflict] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Seed activeMode when a new target opens. Per-plan: closing does NOT clear
  // stars (they survive close + Virtuoso unmount); only the successful merge
  // save or explicit user action clears them. So we only re-seed on a fresh
  // open, not on every render.
  useEffect(() => {
    if (target) {
      setActiveMode(target.requestedMode);
      setInstruction("");
      setConflict(false);
      setApplyError(null);
      setApplying(false);
    }
  }, [target?.targetChatId, target?.targetMessageId, target?.requestedMode]);

  const seedProviderId = bootstrapUiSettings?.aiAssistantProviderId ?? "";
  const seedModelName = bootstrapUiSettings?.aiAssistantModelName ?? "";

  const runner = useAiAssistantRunner({
    isOpen,
    seedProviderId,
    seedModelName,
    // Persist the editor's provider/model choice to uiSettings so the next
    // editor open (and other AI assistants) inherit it — same UX as the
    // existing AiAssistantModal "full" path.
    persistSelection: true,
  });

  // Reset transient stream/apply state whenever the modal closes so a reopen
  // is clean. The runner hook owns provider/model seed on open.
  useEffect(() => {
    if (!isOpen) {
      runner.resetStreamState();
      setInstruction("");
      setConflict(false);
      setApplyError(null);
      setApplying(false);
    }
  }, [isOpen, runner.resetStreamState]);

  // ─── Sources resolved from canonical snapshot ──────────────────────

  const editSourceVariantId = target?.requestedMode === "message_edit" ? target.selectedSourceVariantId : null;

  /** Edit: the single variant captured at open. Merge: the current starred
   *  set (read live so remove updates immediately). Both null when the
   *  target is absent. */
  const sourceRows: SourceRow[] = useMemo(() => {
    if (!targetMessage) return [];
    if (activeMode === "message_edit") {
      if (!editSourceVariantId) return [];
      const row = toSourceRow(targetMessage, editSourceVariantId);
      return row ? [row] : [];
    }
    const starred = targetMessageId ? (starredByMessage[targetMessageId] ?? []) : [];
    const rows: SourceRow[] = [];
    for (const variantId of starred) {
      const row = toSourceRow(targetMessage, variantId);
      if (row) rows.push(row);
    }
    return rows;
  }, [targetMessage, activeMode, editSourceVariantId, targetMessageId, starredByMessage]);

  /** Edit diff base: the canonical text of the variant captured at open.
   *  Null when the variant has been deleted (stale-source state). */
  const editBaselineText = useMemo(() => {
    if (activeMode !== "message_edit" || !targetMessage || !editSourceVariantId) return null;
    const variant = targetMessage.variants.find((v) => v.id === editSourceVariantId);
    return variant ? variant.content : null;
  }, [activeMode, targetMessage, editSourceVariantId]);

  // Stale-target / stale-source detection. Edit is stale when the captured
  // variant is no longer in the message. Merge is never "stale" by variant
  // deletion — `pruneStaleStars` drops deleted IDs and the user can re-star;
  // but if the whole message is gone, nothing is meaningful.
  const staleTarget = !targetMessage;
  const staleEditSource = activeMode === "message_edit" && !staleTarget && editBaselineText === null;

  const mergeSourceCount = activeMode === "message_merge" ? sourceRows.length : 0;
  const mergeBelowMinimum = activeMode === "message_merge" && mergeSourceCount < 2;

  // Merge sources are starred in the variant jump browser, which only renders
  // for messages with more than 6 variants (VariantControls `showJump`). Below
  // that there is no way to star anything, so the merge option is hidden rather
  // than offered with an impossible-to-satisfy empty source state.
  const canMerge = (targetMessage?.variants.length ?? 0) > 6;

  // ─── Request construction ──────────────────────────────────────────

  const canGenerate =
    !staleTarget
    && !staleEditSource
    && !mergeBelowMinimum
    && runner.providerId !== ""
    && instruction.trim().length > 0
    && !runner.streaming
    && !applying;

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !target || !targetMessageId || !targetChatId) return;

    const sourceVariantIds: MessageVariantId[] =
      activeMode === "message_edit"
        ? editSourceVariantId ? [editSourceVariantId] : []
        : (starredByMessage[targetMessageId] ?? []);

    if (activeMode === "message_merge" && sourceVariantIds.length < 2) return;
    if (activeMode === "message_edit" && sourceVariantIds.length !== 1) return;

    // Reset prior apply/conflict state on a fresh generation.
    setConflict(false);
    setApplyError(null);

    void runner.runStream({
      mode: activeMode,
      instruction,
      providerProfileId: runner.providerId,
      model: runner.modelName || undefined,
      enabledLayers: [],
      chatId: targetChatId,
      targetMessageId: targetMessageId,
      sourceVariantIds,
    });
  }, [
    canGenerate, target, targetMessageId, targetChatId, activeMode,
    editSourceVariantId, starredByMessage, instruction, runner,
  ]);

  // ─── Apply (edit): guarded PATCH with expectedVariantId ────────────

  const handleApplyEdit = useCallback(async () => {
    if (!target || !targetMessageId || !targetChatId || !editSourceVariantId) return;
    const candidate = runner.streamedOutput.trim();
    if (!candidate || runner.streaming || applying) return;

    setApplying(true);
    setApplyError(null);
    setConflict(false);
    try {
      await editMessageAction(targetChatId, targetMessageId, candidate, editSourceVariantId);
      // Success — close. The action already syncSnapshot'd the patched
      // message; the modal unmounts without touching stars (edit does not
      // use stars).
      closeEditor();
    } catch (err: unknown) {
      if (isConflictError(err)) {
        // 409: keep the modal open, surface the conflict, NEVER overwrite.
        // The canonical message is untouched (the server rejected before
        // any write); the user can dismiss or close manually.
        setConflict(true);
      } else {
        setApplyError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setApplying(false);
    }
  }, [
    target, targetMessageId, targetChatId, editSourceVariantId,
    runner.streamedOutput, runner.streaming, applying, closeEditor,
  ]);

  // ─── Save (merge): append-and-select via createMessageVariantAction ─

  const handleSaveMerge = useCallback(async () => {
    if (!target || !targetMessageId || !targetChatId) return;
    if (mergeBelowMinimum) return;
    const candidate = runner.streamedOutput.trim();
    if (!candidate || runner.streaming || applying) return;

    const sourceVariantIds = starredByMessage[targetMessageId] ?? [];
    if (sourceVariantIds.length < 2) return;

    setApplying(true);
    setApplyError(null);
    setConflict(false);
    try {
      await createMessageVariantAction(targetChatId, targetMessageId, {
        content: candidate,
        sourceVariantIds,
        modelId: runner.doneMetadata?.modelId ?? undefined,
        promptPresetId: runner.doneMetadata?.promptPresetId ?? undefined,
        finishReason: runner.doneMetadata?.finishReason ?? undefined,
      });
      // Success — clear this message's stars (the merge consumed them) and
      // close. createMessageVariantAction already syncSnapshot'd the
      // appended-and-selected variant.
      clearStars(targetMessageId);
      closeEditor();
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [
    target, targetMessageId, targetChatId, mergeBelowMinimum,
    runner.streamedOutput, runner.streaming, applying, runner.doneMetadata,
    starredByMessage, clearStars, closeEditor,
  ]);

  // ─── Close (cancel) — never mutates canonical state ────────────────

  const handleClose = useCallback(() => {
    // Cancel any in-flight stream first so its abort resolves quietly.
    runner.stop();
    closeEditor();
  }, [runner.stop, closeEditor]);

  // ─── Preview summaries ─────────────────────────────────────────────

  const candidateText = runner.streamedOutput;
  const showCandidate = candidateText.length > 0;

  const editWordDiff: TextDiffWordSummary | null = useMemo(() => {
    if (activeMode !== "message_edit") return null;
    if (!showCandidate || runner.streaming || editBaselineText === null) return null;
    return buildWordDiff(editBaselineText, candidateText);
  }, [activeMode, showCandidate, runner.streaming, editBaselineText, candidateText]);

  // ─── Automatic context summary (informational only) ────────────────

  const contextBits: string[] = [];
  if (character) contextBits.push(character.name);
  if (persona) contextBits.push(persona.name);
  if (activeChat?.summary) contextBits.push(tDynamic("message_ai_editor_context_summary"));
  if ((activeChat?.mode ?? "rp") !== "rp") contextBits.push(activeChat?.mode ?? "");

  // ─── Render gates ──────────────────────────────────────────────────

  // Modal requires children; pass null so nothing renders while closed.
  if (!isOpen) {
    return (
      <Modal open={false} onClose={handleClose} title={tDynamic("message_ai_editor_title")}>
        {null}
      </Modal>
    );
  }

  const containerCls = isMobile
    ? "w-full h-full rounded-none"
    : "w-[640px] max-w-[90vw] max-h-[85vh] rounded-xl";

  return (
    <Modal
      open
      onClose={handleClose}
      title={tDynamic("message_ai_editor_title")}
      description={tDynamic("message_ai_editor_description")}
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden border border-border bg-surface",
          containerCls,
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-accent shrink-0">
              <Icons.sparkles />
            </span>
            <span className="truncate text-sm font-semibold text-t1">
              {tDynamic("message_ai_editor_title")}
            </span>
          </div>
          {!staleTarget && canMerge && (
            <SegmentedControl
              value={activeMode}
              onChange={(v) => {
                if (applying || runner.streaming) return;
                setActiveMode(v as MessageAiEditorMode);
                // Mode switch clears transient apply/conflict state but keeps
                // the instruction and any generated candidate so the user can
                // compare. Generation must be re-triggered explicitly.
                setConflict(false);
                setApplyError(null);
              }}
              options={[
                { value: "message_edit", label: tDynamic("message_ai_editor_mode_edit") },
                { value: "message_merge", label: tDynamic("message_ai_editor_mode_merge") },
              ]}
              compact
            />
          )}
          <button
            type="button"
            className={cn(
              "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1",
              (runner.streaming || applying) && "pointer-events-none opacity-30",
            )}
            onClick={handleClose}
            aria-label={t("cancel_btn")}
          >
            <Icons.close />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
          {staleTarget ? (
            <div className="rounded-md border border-border bg-bg p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                {tDynamic("message_ai_editor_stale_title")}
              </div>
              <div className="font-ui text-[12px] leading-relaxed text-t3">
                {tDynamic("message_ai_editor_stale_body")}
              </div>
            </div>
          ) : providerProfiles.length === 0 ? (
            <div className="py-6 text-center font-ui text-[13px] text-t3">
              {tDynamic("message_ai_editor_no_providers")}
            </div>
          ) : (
            <>
              {/* Automatic context summary — informational, not editable */}
              <div className="mb-4 rounded-md border border-border bg-bg p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                  {tDynamic("message_ai_editor_context_label")}
                </div>
                <div className="font-ui text-[12px] leading-relaxed text-t2">
                  {contextBits.length > 0
                    ? contextBits.join(" · ")
                    : tDynamic("message_ai_editor_context_empty")}
                </div>
              </div>

              {/* Sources */}
              <div className="mb-4">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                  {tDynamic("message_ai_editor_sources_label")}
                </div>
                {staleEditSource ? (
                  <div className="rounded-md border border-danger bg-danger-dim p-3 font-ui text-[12px] text-danger-text">
                    {tDynamic("message_ai_editor_stale_source")}
                  </div>
                ) : (
                  <MessageAiEditorSourceList
                    rows={sourceRows}
                    mode={activeMode}
                    // Non-null: staleTarget gates this branch; targetMessageId is set.
                    messageId={targetMessageId as MessageId}
                    onUnstar={toggleStar}
                    disabled={applying || runner.streaming}
                  />
                )}
                {mergeBelowMinimum && (
                  <div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">
                    {tDynamic("message_ai_editor_merge_min_sources")}
                  </div>
                )}
              </div>

              {/* Connection fields (provider/model) */}
              <AiAssistantConnectionFields
                providerProfiles={providerProfiles}
                providerId={runner.providerId}
                modelName={runner.modelName}
                providerModels={runner.providerModels}
                selectedProfileDefaultModel={runner.selectedProfile?.defaultModel ?? null}
                onProviderChange={runner.handleProviderChange}
                onModelChange={runner.handleModelChange}
                labels={{
                  connection: t("script_ai_connection"),
                  model: t("script_ai_model"),
                  selectProvider: t("script_ai_select_provider"),
                  searchProvider: t("script_ai_search_provider"),
                  searchModel: t("script_ai_search_model"),
                }}
              />

              {/* Instruction */}
              <div className="mb-4">
                <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
                  {tDynamic("message_ai_editor_instruction_label")}
                </label>
                <MobileExpandTextarea
                  value={instruction}
                  onChange={setInstruction}
                  label={tDynamic("message_ai_editor_instruction_label")}
                >
                  <AutoTextarea
                    className="w-full resize-none rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent"
                    maxRows={12}
                    minRows={4}
                    placeholder={tDynamic("message_ai_editor_instruction_placeholder")}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                  />
                </MobileExpandTextarea>
                <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">
                  {tDynamic("message_ai_editor_instruction_hint")}
                </div>
              </div>

              {/* Reasoning */}
              {runner.streamedReasoning && (
                <div className="mb-3">
                  <MessageReasoning reasoning={runner.streamedReasoning} variant="minimal" />
                </div>
              )}

              {/* Preview: edit = word diff; merge = full candidate, no diff */}
              {showCandidate && activeMode === "message_edit" && editWordDiff && !staleEditSource && (
                <TextDiffPreview
                  granularity="word"
                  summary={editWordDiff}
                  labels={{
                    title: tDynamic("message_ai_editor_changes"),
                    tooLarge: tDynamic("message_ai_editor_diff_too_large"),
                    noChanges: tDynamic("message_ai_editor_no_changes"),
                  }}
                />
              )}
              {showCandidate && activeMode === "message_merge" && (
                <div className="mb-3 rounded-md border border-border bg-bg p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                    {tDynamic("message_ai_editor_candidate_label")}
                  </div>
                  <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">
                    {candidateText}
                    {runner.streaming && <span className="animate-pulse text-accent">▌</span>}
                  </pre>
                </div>
              )}

              {/* Apply / conflict / errors */}
              {conflict && (
                <div className="mb-3 rounded-md border border-danger bg-danger-dim p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-danger-text">
                    {tDynamic("message_ai_editor_conflict_title")}
                  </div>
                  <div className="mt-1 font-ui text-[12px] leading-relaxed text-danger-text">
                    {tDynamic("message_ai_editor_conflict_body")}
                  </div>
                </div>
              )}
              {applyError && (
                <div className="mb-3 rounded-md border border-danger bg-danger-dim p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-danger-text">
                    {t("script_ai_error")}
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{applyError}</pre>
                </div>
              )}
              {runner.error && (
                <div className="mb-3 rounded-md border border-danger bg-danger-dim p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-danger-text">
                    {t("script_ai_error")}
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{runner.error}</pre>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            className="h-9 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
            onClick={handleClose}
            disabled={applying}
          >
            {t("cancel_btn")}
          </button>
          {!staleTarget && providerProfiles.length > 0 && (
            <>
              {runner.streaming ? (
                <button
                  type="button"
                  className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-on-danger transition-all"
                  onClick={runner.stop}
                >
                  {t("script_ai_stop")}
                </button>
              ) : (
                <>
                  {showCandidate && !conflict && !staleEditSource && activeMode === "message_edit" && (
                    <button
                      type="button"
                      className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void handleApplyEdit()}
                      disabled={applying || runner.streaming}
                    >
                      {applying ? tDynamic("message_ai_editor_applying") : tDynamic("message_ai_editor_apply")}
                    </button>
                  )}
                  {showCandidate && !mergeBelowMinimum && activeMode === "message_merge" && (
                    <button
                      type="button"
                      className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void handleSaveMerge()}
                      disabled={applying || runner.streaming || mergeBelowMinimum}
                    >
                      {applying ? tDynamic("message_ai_editor_applying") : tDynamic("message_ai_editor_save_new_variant")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={cn(
                      "h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all",
                      canGenerate
                        ? "bg-accent text-on-accent hover:opacity-90"
                        : "bg-s3 text-t3 cursor-not-allowed",
                    )}
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                  >
                    {tDynamic("message_ai_editor_generate")}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
