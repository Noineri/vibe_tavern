import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { Toggle } from "../../shared/Toggle.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { GalleryViewer } from "./GalleryViewer.js";
import { GalleryLightbox } from "./GalleryLightbox.js";

interface GalleryGridProps {
  characterId: string;
  assets: CharacterAsset[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  /** D8: open the avatar crop modal seeded with this gallery row. */
  onSetAsAvatar: (asset: CharacterAsset) => void;
}

/** Justified-grid tile height (image area only; the one-line footer is extra).
 *  Desktop 350 (rich gallery view under the accordion), mobile ~220 so two
 *  portraits still fit a phone screen side by side. */
function useTileHeight(): number {
  const isMobile = useIsMobile();
  return isMobile ? 220 : 350;
}

/** Max image-area aspect-derived width as a fraction of the grid container, so
 *  a single ultra-wide panorama can't eat a whole row (cap, then crop). */
const MAX_TILE_WIDTH_RATIO = 0.92;

/** Module-level aspect-ratio cache, keyed by asset URL. Survives accordion
 *  unmount/remount and tile re-render, so re-opening the gallery never reflows
 *  from a throwaway square footprint to the real aspect-derived width — the
 *  classic open-time twitch. The cache is best-effort: a first-ever open of an
 *  unseen image still resolves its ratio on load (unavoidable without stored
 *  width/height metadata), but every subsequent open in the session is stable. */
const aspectCache = new Map<string, number>();

/**
 * Per-image ⋯ overflow menu. Portaled to document.body so it escapes the tile's
 * `overflow-hidden`. Positioned `fixed` from the trigger button's rect. Closes
 * on outside-click, Escape, scroll, and resize.
 */
function OverflowMenu({
  anchorRect,
  onClose,
  children,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>(() => {
    const menuWidth = 224;
    const estHeight = 220;
    const top = anchorRect.bottom + 6 + estHeight > window.innerHeight
      ? Math.max(8, anchorRect.top - 6 - estHeight)
      : anchorRect.bottom + 6;
    const left = Math.max(8, Math.min(anchorRect.right - menuWidth, window.innerWidth - menuWidth - 8));
    return { top, left };
  });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    setPos((p) => {
      if (p.top + h > window.innerHeight - 8 && anchorRect.top - 6 - h > 8) {
        return { top: anchorRect.top - 6 - h, left: p.left };
      }
      return p;
    });
  }, [anchorRect.top]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onScrollOrResize = () => onClose();
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[700] w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[0_12px_36px_rgba(0,0,0,.45)]"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

function GalleryTile({
  characterId,
  asset,
  isSelected,
  onToggle,
  onOpenLightbox,
  onOpenPanel,
  onSetAsAvatar,
  tileHeight,
}: {
  characterId: string;
  asset: CharacterAsset;
  isSelected: boolean;
  onToggle: () => void;
  onOpenLightbox: () => void;
  onOpenPanel: () => void;
  /** D8: open the avatar crop modal for this tile. */
  onSetAsAvatar: () => void;
  tileHeight: number;
}) {
  const { t } = useT();
  const id = asset.id as string;
  const url = serveCharacterAssetUrl(characterId, id);
  const imgRef = useRef<HTMLImageElement>(null);

  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isDescribing = describingSet?.has(id);
  const describe = useGalleryStore((s) => s.describe);
  const cancelDescribe = useGalleryStore((s) => s.cancelDescribe);
  const remove = useGalleryStore((s) => s.remove);
  const updateCaption = useGalleryStore((s) => s.updateCaption);
  const setIncludeInPrompt = useGalleryStore((s) => s.setIncludeInPrompt);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  // Orientation-aware width (justified layout): derive the tile width from
  // the fixed image height × aspect ratio. The ratio is seeded from the
  // module-level aspectCache (stable across re-opens), refined synchronously
  // before paint if the browser already has the bitmap decoded, and confirmed
  // on load. Until known we reserve a square footprint so the row has a shape
  // while the first decode completes.
  const [ratio, setRatio] = useState<number | null>(() => aspectCache.get(url) ?? null);
  const imgHeight = tileHeight;
  const rawWidth = ratio ? imgHeight * ratio : imgHeight;
  // Cap panorama width so a single ultra-wide image can't monopolise a row.
  const tileWidth = Math.min(rawWidth, tileHeight * 3);

  // Synchronous resolve for already-cached bitmaps: if the browser decoded the
  // image before paint (HTTP cache or a repeated open), adopt its ratio now so
  // the tile never paints a throwaway square footprint and snaps later.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (ratio == null && img?.complete && img.naturalWidth && img.naturalHeight) {
      const r = img.naturalWidth / img.naturalHeight;
      aspectCache.set(url, r);
      setRatio(r);
    }
  }, [ratio, url]);

  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");

  const hasDescription = !!asset.description?.trim();
  // Warning state: include toggled ON but no description yet → the flag is
  // stored but won't inject until a description exists (backend AND-gate).
  const includeWarns = asset.includeInPrompt && !hasDescription;

  const openMenu = () => {
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuRect(rect);
    setMenuOpen(true);
  };

  const startEditCaption = () => {
    setCaptionDraft(asset.caption || "");
    setEditingCaption(true);
  };
  const saveCaption = useCallback(async () => {
    await updateCaption(characterId, id, captionDraft);
    setEditingCaption(false);
  }, [updateCaption, characterId, id, captionDraft]);

  // Footer text: caption wins; else a one-line slice of the AI description
  // (italic gray) so an undescribed-but-captioned tile still reads cleanly.
  // When neither exists we render a muted placeholder so the empty footer
  // doesn't read as a layout bug — three explicit states keep the tile's
  // bottom edge visually stable.
  const footerText = asset.caption?.trim()
    || (hasDescription ? asset.description!.trim() : "");
  const footerIsFallback = !asset.caption?.trim() && hasDescription;
  const footerIsEmpty = !footerText;

  return (
    <div
      className={cn(
        "group relative flex shrink-0 flex-col overflow-hidden rounded-lg border bg-s3/30 transition-all",
        isSelected ? "border-accent ring-1 ring-accent" : "border-border/50 hover:border-accent hover:shadow-md",
      )}
      style={{ width: `calc(${tileWidth}px * ${MAX_TILE_WIDTH_RATIO} + 8%)`, maxWidth: "100%" }}
    >
      {/* Image area — fixed height; width follows the tile (aspect-derived). */}
      <div className="relative w-full" style={{ height: imgHeight }}>
        <img
          ref={imgRef}
          src={url}
          alt={asset.caption || "Gallery image"}
          // object-cover: the tile width is derived from the image's own aspect
          // ratio, so cover == contain for the common case; only ultra-wide
          // panoramas (capped width) crop slightly.
          className="h-full w-full cursor-zoom-in object-cover"
          loading="lazy"
          draggable={false}
          onClick={(e) => { e.stopPropagation(); onOpenLightbox(); }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              const r = img.naturalWidth / img.naturalHeight;
              aspectCache.set(url, r);
              setRatio(r);
            }
          }}
        />

        {/* Status badges (top-right): described + included-in-prompt. */}
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1">
          {hasDescription && !isDescribing && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase text-on-accent shadow-sm">
              {t("gallery_described_badge")}
            </span>
          )}
          {asset.includeInPrompt && hasDescription && (
            <span className="flex items-center justify-center rounded-full bg-black/60 p-0.5 text-success shadow-sm" title={t("gallery_in_prompt")}>
              <Icons.check className="h-3 w-3" />
            </span>
          )}
        </div>

        {isDescribing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <span className="block h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}

        {/* Selection checkbox (top-left). */}
        <div
          className={cn(
            "absolute left-1.5 top-1.5 z-20 p-0.5 transition-opacity",
            isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox checked={isSelected} onChange={onToggle} />
        </div>

        {/* Expand → floating panel (bottom-left). */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenPanel(); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-1.5 left-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all hover:bg-accent hover:text-on-accent group-hover:opacity-100"
          title={t("gallery_expand")}
        >
          <Icons.expand className="h-4 w-4" />
        </button>

        {/* ⋯ overflow trigger (bottom-right). */}
        <button
          ref={menuBtnRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); menuOpen ? setMenuOpen(false) : openMenu(); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-1.5 right-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all hover:bg-accent hover:text-on-accent group-hover:opacity-100"
          title={t("gallery_more_actions")}
          aria-haspopup="menu"
        >
          <Icons.ellipsis className="h-4 w-4" />
        </button>
      </div>

      {/* One-line footer: caption (bold) or a slice of the AI description
          (italic gray fallback). When empty, a muted placeholder keeps the
          tile's bottom edge from reading as a broken layout. Truncated to a
          single line. */}
      <div className={cn(
        "w-full truncate px-2 py-1 text-[11px]",
        footerIsEmpty
          ? "italic text-t3/40"
          : footerIsFallback
            ? "italic text-t3"
            : "font-medium text-t2",
      )}>
        {footerText || t("gallery_footer_empty")}
      </div>

      {menuOpen && menuRect && (
        <OverflowMenu anchorRect={menuRect} onClose={() => { setMenuOpen(false); setEditingCaption(false); }}>
          {/* Per-image prompt inclusion — sole gate now (no master switch).
              Always enabled; warns (amber) when on without a description. */}
          <CustomTooltip content={includeWarns ? t("gallery_include_no_desc_warning") : t("gallery_include_in_prompt_hint")}>
            <label
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-t2 hover:bg-s2",
                includeWarns && "bg-amber-500/10",
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="flex items-center gap-2">
                {includeWarns
                  ? <Icons.alert className="h-3.5 w-3.5 text-amber-500" />
                  : <Icons.eye className="h-3.5 w-3.5" />}
                {t("gallery_include_in_prompt")}
              </span>
              <Toggle
                checked={asset.includeInPrompt}
                onChange={(v) => { void setIncludeInPrompt(characterId, id, v); }}
              />
            </label>
          </CustomTooltip>

          {/* Describe / Cancel describe — single-image quick action. */}
          {isDescribing ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); cancelDescribe(characterId); }}
            >
              <Icons.close className="h-3.5 w-3.5" />{t("gallery_describe_cancel")}
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); void describe(characterId, [id]); }}
            >
              <Icons.eye className="h-3.5 w-3.5" />{hasDescription ? t("gallery_regenerate") : t("gallery_describe")}
            </button>
          )}

          {/* Caption edit — inline-expandable. */}
          {!editingCaption ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2"
              onClick={(e) => { e.stopPropagation(); startEditCaption(); }}
            >
              <Icons.edit className="h-3.5 w-3.5" />{asset.caption ? t("edit_caption") : t("add_caption")}
            </button>
          ) : (
            <div className="px-2 py-2" onPointerDown={(e) => e.stopPropagation()}>
              <AutoTextarea
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void saveCaption(); } }}
                className="w-full rounded bg-s2 px-2 py-1.5 text-sm text-t1 outline-none ring-1 ring-border focus:ring-accent"
                style={{}} maxHeight={140}
                placeholder={t("caption_placeholder")} autoFocus
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button type="button" className="cursor-pointer rounded bg-s2 px-2.5 py-1 text-xs text-t2 hover:bg-s3" onClick={(e) => { e.stopPropagation(); setEditingCaption(false); }}>{t("cancel")}</button>
                <button type="button" className="cursor-pointer rounded bg-accent px-2.5 py-1 text-xs text-on-accent hover:bg-accent/80" onClick={(e) => { e.stopPropagation(); void saveCaption(); }}>{t("save")}</button>
              </div>
            </div>
          )}

          <div className="my-1 border-t border-border/60" />

          {/* D8: set this gallery image as the avatar. Opens the crop modal
              (seeded with this full image); the server salvages the current
              avatar into the gallery first. */}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onSetAsAvatar(); }}
          >
            <Icons.user className="h-3.5 w-3.5" />{t("gallery_set_avatar")}
          </button>

          <div className="my-1 border-t border-border/60" />

          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger transition-colors hover:bg-danger/10"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); void remove(characterId, id); }}
          >
            <Icons.del className="h-3.5 w-3.5" />{t("delete")}
          </button>
        </OverflowMenu>
      )}
    </div>
  );
}

export function GalleryGrid({ characterId, assets, selectedIds, onToggleSelection, onSetAsAvatar }: GalleryGridProps) {
  const tileHeight = useTileHeight();
  // Multiple floating panels may be open at once (original design intent):
  // each entry in the set renders its own independent GalleryViewer.
  const [openPanels, setOpenPanels] = useState<Set<number>>(new Set());
  // The lightbox is a single focused surface (separate from the panels).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const togglePanel = (idx: number) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <>
      {/* Justified grid: fixed-height image area, width follows each image's
          aspect ratio. Portrait tiles are tall+narrow, landscape are
          tall+wide, wrapping left→right like a Google-Photos row. */}
      <div className="flex flex-wrap gap-3">
        {assets.map((asset, idx) => (
          <GalleryTile
            key={asset.id as string}
            characterId={characterId}
            asset={asset}
            isSelected={selectedIds.has(asset.id as string)}
            onToggle={() => onToggleSelection(asset.id as string)}
            onOpenLightbox={() => setLightboxIndex(idx)}
            onOpenPanel={() => togglePanel(idx)}
            onSetAsAvatar={() => onSetAsAvatar(asset)}
            tileHeight={tileHeight}
          />
        ))}
      </div>

      {/* One independent floating viewer per open index. */}
      {[...openPanels].map((idx) => (
        <GalleryViewer
          key={idx}
          characterId={characterId}
          asset={assets[idx]}
          onClose={() => togglePanel(idx)}
        />
      ))}

      {lightboxIndex !== null && (
        <GalleryLightbox
          characterId={characterId}
          assets={assets}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
