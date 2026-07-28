/**
 * Unified prompt-canvas row card (APC-3b).
 *
 * A single props-driven template that every canvas slot renders through
 * (APC-4b folded the field cards into it; PromptOrderMarker migrates in 4c,
 * InjectionRowView in 4d). The migration is a slot-by-slot swap rather than a
 * big-bang rewrite — `PromptOrderMarker` and `InjectionRowView` still render
 * directly until 4c/4d.
 *
 * Layout (header always rendered; body optional + collapsible):
 *
 *   [DragHandle] [toggle] [category-icon] label … [TokenCounter] [role] [slot] [badge] [▶] [remove]
 *                                                                                 └ expand
 *   body:  [depth-input?] [role SegmentedControl?] [expandedLeading?] [AutoTextarea | readonly]
 *
 * Variants the props express:
 *   • marker   — `nonExpandable` + no `value`         → header only (PromptOrderMarker parity)
 *   • field    — `value` + `editable` + `onChange`     → expandable text editor
 *   • custom   — + `onRoleChange` + `onRemove`         → injection editor (role control in body)
 *
 * Visual source: the header chrome (toggle, badges, chevron, spacing) mirrors
 * the former EditablePromptCard / InjectionRowView so the migration is
 * pixel-stable; the category-icon (APC-3a) is the one new element.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { TokenCounter } from "../../../shared/TokenCounter.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DragHandle } from "../drag-handle.js";
import { roleOptions } from "../canvas-shared.js";
import { SLOT_CATEGORY_ICON, type SlotCategory } from "../canvas-icons.js";

export interface CanvasCardProps {
  /** Canvas entry identifier. */
  identifier: string;
  /** Slot category → header icon (APC-3a registry). */
  category: SlotCategory;
  /** Header label. */
  label: ReactNode;
  /** When set, the label renders with a dotted underline + hover tooltip. */
  labelTooltip?: string;

  /** Enabled flag (default true). */
  enabled?: boolean;
  /** Enable-toggle handler. Omit to hide the toggle entirely. */
  onToggle?: () => void;
  /** Show the drag handle (default true). */
  draggable?: boolean;

  /**
   * Content text. Drives the header TokenCounter AND the body textarea. Omit for
   * marker rows (no token count, no editor body).
   */
  value?: string;
  /** Render an editable textarea in the body (default: derived from `value`). */
  editable?: boolean;
  placeholder?: string;
  onChange?: (value: string) => void;
  /** Disable the body controls (no draft / read-only view). */
  disabled?: boolean;

  /** Role badge shown in the header. */
  role?: "system" | "user" | "assistant";
  /** When set, a role SegmentedControl renders in the body. */
  onRoleChange?: (role: "system" | "user" | "assistant") => void;

  /** Slot-position badge text (e.g. "after", "in-chat"). */
  slotLabel?: string | null;
  /** In-chat insertion depth (rendered as a `←N` badge +, when ≥depthMin, a body input). */
  slotDepth?: number | null;
  onSlotDepthChange?: (depth: number) => void;
  /** Minimum depth at which the depth input renders (default 4 — prompt injections).
   *  Character depth-prompt overrides use 1 (ST depth_prompt semantics). */
  depthMin?: number;

  /** Trailing source/category badge (e.g. "editable", "read-only"). */
  badge?: ReactNode;
  /** Remove action (custom injections). */
  onRemove?: () => void;

  /** Non-expandable row (header only) — PromptOrderMarker parity. */
  nonExpandable?: boolean;
  /** Initial expanded state (uncontrolled). */
  defaultExpanded?: boolean;

  /** Extra nodes rendered inside the body, before the textarea (e.g. the
   *  anchor's bound lore-entries list — Wave 4). */
  expandedLeading?: ReactNode;

  className?: string;
}

export function CanvasCard({
  identifier,
  category,
  label,
  labelTooltip,
  enabled = true,
  onToggle,
  draggable = true,
  value,
  editable,
  placeholder,
  onChange,
  disabled,
  role,
  onRoleChange,
  slotLabel,
  slotDepth,
  onSlotDepthChange,
  depthMin = 4,
  badge,
  onRemove,
  nonExpandable = false,
  defaultExpanded = false,
  expandedLeading,
  className,
}: CanvasCardProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasValue = value !== undefined;
  const isEditable = editable ?? hasValue;
  const showBodyControls = !!onRoleChange || !!onSlotDepthChange || !!expandedLeading;
  const expandable = !nonExpandable && (hasValue || showBodyControls);
  const slotDepthNum = slotDepth ?? 0;
  const showDepthBadge = slotLabel != null;
  const showDepthInput = !!onSlotDepthChange && slotLabel != null && slotDepthNum >= depthMin;

  const CategoryIcon = SLOT_CATEGORY_ICON[category];
  const onClickHeader = expandable ? () => setExpanded((v) => !v) : undefined;

  return (
    <div className={cn("rounded-md border border-border bg-surface transition-colors", !enabled && "opacity-55", className)}>
      <div
        className={cn("flex min-w-0 select-none items-center gap-2 px-3 py-2 sm:gap-2.5", onClickHeader && "cursor-pointer")}
        onClick={onClickHeader}
      >
        {draggable && <DragHandle disabled={expanded} />}
        {onToggle && (
          <CustomTooltip content={enabled ? t("cc_enabled") : t("cc_disabled")}>
            <button
              type="button"
              className={cn(
                "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
                enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
              )}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              aria-label={enabled ? t("cc_enabled") : t("cc_disabled")}
              aria-pressed={enabled}
            >
              {enabled ? "●" : "○"}
            </button>
          </CustomTooltip>
        )}
        <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center text-t3" aria-hidden="true">
          <CategoryIcon />
        </span>
        <span className="min-w-[120px] flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">
          {labelTooltip ? (
            <CustomTooltip content={labelTooltip}>
              <span className="cursor-help border-b border-dotted border-current pb-0.5">{label}</span>
            </CustomTooltip>
          ) : (
            label
          )}
        </span>
        {hasValue && <TokenCounter text={value} />}
        {role && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>}
        {showDepthBadge && (
          <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">
            {slotLabel === "in-chat" || /^\d+$/.test(String(slotLabel)) ? `←${slotDepthNum}` : slotLabel}
          </span>
        )}
        {badge && <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">{badge}</span>}
        {expandable && (
          <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")} aria-hidden="true">▶</span>
        )}
        {onRemove && (
          <CustomTooltip content={t("cc_remove")}>
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:danger-dim hover:text-danger"
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              aria-label={t("cc_remove")}
            >
              ✕
            </button>
          </CustomTooltip>
        )}
      </div>
      {expandable && expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          {(showDepthInput || onRoleChange) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {showDepthInput && (
                <CustomTooltip content={t("insert_depth_label")}>
                  <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                    <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                    <span className="sr-only">{t("insert_depth_label")}</span>
                    <NumberInput
                      className="h-[30px] w-[90px]"
                      min={depthMin} max={99}
                      value={slotDepthNum}
                      onChange={(v) => onSlotDepthChange?.(v)}
                      disabled={disabled}
                    />
                  </div>
                </CustomTooltip>
              )}
              {onRoleChange && role && (
                <label className="flex min-w-0 flex-wrap items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span>{t("role")}</span>
                  <SegmentedControl
                    value={role}
                    options={roleOptions.map((r) => ({ value: r, label: r }))}
                    onChange={(v) => onRoleChange(v as "system" | "user" | "assistant")}
                    compact
                  />
                </label>
              )}
            </div>
          )}
          {expandedLeading}
          {isEditable && (
            <AutoTextarea
              className="w-full resize-none rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
              style={{}}
              minRows={5}
              value={value ?? ""}
              placeholder={placeholder}
              disabled={disabled}
              maxRows={20}
              onChange={(e) => onChange?.(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  );
}
