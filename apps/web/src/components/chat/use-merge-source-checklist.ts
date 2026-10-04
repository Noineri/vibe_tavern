/**
 * Merge-source checklist state for the Message AI editor
 * (MESSAGE_MERGE_FROM_TWO_VARIANTS steps 2–3).
 *
 * Extracted from MessageAiEditorModal.tsx for size discipline (the modal
 * keeps workflow orchestration; this module owns the checklist state
 * machine):
 *
 * - Selection is MODAL-LOCAL and NEVER writes stars. Checking/unchecking a
 *   row is pure local state; stars are orientation marks in the variant
 *   jump browser and stay untouched.
 * - Entering Merge (fresh open with requestedMode=merge, or an in-modal
 *   switch) seeds the selection from the message's stars CURRENT at that
 *   moment (imperative `getState()` read — a reactive dep would re-seed on
 *   every star change and wipe the user's manual checks). Every other mode
 *   entry clears the selection.
 * - `liveCheckedVariantIds` filters the selection to variants that still
 *   exist, in display order — the read-side mirror of the store's
 *   `pruneStaleStars`: a checked variant deleted mid-session drops out of
 *   every consumer (rows, count, preview, run, save) and can never ride a
 *   request. Derived, never effect-synced.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageId, MessageVariantId } from "@vibe-tavern/domain";
import {
  useMessageAiEditorStore,
  type MessageAiEditorMode,
  type MessageAiEditorTarget,
} from "../../stores/message-ai-editor-store.js";
import type { AppMessage } from "../../api/types.js";

export interface MergeSourceChecklist {
  /** Checked ids filtered to live variants, in display order. */
  liveCheckedVariantIds: ReadonlySet<MessageVariantId>;
  /** Current stars of the target message — for the row glyphs only. */
  starredVariantIds: ReadonlySet<MessageVariantId>;
  /** Toggle one row's checkbox. Stars are NEVER touched. */
  toggleChecked: (variantId: MessageVariantId) => void;
}

export function useMergeSourceChecklist(args: {
  activeMode: MessageAiEditorMode;
  /** The live editor target — identity is new on every open, so it doubles
   *  as the re-seed key when the same message is reopened in merge mode. */
  target: MessageAiEditorTarget | null;
  targetMessage: AppMessage | null;
  targetMessageId: MessageId | null;
}): MergeSourceChecklist {
  const { activeMode, target, targetMessage, targetMessageId } = args;
  const [checkedVariantIds, setCheckedVariantIds] = useState<Set<MessageVariantId>>(() => new Set());
  const starredByMessage = useMessageAiEditorStore((s) => s.starredVariantIdsByMessage);

  useEffect(() => {
    if (activeMode !== "message_merge") {
      setCheckedVariantIds(new Set());
      return;
    }
    const starred = target
      ? useMessageAiEditorStore.getState().starredVariantIdsByMessage[target.targetMessageId] ?? []
      : [];
    setCheckedVariantIds(new Set(starred));
  }, [activeMode, target]);

  const liveCheckedVariantIds = useMemo(() => {
    const live = new Set<MessageVariantId>();
    if (targetMessage) {
      for (const variant of targetMessage.variants) {
        if (checkedVariantIds.has(variant.id)) live.add(variant.id);
      }
    }
    return live;
  }, [targetMessage, checkedVariantIds]);

  const starredVariantIds = useMemo(() => {
    const starred = new Set<MessageVariantId>();
    if (targetMessageId !== null) {
      for (const id of starredByMessage[targetMessageId] ?? []) starred.add(id);
    }
    return starred;
  }, [targetMessageId, starredByMessage]);

  const toggleChecked = useCallback((variantId: MessageVariantId) => {
    setCheckedVariantIds((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }, []);

  return { liveCheckedVariantIds, starredVariantIds, toggleChecked };
}
