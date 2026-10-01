/**
 * LinkBindingPopover — compact avatar pill multi-select for binding UI.
 *
 * Shows active character/persona/lorebook bindings as 22px avatar pills.
 * Clicking a pill unlinks it; clicking the dashed "+" opens a small popover
 * with available targets.
 */
import { useCallback, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { cn } from "../../lib/cn.js";
import type { TFunc } from "../../i18n/locale-helpers.js";
import type { LinkBindingRecord, LinkBindingTargetType, LinkTarget } from "../../lib/link-targets.js";
import { deriveLinkSections, type LinkSectionInput } from "../../lib/link-binding-sections.js";
import { CustomTooltip } from "./Tooltip.js";
import { getModalPortal } from "./modal-helpers.js";
import { resolveEntityAvatarUrl, avatarUrl } from "../../lib/avatar.js";
import { SearchInput } from "./SearchInput.js";
import { BottomSheet } from "./BottomSheet.js";
import { MAX_VISIBLE_ITEMS } from "./popover-constants.js";

export type { LinkBindingRecord, LinkBindingTargetType, LinkTarget } from "../../lib/link-targets.js";

interface LinkBindingPopoverProps {
  links: LinkBindingRecord[];
  characters: LinkTarget[];
  personas: LinkTarget[];
  lorebooks?: LinkTarget[];
  scripts?: LinkTarget[];
  presets?: LinkTarget[];
  regexes?: LinkTarget[];
  onSetLinks: (links: LinkBindingRecord[]) => void;
  t: TFunc;
  isMobile: boolean;
  tooltipLabel?: string;
  emptyLabel?: string;
  characterSectionLabel?: string;
  personaSectionLabel?: string;
  lorebookSectionLabel?: string;
  scriptSectionLabel?: string;
  presetSectionLabel?: string;
  regexSectionLabel?: string;
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
          loading="lazy"
          decoding="async"
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
  presets = [],
  regexes = [],
  onSetLinks,
  t,
  isMobile,
  tooltipLabel,
  emptyLabel,
  characterSectionLabel,
  personaSectionLabel,
  lorebookSectionLabel,
  scriptSectionLabel,
  presetSectionLabel,
  regexSectionLabel,
  disabled,
  showPills = true,
  triggerLabel,
}: LinkBindingPopoverProps) {
  const [open, setOpen] = useState(false);
  // Variant-A picker state (LB-2C): live query, per-section expansion, and
  // the links SNAPSHOT taken at open. The snapshot keeps the order stable
  // while the picker is open (a chip never jumps under the cursor when
  // clicked); the LIVE `links` prop still drives the active look, so the
  // checkmark toggles instantly. The next open re-sorts.
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<LinkBindingTargetType>>(() => new Set());
  const [openLinks, setOpenLinks] = useState<LinkBindingRecord[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) setOpenLinks(links);
      setQuery("");
      setExpanded(new Set());
    },
    [links],
  );

  const charMap = new Map(characters.map((c) => [c.id, c]));
  const personaMap = new Map(personas.map((p) => [p.id, p]));
  const lorebookMap = new Map(lorebooks.map((l) => [l.id, l]));
  const scriptMap = new Map(scripts.map((s) => [s.id, s]));
  const presetMap = new Map(presets.map((p) => [p.id, p]));
  const regexMap = new Map(regexes.map((r) => [r.id, r]));

  const charLinks = links.filter((l) => l.targetType === "character");
  const personaLinks = links.filter((l) => l.targetType === "persona");
  const lorebookLinks = links.filter((l) => l.targetType === "lorebook");
  const scriptLinks = links.filter((l) => l.targetType === "script");
  const presetLinks = links.filter((l) => l.targetType === "preset");
  const regexLinks = links.filter((l) => l.targetType === "regex");

  // Per-type LIVE bound-id sets (chip active marks) — Set lookups, never a
  // per-chip `links.some`.
  const liveBoundIds = new Map<LinkBindingTargetType, Set<string>>();
  for (const l of links) {
    const set = liveBoundIds.get(l.targetType) ?? new Set<string>();
    set.add(l.targetId);
    liveBoundIds.set(l.targetType, set);
  }

  // Sections in today's fixed order; the picker renders ONLY what
  // deriveLinkSections returns — no second hand-written ordering/filtering
  // anywhere (LB-2B is the one data source).
  const sectionInputs: LinkSectionInput[] = [
    { key: "character", targets: characters },
    { key: "persona", targets: personas },
    { key: "lorebook", targets: lorebooks },
    { key: "script", targets: scripts },
    { key: "preset", targets: presets },
    { key: "regex", targets: regexes },
  ];
  const result = deriveLinkSections({
    sections: sectionInputs,
    links: open ? openLinks : links,
    query,
    expanded,
    visibleLimit: MAX_VISIBLE_ITEMS,
  });
  // Header counts show ALL targets of the section, not the visible slice.
  const countByKey = new Map(sectionInputs.map((s) => [s.key, s.targets.length]));
  const hasAnyTargets = sectionInputs.some((s) => s.targets.length > 0);

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

  const sectionLabel = (key: LinkBindingTargetType): string => {
    switch (key) {
      case "character": return characterSectionLabel || t("scope_char");
      case "persona": return personaSectionLabel || t("scope_persona");
      case "lorebook": return lorebookSectionLabel || t("scope_lorebook");
      case "script": return scriptSectionLabel || t("scope_script");
      case "preset": return presetSectionLabel || t("scope_preset");
      case "regex": return regexSectionLabel || t("scope_regex");
    }
  };

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
  // ONE body element, rendered by both shells (desktop Radix popover /
  // mobile BottomSheet) — the dual-mode canon (ImageGenFineTuningChip).
  const body = (
    <div className="flex min-h-0 flex-col">
      {result.showSearch && (
        <div className="shrink-0 border-b border-border px-3 py-2">
          <SearchInput
            ref={searchInputRef}
            className="w-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("link_binding_search_placeholder")}
            aria-label={t("link_binding_search_placeholder")}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {result.sections.map((view, i) => (
          <div
            key={view.key}
            className={cn("px-3 py-2.5", i < result.sections.length - 1 && "border-b border-border")}
          >
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
              {sectionLabel(view.key)} · {countByKey.get(view.key) ?? 0}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {view.items.map((target) =>
                chip(target, view.key, liveBoundIds.get(view.key)?.has(target.id) ?? false),
              )}
              {view.hiddenCount > 0 && (
                <button
                  type="button"
                  className="flex cursor-pointer items-center rounded-full border border-dashed border-border2 px-2.5 py-[2px] text-[12px] text-t3 transition-colors select-none hover:border-accent hover:text-accent-t"
                  onClick={() => setExpanded((prev) => new Set(prev).add(view.key))}
                >
                  {t("link_binding_show_more", { n: view.hiddenCount })}
                </button>
              )}
              {view.collapsible && (
                <button
                  type="button"
                  className="flex cursor-pointer items-center rounded-full border border-dashed border-border2 px-2.5 py-[2px] text-[12px] text-t3 transition-colors select-none hover:border-accent hover:text-accent-t"
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      next.delete(view.key);
                      return next;
                    })
                  }
                >
                  {t("link_binding_show_less")}
                </button>
              )}
            </div>
          </div>
        ))}
        {result.noResults && (
          <div className="px-3 py-4 text-center text-[12px] text-t3">{t("link_binding_no_results")}</div>
        )}
        {!hasAnyTargets && (
          <div className="px-3 py-4 text-center text-[12px] text-t3">{emptyLabel || t("lore_link_empty")}</div>
        )}
      </div>
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
          {presetLinks.map((l) => {
            const p = presetMap.get(l.targetId);
            return p ? pill(p, "preset") : null;
          })}
          {regexLinks.map((l) => {
            const r = regexMap.get(l.targetId);
            return r ? pill(r, "regex") : null;
          })}
          {/* Dangling links (target row gone — e.g. character deleted before
              R-10's cleanup landed): render as unlinkable ghost pills instead
              of silently vanishing, so dead bindings stay visible and
              removable. Click removes the link (full-set PUT). */}
          {links
            .filter(
              (l) =>
                !charMap.has(l.targetId) && !personaMap.has(l.targetId) &&
                !lorebookMap.has(l.targetId) && !scriptMap.has(l.targetId) &&
                !presetMap.has(l.targetId) && !regexMap.has(l.targetId),
            )
            .map((l) => (
              <div
                key={`ghost:${l.targetType}:${l.targetId}`}
                className={cn(
                  "flex min-w-0 cursor-pointer items-center gap-1 rounded-full border border-dashed border-border bg-s2 px-2 text-t4 transition-colors hover:border-danger hover:text-danger select-none",
                  pillCls,
                )}
                onClick={() => onSetLinks(links.filter((x) => x.targetType !== l.targetType || x.targetId !== l.targetId))}
              >
                <span className="truncate italic">{t("link_target_deleted")}</span>
              </div>
            ))}
        </>
      )}
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
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
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={8}
              onOpenAutoFocus={(e) => {
                // Focus the search row when it exists; otherwise keep Radix's
                // default focus (first focusable item).
                if (result.showSearch) {
                  e.preventDefault();
                  searchInputRef.current?.focus();
                }
              }}
              className="glass-blur z-[220] flex min-w-[240px] max-w-[340px] max-h-[min(70vh,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-lg border border-border bg-glass-bg shadow-theme-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {body}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
      {open && isMobile && (
        <BottomSheet open={true} onClose={() => handleOpenChange(false)} title={addLabel}>
          {/* The sheet itself is unbounded — the body gets the mobile
              content-height cap (the DiceTray/ImageGen mobile-sheet rule). */}
          <div className="max-h-[80dvh]">{body}</div>
        </BottomSheet>
      )}
    </div>
  );
}
