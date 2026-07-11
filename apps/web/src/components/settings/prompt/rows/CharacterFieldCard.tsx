/** Character V3 override field card — system prompt / post-history / depth
 *  prompt overrides the character carries. Shown on the canvas only when a
 *  `characterDraft` is provided. */
import { useState } from "react";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { TokenCounter } from "../../../shared/TokenCounter.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DragHandle } from "../drag-handle.js";
import { roleOptions } from "../canvas-shared.js";

export function CharacterFieldCard({ identifier, enabled = true, onToggle, label, role, value, onChange, depth, onDepthChange, onRoleChange, slotLabel, slotDepth, onSlotDepthChange }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  label: string;
  role: string;
  value: string;
  onChange: (value: string) => void;
  depth?: number;
  onDepthChange?: (depth: number) => void;
  onRoleChange?: (role: string) => void;
  slotLabel?: string | null;
  slotDepth?: number | null;
  onSlotDepthChange?: (depth: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  // Show depth input only when item is in an in_chat zone (slotDepth is a number)
  const showDepthInput = slotDepth != null && slotDepth >= 1;
  const showRoleControl = onRoleChange != null;

  return (
    <div className={cn("rounded-md border border-dashed border-accent/30 bg-surface", !enabled && "opacity-55")}>
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
        <DragHandle disabled={expanded} />
        {identifier ? (
          <CustomTooltip content={enabled ? t("preset_injection_enabled") : t("preset_injection_disabled")}>
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
        ) : null}
        <span className="min-w-[120px] flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">{label}</span>
        <TokenCounter text={value} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>
        {slotLabel && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">{slotLabel}</span>}
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-amber-400">{t("char_badge")}</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {showRoleControl && (
              <label className="flex min-w-0 flex-wrap items-center gap-1.5 font-ui text-[11px] text-t4">
                <span>{t("role")}</span>
                <SegmentedControl
                  value={role}
                  options={roleOptions.map(r => ({ value: r, label: r }))}
                  onChange={(v) => onRoleChange?.(v)}
                  compact
                />
              </label>
            )}
            {showDepthInput && (
              <CustomTooltip content={t("insert_depth_label")}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={1} max={99}
                    value={slotDepth ?? depth ?? 4}
                    onChange={(v) => onSlotDepthChange ? onSlotDepthChange(v) : onDepthChange?.(v)}
                  />
                </div>
              </CustomTooltip>
            )}
          </div>
          <AutoTextarea
            className="w-full resize-none overflow-hidden rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent"
            style={{}}
            minRows={4}
            value={value}
            placeholder=""
            maxRows={20}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
