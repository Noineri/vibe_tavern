/**
 * LinkBindingPopover — compact avatar pill multi-select for binding UI.
 *
 * Shows active character/persona/lorebook bindings as 22px avatar pills.
 * Clicking a pill unlinks it; clicking the dashed "+" opens a small popover
 * with available targets.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";
import { resolveEntityAvatarUrl, avatarUrl } from "../../lib/avatar.js";

export type LinkBindingTargetType = "character" | "persona" | "lorebook";

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
  onSetLinks: (links: LinkBindingRecord[]) => void;
  t: (key: string) => string;
  isMobile: boolean;
  tooltipLabel?: string;
  emptyLabel?: string;
  characterSectionLabel?: string;
  personaSectionLabel?: string;
  lorebookSectionLabel?: string;
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
  onSetLinks,
  t,
  isMobile,
  tooltipLabel,
  emptyLabel,
  characterSectionLabel,
  personaSectionLabel,
  lorebookSectionLabel,
}: LinkBindingPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const charMap = new Map(characters.map((c) => [c.id, c]));
  const personaMap = new Map(personas.map((p) => [p.id, p]));
  const lorebookMap = new Map(lorebooks.map((l) => [l.id, l]));

  const charLinks = links.filter((l) => l.targetType === "character");
  const personaLinks = links.filter((l) => l.targetType === "persona");
  const lorebookLinks = links.filter((l) => l.targetType === "lorebook");

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
    <div
      key={`${type}:${target.id}`}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-full border border-border bg-s2 pl-0.5 pr-2 text-t2 transition-colors hover:border-danger hover:text-danger select-none",
        pillCls,
      )}
      onClick={() => toggle(type, target.id)}
      title={`${target.name} — click to unlink`}
    >
      <AvatarDot target={target} size={pillAvatarSize} />
      <span className="max-w-[80px] truncate">{target.name}</span>
    </div>
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
    <div ref={containerRef} className="relative w-fit">
      <div className="inline-flex items-center gap-1 flex-wrap">
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
        <CustomTooltip content={addLabel}>
          <button
            type="button"
            className={cn(
              "group flex shrink-0 grow-0 justify-center text-t3 transition-colors hover:text-accent-t",
              isMobile ? "h-11 w-7 items-center" : "h-[22px] w-[22px] items-start",
            )}
            onClick={() => setOpen((v) => !v)}
            aria-label={addLabel}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full border border-dashed border-border2 leading-none transition-colors group-hover:border-accent group-hover:text-accent-t",
                isMobile ? "h-7 w-7 text-[12px]" : "h-[22px] w-[22px] text-[12px]",
              )}
            >
              +
            </span>
          </button>
        </CustomTooltip>
      </div>

      {open && (
        <div
          className="glass-blur absolute left-0 z-[200] mt-2 min-w-[240px] max-w-[340px] rounded-lg border border-border bg-glass-bg shadow-theme-lg"
          onClick={(e) => e.stopPropagation()}
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

          {characters.length === 0 && personas.length === 0 && lorebooks.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-t3">
              {emptyLabel || t("lore_link_empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
