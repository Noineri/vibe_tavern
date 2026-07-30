/**
 * LinkBindingPopover — compact avatar pill multi-select for binding UI.
 *
 * Shows active character/persona/lorebook bindings as 22px avatar pills.
 * Clicking a pill unlinks it; clicking the dashed "+" opens a small popover
 * with available targets.
 */
import { useCallback, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { cn } from "../../lib/cn.js";
import type { TFunc } from "../../i18n/locale-helpers.js";
import { CustomTooltip } from "./Tooltip.js";
import { getModalPortal } from "./modal-helpers.js";
import { resolveEntityAvatarUrl, avatarUrl } from "../../lib/avatar.js";

export type LinkBindingTargetType = "character" | "persona" | "lorebook" | "script";

export interface LinkTarget {
  id: string;
  name: string;
  avatarAssetId: string | null;
  /**
   * Entity kind for folder-resident avatar resolution
   * (resolveEntityAvatarUrl). Omitted for targets without a folder avatar
   * (e.g. lorebooks) — falls back to legacy flat-asset URL.
   */
  kind?: "characters" | "personas";
  avatarExt?: string | null;
  avatarFullExt?: string | null;
  avatarFullAssetId?: string | null;
  updatedAt?: string | null;
}

export interface LinkBindingRecord {
  targetType: LinkBindingTargetType;
  targetId: string;
}

interface LinkBindingPopoverProps {
  links: LinkBindingRecord[];
  characters: LinkTarget[];
  personas: LinkTarget[];
  lorebooks?: LinkTarget[];
  scripts?: LinkTarget[];
  onSetLinks: (links: LinkBindingRecord[]) => void;
  t: TFunc;
  isMobile: boolean;
  tooltipLabel?: string;
  emptyLabel?: string;
  characterSectionLabel?: string;
  personaSectionLabel?: string;
  lorebookSectionLabel?: string;
  scriptSectionLabel?: string;
  /** Disable the trigger button (e.g. while a generation is in flight). */
  disabled?: boolean;
  /** Render the bound pills inline (default true). Pass false when the caller
   *  renders the bound list itself and only needs the add trigger + popover
   *  (e.g. the Dice assignment row list). */
  showPills?: boolean;
  /** Text label on the add trigger — renders a labeled dashed button instead
   *  of the bare "+" circle (and drops the now-redundant tooltip). */
  triggerLabel?: string;
}

function resolveTargetAvatarUrl(target: LinkTarget): string | null {
  if (target.kind) {
    return resolveEntityAvatarUrl({
      kind: target.kind,
      id: target.id,
      avatarExt: target.avatarExt ?? null,
      avatarAssetId: target.avatarAssetId,
      avatarFullExt: target.avatarFullExt,
      avatarFullAssetId: target.avatarFullAssetId,
      updatedAt: target.updatedAt,
    });
  }
  // No folder-kind (e.g. lorebook) — legacy flat-asset fallback.
  return target.avatarAssetId ? avatarUrl(target.avatarAssetId) : null;
}

function AvatarDot({ target, size = 18 }: { target: LinkTarget; size?: number }) {
  const url = resolveTargetAvatarUrl(target);
  return (
    <div
      className="shrink-0 overflow-hidden rounded-full bg-s3"
      style={{ height: size, width: size }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-t3"
          style={{ fontSize: size * 0.55 }}
        >
          {target.name.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

export function LinkBindingPopover({
  links,
  characters,
  personas,
  lorebooks = [],
  scripts = [],
  onSetLinks,
  t,
  isMobile,
  tooltipLabel,
  emptyLabel,
  characterSectionLabel,
  personaSectionLabel,
  lorebookSectionLabel,
  scriptSectionLabel,
  disabled,
  showPills = true,
  triggerLabel,
}: LinkBindingPopoverProps) {
  const [open, setOpen] = useState(false);

  const charMap = new Map(characters.map((c) => [c.id, c]));
  const personaMap = new Map(personas.map((p) => [p.id, p]));
  const lorebookMap = new Map(lorebooks.map((l) => [l.id, l]));
  const scriptMap = new Map(scripts.map((s) => [s.id, s]));

  const charLinks = links.filter((l) => l.targetType === "character");
  const personaLinks = links.filter((l) => l.targetType === "persona");
  const lorebookLinks = links.filter((l) => l.targetType === "lorebook");
  const scriptLinks = links.filter((l) => l.targetType === "script");

  const toggle = useCallback(
    (targetType: LinkBindingTargetType, targetId: string) => {
      const exists = links.some(
        (l) => l.targetType === targetType && l.targetId === targetId,
      );
      if (exists) {
        onSetLinks(
          links.filter(
            (l) => !(l.targetType === targetType && l.targetId === targetId),
          ),
        );
      } else {
        onSetLinks([...links, { targetType, targetId }]);
      }
    },
    [links, onSetLinks],
  );

  const pillCls = isMobile
    ? "h-7 text-[12px]"
    : "h-[22px] text-[11px]";
  const pillAvatarSize = isMobile ? 22 : 18;
  const addLabel = tooltipLabel || t("lore_link_targets");

  const pill = (target: LinkTarget, type: LinkBindingTargetType) => (
    <CustomTooltip key={`${type}:${target.id}`} content={`${target.name} — ${t("lore_click_to_unlink")}`}>
      <div
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-s2 pl-0.5 pr-2 text-t2 transition-colors hover:border-danger hover:text-danger select-none",
          pillCls,
        )}
        onClick={() => toggle(type, target.id)}
      >
        <AvatarDot target={target} size={pillAvatarSize} />
        <span className="truncate">{target.name}</span>
      </div>
    </CustomTooltip>
  );

  const chip = (target: LinkTarget, type: LinkBindingTargetType, active: boolean) => (
    <div
      key={`${type}:${target.id}`}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-full border pl-[3px] pr-2 py-[2px] text-[12px] transition-all select-none",
        active
          ? "border-accent bg-accent/10 text-accent-t"
          : "border-border bg-surface text-t3 hover:border-border2 hover:text-t2",
      )}
      onClick={() => toggle(type, target.id)}
    >
      <AvatarDot target={target} size={18} />
      <span className="max-w-[120px] truncate">{target.name}</span>
      {active && (
        <svg
          width="10" height="10" viewBox="0 0 12 12"
          fill="none" stroke="currentColor" strokeWidth="2"
          className="shrink-0 ml-0.5"
        >
          <path d="M2.5 6L5 8.5L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );

  return (
    <div data-testid="resource-row" className="flex w-full flex-wrap items-center gap-1.5">
      {showPills && (
        <>
          {charLinks.map((l) => {
            const c = charMap.get(l.targetId);
            return c ? pill(c, "character") : null;
          })}
          {personaLinks.map((l) => {
            const p = personaMap.get(l.targetId);
            return p ? pill(p, "persona") : null;
          })}
          {lorebookLinks.map((l) => {
            const lb = lorebookMap.get(l.targetId);
            return lb ? pill(lb, "lorebook") : null;
          })}
          {scriptLinks.map((l) => {
            const sc = scriptMap.get(l.targetId);
            return sc ? pill(sc, "script") : null;
          })}
        </>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        {triggerLabel ? (
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={addLabel}
              disabled={disabled}
              className={cn(
                "flex items-center gap-1.5 rounded-md border border-dashed border-border2 px-2.5 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:border-accent hover:text-accent-t",
                disabled && "pointer-events-none opacity-40",
              )}
            >
              <span className="leading-none">+</span>
              {triggerLabel}
            </button>
          </Popover.Trigger>
        ) : (
          <CustomTooltip content={addLabel}>
            <Popover.Trigger asChild>
              <button
                type="button"
                aria-label={addLabel}
                disabled={disabled}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-full text-t3 transition-opacity",
                  isMobile ? "h-11 w-11" : "h-[22px] w-[22px]",
                  disabled && "pointer-events-none opacity-40",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full border border-dashed border-border2 leading-none transition-colors hover:border-accent hover:text-accent-t",
                    isMobile ? "h-7 w-7 text-[12px]" : "h-[22px] w-[22px] text-[12px]",
                  )}
                >
                  +
                </span>
              </button>
            </Popover.Trigger>
          </CustomTooltip>
        )}
        <Popover.Portal container={getModalPortal() ?? undefined}>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={8}
            className="glass-blur z-[220] min-w-[240px] max-w-[340px] rounded-lg border border-border bg-glass-bg shadow-theme-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
          {characters.length > 0 && (
            <div className="border-b border-border px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {characterSectionLabel || t("scope_char")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {characters.map((c) => chip(c, "character", charLinks.some((l) => l.targetId === c.id)))}
              </div>
            </div>
          )}

          {personas.length > 0 && (
            <div className="border-b border-border px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {personaSectionLabel || t("scope_persona")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {personas.map((p) => chip(p, "persona", personaLinks.some((l) => l.targetId === p.id)))}
              </div>
            </div>
          )}

          {lorebooks.length > 0 && (
            <div className="px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {lorebookSectionLabel || t("scope_lorebook")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {lorebooks.map((lb) => chip(lb, "lorebook", lorebookLinks.some((l) => l.targetId === lb.id)))}
              </div>
            </div>
          )}

          {scripts.length > 0 && (
            <div className="px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {scriptSectionLabel || t("scope_script")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scripts.map((sc) => chip(sc, "script", scriptLinks.some((l) => l.targetId === sc.id)))}
              </div>
            </div>
          )}

          {characters.length === 0 && personas.length === 0 && lorebooks.length === 0 && scripts.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-t3">
              {emptyLabel || t("lore_link_empty")}
            </div>
          )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
