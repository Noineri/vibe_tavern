/**
 * ExperienceGalleryCard — one mini-app card in the ExperienceEditor picker grid.
 *
 * Extracted from ExperienceEditor.tsx (the gallery grid and card markup moved
 * here verbatim: outer div, open button, preview, status dot, name,
 * description, footer; same classes, same test ids) for the arch-gate size
 * ratchet — ExperienceEditor sits exactly at its baseline, so extraction is
 * the only way to make room for new card behavior.
 *
 * Owner decision 2026-10-18, option A: the lone download arrow (hover-tooltip
 * only, nothing on a phone; no delete on the card) is replaced by a "..." menu
 * with Export / Duplicate / Delete items — a dropdown on desktop, a bottom
 * sheet on mobile. The desktop menu item and content classes are cloned from
 * RichChatRow.tsx:164-196 because no shared action-menu primitive exists.
 * Draft cards render no footer, as before.
 */
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "../../../lib/cn.js";
import { useT, type TFunc } from "../../../i18n/context.js";
import { Ic } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { ActionSheet } from "../../shared/ActionSheet.js";
import { getModalPortal } from "../../shared/modal-helpers.js";
import { ExperienceCardPreview } from "./ExperienceCardPreview.js";
import { ExperienceVisualBinding } from "./ExperienceVisualBinding.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";

/** The first bound visual that still exists in the available set — the same
 *  rule openScript uses to auto-select the editor's visual, reused here so the
 *  card delete targets the card's primary visual. Written once, used by both. */
export function firstExistingBoundVisual(
  bound: ExperienceVisualRow[],
  available: ExperienceVisualRow[],
): ExperienceVisualRow | undefined {
  return bound.find((v) => available.some((av) => av.id === v.id));
}

export interface ExperienceGalleryCardDeleteTarget {
  scriptId: string;
  visualId: string | null;
}

interface ExperienceGalleryCardProps {
  script: ScriptRecord;
  /** The server row merged with unsaved draft values (name/description/enabled). */
  display: ScriptRecord;
  isDraft: boolean;
  statusKey: Parameters<TFunc>[0];
  dotClass: string;
  bound: ExperienceVisualRow[];
  available: ExperienceVisualRow[];
  isMobile: boolean;
  onOpen: (scriptId: string) => void;
  onToggleVisual: (visualId: string, bind: boolean) => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: (target: ExperienceGalleryCardDeleteTarget) => void;
}

export function ExperienceGalleryCard({
  script,
  display,
  isDraft,
  statusKey,
  dotClass,
  bound,
  available,
  isMobile,
  onOpen,
  onToggleVisual,
  onExport,
  onDuplicate,
  onDelete,
}: ExperienceGalleryCardProps) {
  const { t } = useT();
  const [sheetOpen, setSheetOpen] = useState(false);
  const firstBoundVisual = bound[0] ?? null;
  const handleDelete = () => {
    onDelete({ scriptId: script.id, visualId: firstExistingBoundVisual(bound, available)?.id ?? null });
  };
  const triggerClassName = "flex h-8 w-8 max-md:h-9 max-md:w-9 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1";
  return (
    <div
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all hover:border-accent/40 hover:bg-s2"
    >
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col text-left"
        onClick={() => onOpen(script.id)}
      >
        <ExperienceCardPreview visualSource={firstBoundVisual?.source ?? null} />
        <div className="p-3.5">
          <div className="flex items-center gap-1.5">
            <CustomTooltip content={t(statusKey)}>
              <span
                aria-label={t(statusKey)}
                data-testid="card-status-dot"
                className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)}
              />
            </CustomTooltip>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-tight text-t1">{display.name}</span>
          </div>
          <div
            data-testid="card-description"
            className="mt-2 min-h-[3.25em] font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
          >
            {display.description && <div className="line-clamp-2">{display.description}</div>}
          </div>
        </div>
      </button>
      {!isDraft && (
        <div className="flex flex-1 items-stretch border-t border-border">
          <div className="min-w-0 flex-1 px-3 py-2">
            <ExperienceVisualBinding
              bound={bound}
              available={available}
              onToggle={onToggleVisual}
            />
          </div>
          {/* Card actions (owner option A): export / duplicate / delete behind
              a "..." trigger — a Radix dropdown on desktop, an action sheet
              on mobile. */}
          <div className="flex shrink-0 items-center border-l border-border px-2">
            {isMobile ? (
              <>
                <CustomTooltip content={t("management_more_actions")}>
                  <button
                    type="button"
                    aria-label={t("management_more_actions")}
                    data-testid="experience_card_menu"
                    className={triggerClassName}
                    onClick={() => setSheetOpen(true)}
                  >
                    <Ic.ellipsis />
                  </button>
                </CustomTooltip>
                <ActionSheet
                  open={sheetOpen}
                  title={display.name}
                  items={[
                    { icon: <Ic.download />, label: t("experience_card_export"), action: onExport },
                    { icon: <Ic.copy />, label: t("duplicate"), action: onDuplicate },
                    { icon: <Ic.del />, label: t("delete"), danger: true, action: handleDelete },
                  ]}
                  onClose={() => setSheetOpen(false)}
                />
              </>
            ) : (
              <DropdownMenu.Root modal={false}>
                <CustomTooltip content={t("management_more_actions")}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label={t("management_more_actions")}
                      data-testid="experience_card_menu"
                      className={triggerClassName}
                    >
                      <Ic.ellipsis />
                    </button>
                  </DropdownMenu.Trigger>
                </CustomTooltip>
                <DropdownMenu.Portal container={getModalPortal() ?? document.body}>
                  <DropdownMenu.Content
                    side="bottom"
                    align="end"
                    sideOffset={4}
                    className="glass-blur z-[200] w-[190px] rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                  >
                    <DropdownMenu.Item
                      data-testid="experience_card_export"
                      className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors duration-100 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                      onSelect={onExport}
                    >
                      <Ic.download /> {t("experience_card_export")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      data-testid="experience_card_duplicate"
                      className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors duration-100 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                      onSelect={onDuplicate}
                    >
                      <Ic.copy /> {t("duplicate")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      data-testid="experience_card_delete"
                      className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text outline-none transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text data-[highlighted]:bg-danger-dim data-[highlighted]:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                      onSelect={handleDelete}
                    >
                      <Ic.del /> {t("delete")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
