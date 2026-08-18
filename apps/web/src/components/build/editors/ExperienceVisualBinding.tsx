/**
 * ExperienceVisualBinding — the visual-binding pill cluster for an experience
 * card (ER-18b). CLONED from the shared `LinkBindingPopover` pill pattern
 * (rounded chip + icon dot + name, dashed "+" trigger opening a chip picker),
 * specialized for experience VISUALS: visuals carry no avatar, so the dot is an
 * icon (`Ic.stack`) instead of an avatar image, and the picker lists only
 * visuals. The shared component is deliberately NOT extended with a `visual`
 * type — visuals are icon-based and experience-scoped, so a sibling keeps both
 * clean (the user's instruction: clone, do not extend).
 *
 * Bind/unbind is wired through the existing BE-6 endpoints (`bindScriptVisual` /
 * `unbindScriptVisual`) by the caller; this component is purely presentational
 * (pills + picker) and reports intent via `onToggle`.
 */
import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { useT } from "../../../i18n/context.js";
import type { ExperienceVisualRow } from "../../../api/types.js";

interface ExperienceVisualBindingProps {
  /** Visuals already bound to this experience. */
  bound: ExperienceVisualRow[];
  /** Every visual available to bind (server-side, already saved). */
  available: ExperienceVisualRow[];
  /** Report a bind (`true`) / unbind (`false`) intent for a visual id. */
  onToggle: (visualId: string, bind: boolean) => void;
  disabled?: boolean;
}

export function ExperienceVisualBinding({ bound, available, onToggle, disabled }: ExperienceVisualBindingProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const boundIds = new Set(bound.map((v) => v.id));

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      {bound.map((v) => (
        <CustomTooltip key={v.id} content={`${v.name} — ${t("experience_visual_unbind_hint")}`}>
          <div
            className="flex h-[22px] max-md:h-9 min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-s2 pl-0.5 pr-2 text-[11px] text-t2 transition-colors hover:border-danger hover:text-danger select-none"
            onClick={() => onToggle(v.id, false)}
          >
            <span className="flex h-[18px] max-md:h-7 max-md:w-7 w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-dim text-accent-t"><Ic.stack /></span>
            <span className="truncate">{v.name}</span>
          </div>
        </CustomTooltip>
      ))}

      <Popover.Root open={open} onOpenChange={setOpen}>
        <CustomTooltip content={t("scope_visual")}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={t("scope_visual")}
              disabled={disabled}
              className={cn(
                "flex h-[22px] w-[22px] max-md:h-9 max-md:w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border2 text-[12px] leading-none text-t3 transition-colors hover:border-accent hover:text-accent-t",
                disabled && "pointer-events-none opacity-40",
              )}
            >
              +
            </button>
          </Popover.Trigger>
        </CustomTooltip>
        <Popover.Portal container={getModalPortal() ?? undefined}>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            className="glass-blur z-[220] min-w-[240px] max-w-[340px] rounded-lg border border-border bg-glass-bg shadow-theme-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            <div className="px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">{t("scope_visual")}</div>
              <div className="flex flex-wrap gap-1.5">
                {available.map((v) => {
                  const active = boundIds.has(v.id);
                  return (
                    <div
                      key={v.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-full border py-[2px] pl-[3px] pr-2 text-[12px] transition-all select-none",
                        active ? "border-accent bg-accent/10 text-accent-t" : "border-border bg-surface text-t3 hover:border-border2 hover:text-t2",
                      )}
                      onClick={() => onToggle(v.id, !active)}
                    >
                      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent-dim text-accent-t"><Ic.stack /></span>
                      <span className="max-w-[120px] truncate">{v.name}</span>
                      {active && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" className="ml-0.5 shrink-0">
                          <path d="M2.5 6L5 8.5L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  );
                })}
                {available.length === 0 && (
                  <div className="px-1 py-1 text-[12px] text-t3">{t("experience_assign_no_visual_option")}</div>
                )}
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
