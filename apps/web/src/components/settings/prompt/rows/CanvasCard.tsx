/**
 * Unified prompt-canvas row card (APC-3b).
 *
 * A single props-driven template that every canvas row renders through.
 * APC-4b folded the field cards into it; APC-4c/4d folded the former
 * PromptOrderMarker and InjectionRowView paths into the same template.
 *
 * Layout (header always rendered; body optional + collapsible). The header is
 * a CSS grid of four semantic groups — `controls` / `title` / `meta` /
 * `actions` — that reflow from one row to two on a narrow card via a
 * container query on `.canvas-card` (see styles.css). One DOM, no device fork;
 * desktop keeps the single row, prompt ordering and slot semantics unchanged.
 *
 *   desktop:  [controls: drag·toggle] [title] [meta: tokens·role·slot] [actions: lock·remove·▶]
 *   narrow (with metadata):   controls | title | actions
 *                              controls | meta  | actions   (controls/actions center across the content stack)
 *   narrow (no metadata):      controls | title | actions   (compact single row — driven by absence of value/role/slot, never by anchor name)
 *   body:  [depth-input?] [role SegmentedControl(dense)?] [expandedLeading?] [AutoTextarea | readonly]
 *
 * Variants the props express:
 *   • marker   — `nonExpandable` + no `value`         → header only (PromptOrderMarker parity)
 *   • field    — `value` + `editable` + `onChange`     → expandable text editor
 *   • custom   — + `onRoleChange` + `onRemove`         → injection editor (role control in body)
 *
 * Visual source: the header chrome (toggle, badges, chevron, spacing) mirrors
 * the former per-type cards; a theme-aware pale fill groups cards by category.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { Ic } from "../../../shared/icons.js";
import { CustomTooltip } from "../../../shared/Tooltip.js";
import { TokenCounter } from "../../../shared/TokenCounter.js";
import { NumberInput } from "../../../shared/NumberInput.js";
import { AutoTextarea } from "../../../shared/auto-textarea.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { DragHandle } from "../drag-handle.js";
import { roleOptions } from "../canvas-shared.js";
import { SLOT_CATEGORY_BACKGROUND, type SlotCategory } from "../canvas-category.js";

export interface CanvasCardProps {
  /** Canvas entry identifier. */
  identifier: string;
  /** Slot category → theme-aware pale card background. */
  category: SlotCategory;
  /** Header label. */
  label: ReactNode;
  /** When set, the label renders with a dotted underline + hover tooltip. */
  labelTooltip?: string;
  /** Editable inline label (custom injections have a renameable name). When
   *  set, the label area becomes an edit-on-click name field; otherwise the
   *  static `label` ReactNode is shown. */
  editableName?: { value: string; placeholder: string; onRename: (name: string) => void };

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

  /** Content is sourced elsewhere and can be inspected but not edited here. */
  readOnly?: boolean;
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
  readOnly = false,
  onRemove,
  nonExpandable = false,
  defaultExpanded = false,
  expandedLeading,
  editableName,
  className,
}: CanvasCardProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editingName, setEditingName] = useState(false);

  const hasValue = value !== undefined;
  const isEditable = editable ?? hasValue;
  const showBodyControls = !!onRoleChange || !!onSlotDepthChange || !!expandedLeading;
  const expandable = !nonExpandable && (hasValue || showBodyControls);
  const slotDepthNum = slotDepth ?? 0;
  const showDepthBadge = slotLabel != null;
  const showDepthInput = !!onSlotDepthChange && slotLabel != null && slotDepthNum >= depthMin;
  // A card with no token/role/slot metadata collapses the narrow header to one
  // compact row (controls + title + actions) instead of reserving a second
  // row for content that does not exist. Driven by the absence of metadata,
  // never by hardcoded anchor names (MOBILE_PROMPT_CANVAS_UX_REPORT.md step 5).
  const hasMeta = hasValue || !!role || showDepthBadge;

  const onClickHeader = expandable ? () => setExpanded((v) => !v) : undefined;

  return (
    <div data-canvas-identifier={identifier} className={cn("canvas-card rounded-md border border-border transition-colors", SLOT_CATEGORY_BACKGROUND[category], !enabled && "opacity-65", className)}>
      <div
        className={cn("canvas-card-header min-w-0 select-none", !hasMeta && "canvas-card-header--no-meta", onClickHeader && "cursor-pointer")}
        onClick={onClickHeader}
      >
        <div className="canvas-card-controls flex min-w-0 items-center gap-0 sm:gap-2.5">
          {draggable && <DragHandle disabled={expanded} />}
          {onToggle && (
            <CustomTooltip content={enabled ? t("cc_enabled") : t("cc_disabled")}>
              <button
                type="button"
                className={cn(
                  "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded transition-colors sm:h-[18px] sm:w-[18px]",
                  enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
                )}
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                aria-label={enabled ? t("cc_enabled") : t("cc_disabled")}
                aria-pressed={enabled}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "canvas-card-toggle-glyph block h-3 w-3 rounded-full sm:h-2.5 sm:w-2.5",
                    enabled ? "bg-current" : "border-2 border-current sm:border-[1.5px]",
                  )}
                />
              </button>
            </CustomTooltip>
          )}
        </div>

        <div className="canvas-card-title flex min-w-0 items-center gap-1.5">
          {editableName ? (
            <div className="group flex min-w-0 flex-1 items-center gap-1.5">
              {editingName ? (
                <input
                  autoFocus
                  className={cn("min-w-0 flex-1 rounded border border-border bg-s2 px-1.5 py-0.5 font-ui text-[12px] outline-none focus:border-accent placeholder:text-t4", enabled ? "text-t1" : "text-t3")}
                  value={editableName.value}
                  placeholder={editableName.placeholder}
                  onChange={(e) => editableName.onRename(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => setEditingName(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); setEditingName(false); }
                  }}
                />
              ) : (
                <>
                  <span className={cn("min-w-0 flex-1 truncate font-ui text-[12px]", enabled ? "text-t1" : "text-t3", !editableName.value && "text-t4")}>
                    {editableName.value || editableName.placeholder}
                  </span>
                  <button
                    type="button"
                    className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t4 opacity-100 transition-all hover:bg-s2 hover:text-accent focus:bg-s2 focus:text-accent sm:h-5 sm:w-5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    onClick={(e) => { e.stopPropagation(); setEditingName(true); }}
                    aria-label={editableName.placeholder}
                  >
                    {Ic.edit()}
                  </button>
                </>
              )}
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">
              {labelTooltip ? (
                <CustomTooltip content={labelTooltip}>
                  <span className="cursor-help border-b border-dotted border-current pb-0.5">{label}</span>
                </CustomTooltip>
              ) : (
                label
              )}
            </span>
          )}
        </div>

        <div className="canvas-card-meta flex min-w-0 items-center gap-1.5">
          {hasValue && (
            <TokenCounter
              text={value}
              className="canvas-card-token flex shrink-0 justify-end whitespace-nowrap font-ui text-[11px] tabular-nums text-t2"
            />
          )}
          {role && <span className="canvas-card-role shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3">{role}</span>}
          {showDepthBadge && (
            <span className="canvas-card-slot shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t2 tabular-nums">
              {slotLabel === "in-chat" || /^\d+$/.test(String(slotLabel)) ? `←${slotDepthNum}` : slotLabel}
            </span>
          )}
        </div>

        <div className="canvas-card-actions flex shrink-0 items-center gap-0.5 sm:gap-1">
          {readOnly && (
            <CustomTooltip content={t("cc_read_only")}>
              <span role="img" className="flex h-5 w-5 shrink-0 items-center justify-center text-t4" aria-label={t("cc_read_only")}>
                {Ic.lock()}
              </span>
            </CustomTooltip>
          )}
          {onRemove && (
            <CustomTooltip content={t("cc_remove")}>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:danger-dim hover:text-danger sm:h-5 sm:w-5"
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                aria-label={t("cc_remove")}
              >
                <Ic.del />
              </button>
            </CustomTooltip>
          )}
          {expandable && (
            <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")} aria-hidden="true">▶</span>
          )}
        </div>
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
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span>{t("role")}</span>
                  <SegmentedControl
                    value={role}
                    options={roleOptions.map((r) => ({ value: r, label: r }))}
                    onChange={(v) => onRoleChange(v as "system" | "user" | "assistant")}
                    dense
                  />
                </div>
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
