import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { Toggle } from "../../shared/Toggle.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { GalleryViewer } from "./GalleryViewer.js";

interface GalleryGridProps {
  characterId: string;
  assets: CharacterAsset[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onSetAvatar: (asset: CharacterAsset) => void;
  /** D7 (path B two-tier): master gallery-prompt switch state. When false, the
   *  per-image include Toggle in the ⋯ menu is disabled because the backend
   *  AND-gates per-image inclusion behind this character-level flag. */
  masterIncludeEnabled: boolean;
}

/**
 * Per-image ⋯ overflow menu (D6). Rendered through a portal to document.body so
 * it escapes the tile's `overflow-hidden`. Positioned `fixed` from the trigger
 * button's rect. Closes on outside-click, Escape, scroll, and resize.
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

  // Position right-aligned to the trigger, opening downward; flip up if it
  // would overflow the bottom of the viewport.
  const [pos, setPos] = useState<{ top: number; left: number }>(() => {
    const menuWidth = 224;
    const menuEstHeight = 220;
    const top = anchorRect.bottom + 6 + menuEstHeight > window.innerHeight
      ? Math.max(8, anchorRect.top - 6 - menuEstHeight)
      : anchorRect.bottom + 6;
    const left = Math.max(8, Math.min(anchorRect.right - menuWidth, window.innerWidth - menuWidth - 8));
    return { top, left };
  });

  useLayoutEffect(() => {
    // Refine height-based flip once measured.
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
  onOpenViewer,
  masterEnabled,
}: {
  characterId: string;
  asset: CharacterAsset;
  isSelected: boolean;
  onToggle: () => void;
  onOpenViewer: () => void;
  masterEnabled: boolean;
}) {
  const { t } = useT();
  const id = asset.id as string;
  const url = serveCharacterAssetUrl(characterId, id);

  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isDescribing = describingSet?.has(id);
  const describe = useGalleryStore((s) => s.describe);
  const remove = useGalleryStore((s) => s.remove);
  const updateCaption = useGalleryStore((s) => s.updateCaption);
  const setIncludeInPrompt = useGalleryStore((s) => s.setIncludeInPrompt);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  // Orientation-aware container (same approach as CharacterForm avatar):
  // read natural size on load, set the tile's aspect-ratio so the image fills
  // its cell without a letterbox box or cropping. Until loaded we show a
  // skeleton with a neutral square ratio.
  const [ratio, setRatio] = useState<number | null>(null);

  // ⋯-menu inline-expandable sections: description view + caption edit live in
  // the menu now (the floating viewer is a bare image, per AvatarPanel).
  const [showDesc, setShowDesc] = useState(false);
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");

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

  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden rounded-lg border bg-s3/30 transition-all",
        isSelected ? "border-accent ring-1 ring-accent" : "border-border/50 hover:border-accent hover:shadow-md",
      )}
      style={{ aspectRatio: ratio ? String(ratio) : "1 / 1" }}
    >
      {ratio === null && (
        <div className="absolute inset-0 animate-pulse rounded-lg bg-s3/60" />
      )}

      <img
        src={url}
        alt={asset.caption || "Gallery image"}
        // object-cover — but the tile's aspect-ratio matches the image's natural
        // ratio (set on load), so cover == contain: the whole image shows, edge
        // to edge, with no letterbox and no crop.
        className="h-full w-full object-cover"
        loading="lazy"
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) {
            setRatio(img.naturalWidth / img.naturalHeight);
          }
        }}
      />

      {/* bottom caption strip */}
      {asset.caption && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] text-white/90 truncate">
          {asset.caption}
        </div>
      )}

      {/* status badges (top-right) */}
      <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1">
        {asset.description && !isDescribing && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase text-on-accent shadow-sm">
            {t("gallery_described_badge")}
          </span>
        )}
        {asset.includeInPrompt && asset.description && (
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

      {/* Selection checkbox (top-left) */}
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

      {/* Expand — bottom-left, the ONLY always-visible per-image action (D4/D6). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenViewer(); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-1.5 left-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-accent hover:text-on-accent"
        title={t("gallery_expand")}
      >
        <Icons.expand className="h-4 w-4" />
      </button>

      {/* ⋯ overflow trigger — bottom-right, hover-visible (D6). */}
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

      {menuOpen && menuRect && (
        <OverflowMenu anchorRect={menuRect} onClose={() => { setMenuOpen(false); setEditingCaption(false); setShowDesc(false); }}>
          {/* Per-image prompt inclusion (D7, path B two-tier). Disabled until
              BOTH gates pass: the character-level master switch (AND-gated in
              PromptAssemblyService) AND a non-empty description on this row. */}
          <label
            className={cn(
              "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-t2 hover:bg-s2",
              (!masterEnabled || !asset.description) && "opacity-40",
            )}
            onPointerDown={(e) => e.stopPropagation()}
            title={!masterEnabled ? t("gallery_include_needs_master") : !asset.description ? t("gallery_include_needs_description") : t("gallery_include_in_prompt_hint")}
          >
            <span className="flex items-center gap-2"><Icons.eye className="h-3.5 w-3.5" />{t("gallery_include_in_prompt")}</span>
            <Toggle
              checked={asset.includeInPrompt}
              disabled={!masterEnabled || !asset.description}
              onChange={(v) => { void setIncludeInPrompt(characterId, id, v); }}
            />
          </label>

          {/* Description view — moved out of the viewer into the ⋯ menu (viewer
              is now a bare floating image, per AvatarPanel). Expandable. */}
          {asset.description && (
            <>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2"
                onClick={(e) => { e.stopPropagation(); setShowDesc((v) => !v); }}
              >
                <span className="flex items-center gap-2"><Icons.eye className="h-3.5 w-3.5" />{t("gallery_description")}</span>
                <Icons.Caret direction={showDesc ? "u" : "d"} className="h-3 w-3 shrink-0" />
              </button>
              {showDesc && (
                <p className="max-h-32 overflow-y-auto border-l-2 border-accent/40 bg-s2/50 px-3 py-2 text-xs leading-relaxed text-t2">
                  {asset.description}
                </p>
              )}
            </>
          )}

          <button
            type="button"
            disabled={isDescribing}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2 disabled:opacity-50"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); void describe(characterId, [id]); }}
          >
            <Icons.eye className="h-3.5 w-3.5" />{t("gallery_describe")}
          </button>

          {/* Caption edit — inline-expandable (viewer no longer has chrome). */}
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

export function GalleryGrid({ characterId, assets, selectedIds, onToggleSelection, masterIncludeEnabled }: GalleryGridProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  return (
    <>
      {/* Fixed-width columns; each tile's HEIGHT derives from the image's own
          aspect ratio (read on load). Portrait images get tall cells, landscape
          get short ones — no uniform box, no letterboxing, no crop. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {assets.map((asset, idx) => (
          <GalleryTile
            key={asset.id as string}
            characterId={characterId}
            asset={asset}
            isSelected={selectedIds.has(asset.id as string)}
            onToggle={() => onToggleSelection(asset.id as string)}
            onOpenViewer={() => setViewerIndex(idx)}
            masterEnabled={masterIncludeEnabled}
          />
        ))}
      </div>

      {viewerIndex !== null && (
        <GalleryViewer
          characterId={characterId}
          assets={assets}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  );
}
