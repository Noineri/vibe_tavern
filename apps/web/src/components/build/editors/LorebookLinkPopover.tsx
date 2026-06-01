/**
 * LorebookLinkPopover — pill-style multi-select for linking a lorebook
 * to multiple characters and/or personas.
 *
 * Shows a compact row of avatar pills for current links.
 * Clicking "+" opens a popover with chip-style toggles.
 */
import { useState, useRef, useEffect, useCallback } from "react";

import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import type { LorebookLinkRecord } from "../../../app-client.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface LinkTarget {
  id: string;
  name: string;
  avatarAssetId: string | null;
}

interface LorebookLinkPopoverProps {
  /** Current links for this lorebook */
  links: LorebookLinkRecord[];
  /** All available characters */
  characters: LinkTarget[];
  /** All available personas */
  personas: LinkTarget[];
  /** Called when user changes the link set */
  onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  /** i18n */
  t: (key: string) => string;
  isMobile: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function avatarUrl(assetId: string | null): string | undefined {
  return assetId ? `/api/assets/${assetId}` : undefined;
}

/** Small avatar circle used in both pills and chips */
function AvatarDot({ target, size = 18 }: { target: LinkTarget; size?: number }) {
  return (
    <div
      className="shrink-0 overflow-hidden rounded-full bg-s3"
      style={{ height: size, width: size }}
    >
      {target.avatarAssetId ? (
        <img
          src={avatarUrl(target.avatarAssetId)}
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

// ── Component ──────────────────────────────────────────────────────────

export function LorebookLinkPopover({
  links,
  characters,
  personas,
  onSetLinks,
  t,
  isMobile,
}: LorebookLinkPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
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

  // Build lookup maps
  const charMap = new Map(characters.map((c) => [c.id, c]));
  const personaMap = new Map(personas.map((p) => [p.id, p]));

  const charLinks = links.filter((l) => l.targetType === "character");
  const personaLinks = links.filter((l) => l.targetType === "persona");

  const toggle = useCallback(
    (targetType: "character" | "persona", targetId: string) => {
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

  // ── Inline pill (shown in the trigger row) ──
  const pill = (target: LinkTarget, type: "character" | "persona") => (
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

  // ── Chip toggle (shown inside the popover) ──
  const chip = (target: LinkTarget, type: "character" | "persona", active: boolean) => (
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
      {/* Trigger: pills row + add button */}
      <div className="inline-flex items-center gap-1 flex-wrap">
        {charLinks.map((l) => {
          const c = charMap.get(l.targetId);
          return c ? pill(c, "character") : null;
        })}
        {personaLinks.map((l) => {
          const p = personaMap.get(l.targetId);
          return p ? pill(p, "persona") : null;
        })}
        <CustomTooltip content={t("lore_link_targets") || "Link to characters/personas"}>
          <button
            type="button"
            className={cn(
              "group flex shrink-0 grow-0 items-start justify-center text-t3 transition-colors hover:text-accent-t",
              isMobile ? "h-11 w-7" : "h-[22px] w-[22px]",
            )}
            onClick={() => setOpen((v) => !v)}
            aria-label={t("lore_link_targets") || "Link to characters/personas"}
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

      {/* Popover with chips */}
      {open && (
        <div
          className="absolute left-0 z-[200] mt-2 min-w-[240px] max-w-[340px] rounded-lg border border-border bg-surface shadow-theme-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Characters section */}
          {characters.length > 0 && (
            <div className="border-b border-border px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {t("scope_char") || "Characters"}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {characters.map((c) => {
                  const active = charLinks.some((l) => l.targetId === c.id);
                  return chip(c, "character", active);
                })}
              </div>
            </div>
          )}

          {/* Personas section */}
          {personas.length > 0 && (
            <div className="px-3 py-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                {t("scope_persona") || "Personas"}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {personas.map((p) => {
                  const active = personaLinks.some((l) => l.targetId === p.id);
                  return chip(p, "persona", active);
                })}
              </div>
            </div>
          )}

          {characters.length === 0 && personas.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-t3">
              {t("lore_link_empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
