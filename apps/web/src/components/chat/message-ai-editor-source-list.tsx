/**
 * Source-list rendering for the Message AI editor (MAE-51).
 *
 * Extracted from `MessageAiEditorModal.tsx` for size discipline: the source
 * list is a self-contained presentational concern with a clear interface,
 * while the modal retains the workflow orchestration (mode switching,
 * generation, Apply, Save).
 *
 * Rows adapt to mode:
 * - Edit: a single read-only row (the variant captured at open) — no remove.
 * - Merge (MESSAGE_MERGE_FROM_TWO_VARIANTS): the message's FULL variant
 *   checklist — every variant in display order, each row a shared `Checkbox`
 *   (whole row is the hit area). Starred variants carry a small non-
 *   interactive star glyph after `#N` — stars are ORIENTATION MARKS only;
 *   the checklist selection is the caller's modal-local state and NEVER
 *   writes stars (no unstar button lives here anymore). The starred set
 *   pre-checks the initial selection at the modal's side.
 * - Annotate: the single resolved variant as a read-only row.
 */
import type { AppMessage } from "../../api/types.js";
import type { MessageVariantId } from "@vibe-tavern/domain";
import { Icons } from "../shared/icons.js";
import { Checkbox } from "../shared/Checkbox.js";
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
  /** "message_merge" rows are checkable; edit/annotate rows are read-only. */
  mode: "message_edit" | "message_merge" | "message_tts_annotate";
  /** Merge checklist: currently checked variant ids (modal-local selection). */
  checkedVariantIds: ReadonlySet<MessageVariantId>;
  /** Merge checklist: starred variant ids (rendered as glyphs, never written). */
  starredVariantIds: ReadonlySet<MessageVariantId>;
  /** Toggle one row's checkbox. Stars are NEVER touched by this callback. */
  onToggleChecked: (variantId: MessageVariantId) => void;
  /** Disable row toggling while applying or streaming. */
  disabled: boolean;
}

export function MessageAiEditorSourceList({
  rows, mode, checkedVariantIds, starredVariantIds, onToggleChecked, disabled,
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
    <ul className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
      {rows.map((row) =>
        mode === "message_merge" ? (
          <li key={row.variantId}>
            <Checkbox
              checked={checkedVariantIds.has(row.variantId)}
              onChange={() => onToggleChecked(row.variantId)}
              disabled={disabled}
              aria-label={tDynamic("message_ai_editor_toggle_source", { n: row.displayIndex })}
              // The shared Checkbox's labeled variant IS the row: its chip
              // sits at the left edge, its label fills the rest, and the
              // whole row (≥44px: two text lines + py-2) is the toggle hit
              // area. `!items-start` re-bases the baked `items-center` so the
              // chip aligns with the header line, not the two-line block.
              className="rounded-md border border-border bg-bg px-3 py-2 !items-start"
              label={
                <div className="min-w-0 flex-1">
                  <div className="font-ui text-[11px] uppercase tracking-[0.04em] text-t3">
                    #{row.displayIndex}
                    {starredVariantIds.has(row.variantId) && (
                      <span
                        data-testid="merge-source-star"
                        aria-hidden="true"
                        className="ml-1 inline-flex text-t3"
                      >
                        <Icons.starFilled />
                      </span>
                    )}
                    {row.modelLabel ? ` · ${row.modelLabel}` : ""}
                  </div>
                  <div className="truncate font-mono text-[11px] text-t2">{row.preview}</div>
                </div>
              }
            />
          </li>
        ) : (
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
          </li>
        ),
      )}
    </ul>
  );
}
