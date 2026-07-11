/** Author's note card — role + depth + text, bound to the preset draft. */
import { useState } from "react";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { TokenCounter } from "../../../shared/TokenCounter.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DragHandle } from "../drag-handle.js";
import { roleOptions, type PromptCanvasDraft } from "../canvas-shared.js";

export function EditableAuthorNoteCard({ identifier, enabled = true, onToggle, draft, onUpdateField, slotLabel, slotDepth, onSlotDepthChange }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
  slotLabel?: string | null;
  slotDepth?: number | null;
  onSlotDepthChange?: (depth: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  const disabled = !draft || !onUpdateField;
  const role = draft?.authorsNoteRole ?? "system";
  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
        <DragHandle disabled={expanded} />
        {identifier ? (
          <CustomTooltip content={enabled ? "Enabled" : "Disabled"}>
            <button
              type="button"
              className={cn(
                "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
                enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
              )}
              onClick={(e) => { e.stopPropagation(); onToggle?.(identifier); }}
            >
              {enabled ? "●" : "○"}
            </button>
          </CustomTooltip>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        )}
        <span className="min-w-[120px] flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">{t("authors_note_label")}</span>
        <TokenCounter text={draft?.authorsNote ?? ""} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>
        {slotLabel && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">{slotLabel}</span>}
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-accent">{t("editable_badge")}</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={role}
              options={roleOptions.map(r => ({ value: r, label: r }))}
              onChange={(v) => onUpdateField?.("authorsNoteRole", v)}
              disabled={disabled}
              compact
            />
            {slotDepth != null && slotDepth >= 4 && (
              <CustomTooltip content={t("insert_depth_label")}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={4} max={99}
                    value={slotDepth}
                    onChange={(v) => onSlotDepthChange?.(v)}
                    disabled={disabled}
                  />
                </div>
              </CustomTooltip>
            )}
          </div>
          <AutoTextarea
            className="w-full resize-none rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
            style={{}}
            minRows={5}
            value={draft?.authorsNote ?? ""}
            placeholder={t("authors_note_placeholder")}
            disabled={disabled}
            maxRows={20}
            onChange={(e) => onUpdateField?.("authorsNote", e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
