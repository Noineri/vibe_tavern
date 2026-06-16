import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { Toggle } from "../../shared/Toggle.js";
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
}

/**
 * Per-image ⋯ overflow menu (D6). Rendered through a portal to document.body so
 * it escapes the tile's `overflow-hidden` (the tile clips the letterboxed image
 * to its rounded corners). Positioned `fixed` from the trigger button's rect so
 * transformed/overflow ancestors can't clip or misplace it. Closes on
 * outside-click, Escape, scroll, and resize.
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
    const menuWidth = 208;
    const menuEstHeight = 200;
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
      className="fixed z-[700] w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-[0_12px_36px_rgba(0,0,0,.45)]"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

function DraggableGridItem({
  characterId,
  asset,
  isSelected,
  onToggle,
  onOpenViewer,
}: {
  characterId: string;
  asset: CharacterAsset;
  isSelected: boolean;
  onToggle: () => void;
  onOpenViewer: () => void;
}) {
  const { t } = useT();
  const id = asset.id as string;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  const { setNodeRef: setDropNodeRef } = useDroppable({ id });
  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isDescribing = describingSet?.has(id);
  const describe = useGalleryStore((s) => s.describe);
  const remove = useGalleryStore((s) => s.remove);
  const setIncludeInPrompt = useGalleryStore((s) => s.setIncludeInPrompt);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  // We assign both ref setters to the same DOM node using a callback ref
  const setBothRefs = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setDropNodeRef(node);
    },
    [setNodeRef, setDropNodeRef],
  );

  const openMenu = () => {
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuRect(rect);
    setMenuOpen(true);
  };

  return (
    <div
      ref={setBothRefs}
      className={cn(
        "group relative flex h-48 w-full cursor-grab overflow-hidden rounded-lg border bg-s3/30 shadow-sm transition-all active:cursor-grabbing",
        isSelected ? "border-accent ring-1 ring-accent" : "border-border/50 hover:border-accent hover:shadow-md",
        isDragging && "opacity-50 z-10",
      )}
      {...attributes}
      {...listeners}
    >
      <img
        src={serveCharacterAssetUrl(characterId, id)}
        alt={asset.caption || "Gallery image"}
        // object-contain (D2): letterbox the whole image on a neutral tile so
        // portrait/landscape are both recognisable without opening Expand.
        className="h-full w-full p-1.5 object-contain transition-transform duration-300 group-hover:scale-[1.02]"
        loading="lazy"
        draggable={false}
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

      {/* Expand — bottom-left, the ONLY always-visible per-image action (D4/D6) */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenViewer(); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-1.5 left-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-accent hover:text-on-accent"
        title={t("gallery_expand")}
      >
        <Icons.expand className="h-4 w-4" />
      </button>

      {/* ⋯ overflow trigger — bottom-right, hover-visible (D6) */}
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
        <OverflowMenu anchorRect={menuRect} onClose={() => setMenuOpen(false)}>
          {/* Per-image prompt inclusion (D7) — gated on having a description:
              an undescribed row carries no prompt value, so including it is a no-op. */}
          <label
            className={cn(
              "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-t2 hover:bg-s2",
              !asset.description && "opacity-40",
            )}
            onPointerDown={(e) => e.stopPropagation()}
            title={asset.description ? t("gallery_include_in_prompt_hint") : t("gallery_include_needs_description")}
          >
            <span className="flex items-center gap-2"><Icons.eye className="h-3.5 w-3.5" />{t("gallery_include_in_prompt")}</span>
            <Toggle
              checked={asset.includeInPrompt}
              disabled={!asset.description}
              onChange={(v) => { void setIncludeInPrompt(characterId, id, v); }}
            />
          </label>

          <button
            type="button"
            disabled={isDescribing}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-t2 transition-colors hover:bg-s2 disabled:opacity-50"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); void describe(characterId, [id]); }}
          >
            <Icons.eye className="h-3.5 w-3.5" />{t("gallery_describe")}
          </button>

          {/* Set-as-avatar is intentionally omitted until R4 (D8): the salvage flow + crop modal is not wired yet. The handler stays in the public GalleryGridProps so R4 can attach it here. */}

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

const mouseSensorOptions = { activationConstraint: { distance: 2 } };
const touchSensorOptions = { activationConstraint: { distance: 2 } };

export function GalleryGrid({ characterId, assets, selectedIds, onToggleSelection }: GalleryGridProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const reorder = useGalleryStore((s) => s.reorder);

  const sensors = useSensors(
    useSensor(MouseSensor, mouseSensorOptions),
    useSensor(TouchSensor, touchSensorOptions),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = assets.findIndex((a) => a.id === active.id);
    const newIndex = assets.findIndex((a) => a.id === over.id);

    if (oldIndex !== -1 && newIndex !== -1) {
      const nextList = [...assets];
      const [item] = nextList.splice(oldIndex, 1);
      nextList.splice(newIndex, 0, item);
      void reorder(characterId, nextList.map((a) => a.id as string));
    }
  };

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        {/* D5: bigger cells — floor raised from 160px to 230px so a gallery
            actually previews images instead of showing cropped thumbnails. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {assets.map((asset, idx) => (
            <DraggableGridItem
              key={asset.id as string}
              characterId={characterId}
              asset={asset}
              isSelected={selectedIds.has(asset.id as string)}
              onToggle={() => onToggleSelection(asset.id as string)}
              onOpenViewer={() => setViewerIndex(idx)}
            />
          ))}
        </div>
      </DndContext>

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
