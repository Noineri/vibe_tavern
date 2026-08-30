/**
 * Source-list rendering for the Message AI editor (MAE-51).
 *
 * Extracted from `MessageAiEditorModal.tsx` for size discipline: the source
 * list is a self-contained presentational concern (one row per selected
 * canonical variant) with a clear interface, while the modal retains the
 * workflow orchestration (mode switching, generation, Apply, Save).
 *
 * Rows adapt to mode:
 * - Edit: a single read-only row (the variant captured at open) — no remove.
 * - Merge: each starred variant with a remove (unstar) button — remove is
 *   the SAME `toggleStar` action the variant browser uses; nothing new.
 */
import type { AppMessage } from "../../api/types.js";
import type { MessageId, MessageVariantId } from "@vibe-tavern/domain";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";

export interface SourceRow {
  variantId: MessageVariantId;
  /** One-based display index, stable against the canonical variantIndex. */
  displayIndex: number;
  /** Truncated single-line preview of the variant content. */
  preview: string;
  /** Model label for provenance, if any. */
  modelLabel: string | null;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function toSourceRow(message: AppMessage, variantId: MessageVariantId): SourceRow | null {
  const variant = message.variants.find((v) => v.id === variantId);
  if (!variant) return null;
  return {
    variantId,
    displayIndex: variant.variantIndex + 1,
    preview: truncate(variant.content, 80),
    modelLabel: variant.modelId ?? null,
  };
}

interface MessageAiEditorSourceListProps {
  rows: SourceRow[];
  /** "message_edit" rows are read-only; "message_merge" rows show an unstar button. */
  mode: "message_edit" | "message_merge" | "message_tts_annotate";
  /** Unstar handler — only invoked in merge mode. The messageId is the
   *  store key for `toggleStar(messageId, variantId)`. */
  messageId: MessageId;
  onUnstar: (messageId: MessageId, variantId: MessageVariantId) => void;
  /** Disable all remove buttons while applying or streaming. */
  disabled: boolean;
}

export function MessageAiEditorSourceList({
  rows, mode, messageId, onUnstar, disabled,
}: MessageAiEditorSourceListProps) {
  const { tDynamic } = useT();
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-bg p-3 font-ui text-[12px] text-t3">
        {tDynamic("message_ai_editor_sources_empty")}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li
          key={row.variantId}
          className="flex items-start gap-2 rounded-md border border-border bg-bg px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="font-ui text-[11px] uppercase tracking-[0.04em] text-t3">
              #{row.displayIndex}
              {row.modelLabel ? ` · ${row.modelLabel}` : ""}
            </div>
            <div className="truncate font-mono text-[11px] text-t2">{row.preview}</div>
          </div>
          {mode === "message_merge" && (
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-danger-text"
              onClick={() => onUnstar(messageId, row.variantId)}
              aria-label={tDynamic("message_ai_editor_unstar_source")}
              disabled={disabled}
            >
              <Icons.close />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
