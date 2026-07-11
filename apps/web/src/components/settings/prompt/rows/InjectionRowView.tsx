/** Custom injection row — name / content / role editing + canvas-driven enable,
 *  slot, depth, remove. Enabled/slot/depth come from the matching
 *  `PromptOrderEntry` (the canvas is the single source of truth); the injection
 *  itself is content-only. */
import { useState } from "react";
import type { CustomInjection, PromptSlot } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { Ic } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DragHandle } from "../drag-handle.js";
import { roleOptions } from "../canvas-shared.js";

export function InjectionRowView({ injection, index, isMobile, enabled, slot, onUpdate, onToggleEnabled, onSlotDepthChange, onRemove }: {
  injection: CustomInjection;
  index: number;
  isMobile: boolean;
  /** Enabled flag — sourced from the canvas `PromptOrderEntry`, not the injection. */
  enabled: boolean;
  /** Positional slot — sourced from the canvas `PromptOrderEntry`. */
  slot: PromptSlot;
  /** Content-only writes: name / content / role. */
  onUpdate: (i: number, p: Partial<CustomInjection>) => void;
  /** Canvas write: toggle enabled on the `PromptOrderEntry`. */
  onToggleEnabled: () => void;
  /** Canvas write: set depth on the `PromptOrderEntry` (in_chat only; UI floors at 4 here, ≥1 globally — D1). */
  onSlotDepthChange: (depth: number) => void;
  onRemove: (i: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const slotDepth = slot.depth ?? 0;
  const slotZone = slot.zone;
  const showDepthInput = slotZone === "in_chat" && slotDepth >= 4;
  const showDepthBadge = slotZone === "in_chat";

  return (
    <div className={cn("rounded-md border transition-colors", enabled ? "border-border bg-surface" : "border-border2 bg-s1 opacity-60")}>
      <div
        className="group flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <DragHandle disabled={expanded} />
        <CustomTooltip content={enabled ? t("preset_injection_enabled") : t("preset_injection_disabled")}>
        <button type="button"
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded text-[14px] transition-colors",
            enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
          )}
          onClick={(e) => { e.stopPropagation(); onToggleEnabled(); }}
        >
          {enabled ? "●" : "○"}
        </button>
        </CustomTooltip>

        <div className="flex min-w-[80px] flex-1 items-center gap-1.5 overflow-hidden">
          {editingName ? (
            <input
              autoFocus
              className={cn("min-w-0 flex-1 rounded border border-border bg-s2 px-1.5 py-0.5 font-ui text-[calc(var(--ui-fs)-1px)] outline-none focus:border-accent placeholder:text-t4", enabled ? "text-t1" : "text-t3")}
              value={injection.name}
              placeholder={t("preset_injection_name")}
              onChange={(e) => onUpdate(index, { name: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); setEditingName(false); }
                if (e.key === "Escape") { e.preventDefault(); setEditingName(false); }
              }}
            />
          ) : (
            <>
              <span className={cn("min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)]", enabled ? "text-t1" : "text-t3", !injection.name && "text-t4")}>{injection.name || t("preset_injection_name")}</span>
              <button
                type="button"
                className={cn(
                  "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:bg-s2 hover:text-accent focus:bg-s2 focus:text-accent",
                  isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                )}
                onClick={(e) => { e.stopPropagation(); setEditingName(true); }}
                aria-label={t("preset_injection_name")}
              >
                {Ic.edit()}
              </button>
            </>
          )}
        </div>

        {showDepthBadge ? (
          <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">
            ←{slotDepth}
          </span>
        ) : slotZone === "after_chat" ? (
          <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3">
            {t("after_badge")}
          </span>
        ) : null}

        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">
          {injection.role}
        </span>

        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>
          ▶
        </span>

        <CustomTooltip content={t("preset_injection_delete")}>
        <button type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:danger-dim hover:text-danger"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
        >
          {Ic.del()}
        </button>
        </CustomTooltip>
      </div>

      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {showDepthInput && (
              <CustomTooltip content={t("insert_depth_label")}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={4} max={99}
                    value={slotDepth}
                    onChange={(v) => onSlotDepthChange(v)}
                  />
                </div>
              </CustomTooltip>
            )}

            <label className="flex min-w-0 flex-wrap items-center gap-1.5 font-ui text-[11px] text-t4">
              <span>{t("role")}</span>
              <SegmentedControl
                value={injection.role}
                options={roleOptions.map(r => ({ value: r, label: r }))}
                onChange={(v) => onUpdate(index, { role: v as CustomInjection["role"] })}
                compact
              />
            </label>
          </div>

          <AutoTextarea
            className="w-full resize-none overflow-hidden rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent"
            style={{}}
            minRows={5}
            value={injection.content}
            placeholder={t("preset_injection_content")}
            maxRows={20}
            onChange={(e) => onUpdate(index, { content: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
