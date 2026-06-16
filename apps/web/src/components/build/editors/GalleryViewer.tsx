import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";

interface GalleryViewerProps {
  characterId: string;
  assets: CharacterAsset[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

const MIN_ZOOM = 0.2;
const TOPBAR_HEIGHT = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sw").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 248;
}

/** Initial attached position: just inside the sidebar, below the TopBar. */
function getAttachedPosition(): { x: number; y: number } {
  return { x: getSidebarWidth() + 22, y: TOPBAR_HEIGHT + 16 };
}

/** Zoom that fits a natural-sized image into a comfortable floating area. */
function getFitZoom(naturalWidth: number, naturalHeight: number): number {
  const maxVisualWidth = Math.min(560, Math.max(320, window.innerWidth - getSidebarWidth() - 56));
  const maxVisualHeight = Math.min(560, Math.max(280, window.innerHeight - TOPBAR_HEIGHT - 180));
  return Math.min(1, maxVisualWidth / naturalWidth, maxVisualHeight / naturalHeight);
}

export function GalleryViewer({ characterId, assets, index, onIndexChange, onClose }: GalleryViewerProps) {
  const isMobile = useIsMobile();
  const asset = assets[index];

  // Reset internal edit state whenever the viewed image changes.
  useEffect(() => {
    if (asset) {
      setEditing(false);
      setEditText(asset.caption || "");
    }
  }, [asset]);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  // keep eslint-free refs to the setters used in the effect above
  const setEditingLocal = useCallback((v: boolean) => setEditing(v), []);
  const setEditTextLocal = useCallback((v: string) => setEditText(v), []);
  useEffect(() => {
    setEditingLocal(false);
    setEditTextLocal(asset?.caption || "");
  }, [asset, setEditingLocal, setEditTextLocal]);

  if (!asset) return null;

  if (isMobile) {
    return (
      <MobileViewer
        characterId={characterId}
        asset={asset}
        hasPrev={assets.length > 1}
        hasNext={assets.length > 1}
        onPrev={() => onIndexChange((index - 1 + assets.length) % assets.length)}
        onNext={() => onIndexChange((index + 1) % assets.length)}
        onClose={onClose}
        editing={editing}
        editText={editText}
        setEditing={setEditing}
        setEditText={setEditText}
      />
    );
  }

  return (
    <DesktopFloatingViewer
      characterId={characterId}
      asset={asset}
      hasPrev={assets.length > 1}
      hasNext={assets.length > 1}
      onPrev={() => onIndexChange((index - 1 + assets.length) % assets.length)}
      onNext={() => onIndexChange((index + 1) % assets.length)}
      onClose={onClose}
      editing={editing}
      editText={editText}
      setEditing={setEditing}
      setEditText={setEditText}
    />
  );
}

// ─── Caption editing (shared) ────────────────────────────────────────────

function useCaptionEdit(characterId: string, asset: CharacterAsset) {
  const updateCaption = useGalleryStore((s) => s.updateCaption);
  return useCallback(
    async (text: string) => {
      await updateCaption(characterId, asset.id as string, text);
    },
    [characterId, asset.id, updateCaption],
  );
}

// ─── Desktop: draggable floating window (D4) ─────────────────────────────

function DesktopFloatingViewer({
  characterId,
  asset,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  editing,
  editText,
  setEditing,
  setEditText,
}: {
  characterId: string;
  asset: CharacterAsset;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  editing: boolean;
  editText: string;
  setEditing: (v: boolean) => void;
  setEditText: (v: string) => void;
}) {
  const { t } = useT();
  const saveCaption = useCaptionEdit(characterId, asset);

  const [pos, setPos] = useState(() => getAttachedPosition());
  const [zoom, setZoom] = useState(1);
  const [isReady, setIsReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const attachedRef = useRef(true);
  const wheelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const targetZoomRef = useRef(1);
  const fitZoomRef = useRef(1);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const zoomRafRef = useRef<number | null>(null);

  const clampFramePos = useCallback((next: { x: number; y: number }) => {
    const rect = frameRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 420;
    const height = rect?.height ?? 420;
    return {
      x: clamp(next.x, -width + 72, window.innerWidth - 48),
      y: clamp(next.y, -height + 72, window.innerHeight - Math.min(48, height)),
    };
  }, []);

  const setZoomInstant = useCallback((next: number) => {
    const resolved = Math.max(MIN_ZOOM, next);
    if (zoomRafRef.current !== null) {
      window.cancelAnimationFrame(zoomRafRef.current);
      zoomRafRef.current = null;
    }
    zoomRef.current = resolved;
    targetZoomRef.current = resolved;
    setZoom(resolved);
  }, []);

  const animateZoom = useCallback(function tick() {
    const diff = targetZoomRef.current - zoomRef.current;
    if (Math.abs(diff) < 0.001) {
      zoomRef.current = targetZoomRef.current;
      setZoom(targetZoomRef.current);
      zoomRafRef.current = null;
      return;
    }
    zoomRef.current += diff * 0.16;
    setZoom(zoomRef.current);
    zoomRafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const setTargetZoom = useCallback((next: number) => {
    targetZoomRef.current = Math.max(MIN_ZOOM, next);
    if (zoomRafRef.current === null) {
      zoomRafRef.current = window.requestAnimationFrame(animateZoom);
    }
  }, [animateZoom]);

  const recomputeAttached = useCallback(() => {
    const size = naturalSizeRef.current;
    if (size) {
      const fitZoom = getFitZoom(size.width, size.height);
      fitZoomRef.current = fitZoom;
      setZoomInstant(fitZoom);
    }
    setPos(clampFramePos(getAttachedPosition()));
  }, [clampFramePos, setZoomInstant]);

  // Keyboard: Escape closes, arrows navigate (unless editing caption).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (editing) return;
      if (event.key === "ArrowRight" && hasNext) onNext();
      else if (event.key === "ArrowLeft" && hasPrev) onPrev();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNext, onPrev, hasNext, hasPrev, editing]);

  useEffect(() => () => {
    if (zoomRafRef.current !== null) window.cancelAnimationFrame(zoomRafRef.current);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (attachedRef.current) recomputeAttached();
      else setPos((current) => clampFramePos(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampFramePos, recomputeAttached]);

  // Wheel-zoom on the image area only (non-passive to allow preventDefault).
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTargetZoom(targetZoomRef.current * (1 - event.deltaY * 0.0011));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setTargetZoom]);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Don't begin a window drag from the chrome controls / caption editor.
    const target = event.target as HTMLElement;
    if (target.closest("[data-no-drag]")) return;
    event.preventDefault();
    attachedRef.current = false;
    dragging.current = true;
    setIsDragging(true);
    dragStart.current = { x: event.clientX - pos.x, y: event.clientY - pos.y };
  };

  const onMouseMove = useCallback((event: MouseEvent) => {
    if (!dragging.current) return;
    setPos(clampFramePos({ x: event.clientX - dragStart.current.x, y: event.clientY - dragStart.current.y }));
  }, [clampFramePos]);

  const onMouseUp = useCallback(() => {
    dragging.current = false;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const toggleFit = () => {
    const fit = fitZoomRef.current;
    setTargetZoom(Math.abs(targetZoomRef.current - 1) < 0.04 ? fit : 1);
  };

  const handleSaveCaption = useCallback(async () => {
    await saveCaption(editText);
    setEditing(false);
  }, [saveCaption, editText, setEditing]);

  const handleKeyDownCaption = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSaveCaption();
    }
  };

  return (
    <div
      ref={(el) => { frameRef.current = el; }}
      className={[
        "group fixed z-[600] flex w-[min(560px,86vw)] select-none flex-col overflow-visible rounded-md border border-border2/70 bg-surface/95 shadow-[0_10px_35px_rgba(0,0,0,0.45)] opacity-0 backdrop-blur transition-opacity duration-150",
        isReady && "opacity-100",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      ].join(" ")}
      style={{ left: pos.x, top: pos.y, pointerEvents: isReady ? "auto" : "none" }}
      onMouseDown={onMouseDown}
      onDoubleClick={toggleFit}
      title={t("drag_scroll_zoom")}
    >
      {/* Image area (wheel-zoom target). Only the image is scaled — chrome stays readable. */}
      <div ref={wheelRef} className="relative flex max-h-[60vh] items-center justify-center overflow-hidden rounded-t-md bg-black/40 p-2">
        <img
          src={serveCharacterAssetUrl(characterId, asset.id as string)}
          alt={asset.caption || "Gallery image"}
          className="max-h-[60vh] max-w-full origin-center rounded object-contain [-webkit-user-drag:none]"
          style={{ transform: `scale(${zoom})`, transition: isDragging ? "none" : "transform 0.05s linear" }}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            naturalSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight };
            if (attachedRef.current) recomputeAttached();
            requestAnimationFrame(() => setIsReady(true));
          }}
        />

        {/* nav buttons overlaid on the image */}
        {hasPrev && (
          <button type="button" data-no-drag
            className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
            onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPrev(); }}
          >
            <Icons.Caret direction="l" className="h-4 w-4" />
          </button>
        )}
        {hasNext && (
          <button type="button" data-no-drag
            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
            onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onNext(); }}
          >
            <Icons.Caret direction="r" className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Chrome bar: caption (editable) + description (read-only) + close. */}
      <div data-no-drag className="flex flex-col gap-1.5 border-t border-border p-2.5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          {editing ? (
            <div className="flex w-full flex-col gap-1.5">
              <AutoTextarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleKeyDownCaption}
                className="w-full rounded bg-s2 px-2 py-1.5 text-sm text-t1 outline-none ring-1 ring-border focus:ring-accent"
                style={{}} maxHeight={160}
                placeholder={t("caption_placeholder")} autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <button type="button" className="cursor-pointer rounded bg-s2 px-2.5 py-1 text-xs text-t2 hover:bg-s3" onClick={() => setEditing(false)}>{t("cancel")}</button>
                <button type="button" className="cursor-pointer rounded bg-accent px-2.5 py-1 text-xs text-on-accent hover:bg-accent/80" onClick={() => { void handleSaveCaption(); }}>{t("save")}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 text-left text-sm text-t1 hover:bg-s2" onClick={() => { setEditText(asset.caption || ""); setEditing(true); }}>
              <span className="truncate">{asset.caption || <span className="italic text-t3">{t("gallery_no_caption")}</span>}</span>
              <Icons.edit className="h-3 w-3 shrink-0 text-t3" />
            </button>
          )}

          <div className="flex items-center gap-1">
            {asset.description && !editing && (
              <CustomTooltip content={t("gallery_described_badge")}>
                <span className="rounded-full bg-accent-dim px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent-t">{t("gallery_described_badge")}</span>
              </CustomTooltip>
            )}
            <CustomTooltip content={t("close")}>
              <button type="button" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-t3 hover:bg-s2 hover:text-t1" onClick={onClose}>
                <Icons.Close className="h-4 w-4" />
              </button>
            </CustomTooltip>
          </div>
        </div>

        {asset.description && !editing && (
          <p className="max-h-24 overflow-y-auto rounded bg-s2/60 px-2 py-1.5 text-xs leading-relaxed text-t2">{asset.description}</p>
        )}
      </div>
    </div>
  );
}

// ─── Mobile: fullscreen lightbox (pinch-zoom) + chrome ───────────────────

function MobileViewer({
  characterId,
  asset,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  editing,
  editText,
  setEditing,
  setEditText,
}: {
  characterId: string;
  asset: CharacterAsset;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  editing: boolean;
  editText: string;
  setEditing: (v: boolean) => void;
  setEditText: (v: string) => void;
}) {
  const { t } = useT();
  const saveCaption = useCaptionEdit(characterId, asset);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter.current = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ratio = dist / lastTouchDist.current;
      lastTouchDist.current = dist;
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setScale((prev) => clamp(prev * ratio, 0.5, 5));
      if (lastTouchCenter.current) {
        setTranslate((prev) => ({ x: prev.x + (centerX - lastTouchCenter.current!.x), y: prev.y + (centerY - lastTouchCenter.current!.y) }));
      }
      lastTouchCenter.current = { x: centerX, y: centerY };
    }
  }, []);

  const handleTouchEnd = useCallback(() => { lastTouchDist.current = null; lastTouchCenter.current = null; }, []);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setScale((prev) => { setTranslate({ x: 0, y: 0 }); return Math.abs(prev - 1) < 0.1 ? 2.5 : 1; });
    }
    lastTapRef.current = now;
  }, []);

  const handleSaveCaption = useCallback(async () => { await saveCaption(editText); setEditing(false); }, [saveCaption, editText, setEditing]);

  return (
    <div className="fixed inset-0 z-[600] flex flex-col bg-black/95" onClick={(e) => { if (!editing) { e.stopPropagation(); onClose(); } }}>
      <div className="flex items-center justify-between p-2" onClick={(e) => e.stopPropagation()}>
        {hasPrev ? (
          <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white" onClick={(e) => { e.stopPropagation(); onPrev(); }}><Icons.Caret direction="l" className="h-5 w-5" /></button>
        ) : <span className="w-10" />}
        <span className="truncate px-2 text-sm text-white/80">{asset.caption || t("gallery_no_caption")}</span>
        <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white" onClick={(e) => { e.stopPropagation(); onClose(); }}><Icons.Close className="h-5 w-5" /></button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden"
        onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
        <img
          src={serveCharacterAssetUrl(characterId, asset.id as string)}
          alt={asset.caption || "Gallery image"}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `scale(${scale}) translate(${translate.x}px, ${translate.y}px)`, transition: lastTouchDist.current !== null ? "none" : "transform 0.15s ease-out" }}
          draggable={false}
          onClick={(e) => { e.stopPropagation(); handleTap(); }}
        />
        {hasNext && (
          <button type="button" className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white" onClick={(e) => { e.stopPropagation(); onNext(); }}><Icons.Caret direction="r" className="h-5 w-5" /></button>
        )}
      </div>

      <div className="max-h-[30vh] overflow-y-auto p-3" onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <div className="flex flex-col gap-2">
            <AutoTextarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full rounded bg-white/10 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/20 focus:ring-accent" style={{}} maxHeight={160} placeholder={t("caption_placeholder")} autoFocus />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70" onClick={() => setEditing(false)}>{t("cancel")}</button>
              <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent" onClick={() => { void handleSaveCaption(); }}>{t("save")}</button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="mb-1 flex items-center gap-1.5 text-sm text-white/90" onClick={() => { setEditText(asset.caption || ""); setEditing(true); }}>
              <Icons.edit className="h-3 w-3" />{asset.caption || t("add_caption")}
            </button>
            {asset.description && <p className="rounded-lg bg-white/10 px-3 py-2 text-sm leading-relaxed text-white/80">{asset.description}</p>}
          </>
        )}
      </div>
    </div>
  );
}
