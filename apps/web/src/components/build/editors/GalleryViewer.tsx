import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

interface GalleryViewerProps {
  characterId: string;
  asset: CharacterAsset;
  onClose: () => void;
}

/**
 * Floating frameless image viewer — one per open gallery tile (multiple may be
 * on screen at once). A direct copy of the AvatarPanel floating-window pattern:
 * bare image (no border/background), whole-frame zoom via CSS transform,
 * attached next to the sidebar, drag to move, wheel to zoom, double-click to
 * fit/100%, mobile pinch-zoom. This is the "quick inspect" surface; the fuller
 * description-edit experience lives in GalleryLightbox.
 */
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

function getAttachedPosition(): { x: number; y: number } {
  return { x: getSidebarWidth() + 22, y: TOPBAR_HEIGHT + 16 };
}

function getFitZoom(naturalWidth: number, naturalHeight: number): number {
  const maxVisualWidth = Math.min(560, Math.max(300, window.innerWidth - getSidebarWidth() - 56));
  const maxVisualHeight = Math.min(640, Math.max(300, window.innerHeight - TOPBAR_HEIGHT - 56));
  return Math.min(1, maxVisualWidth / naturalWidth, maxVisualHeight / naturalHeight);
}

export function GalleryViewer({ characterId, asset, onClose }: GalleryViewerProps) {
  const isMobile = useIsMobile();
  const src = serveCharacterAssetUrl(characterId, asset.id as string);
  const alt = asset.caption || "Gallery image";

  if (isMobile) {
    return <MobileLightbox src={src} alt={alt} onClose={onClose} />;
  }
  return <DesktopGalleryPanel src={src} alt={alt} onClose={onClose} />;
}

// ── Desktop: draggable floating panel (copy of AvatarPanel's DesktopAvatarPanel) ──

function DesktopGalleryPanel({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [pos, setPos] = useState(() => getAttachedPosition());
  const [zoom, setZoom] = useState(1);
  const [isReady, setIsReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const attachedRef = useRef(true);
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const frameRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const targetZoomRef = useRef(1);
  const fitZoomRef = useRef(1);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const zoomRafRef = useRef<number | null>(null);

  const clampFramePos = useCallback((next: { x: number; y: number }) => {
    const rect = frameRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 420;
    const height = rect?.height ?? 480;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    return () => { if (zoomRafRef.current !== null) window.cancelAnimationFrame(zoomRafRef.current); };
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (attachedRef.current) recomputeAttached();
      else setPos((current) => clampFramePos(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampFramePos, recomputeAttached]);

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

  const onMouseUp = useCallback(() => { dragging.current = false; setIsDragging(false); }, []);

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

  // Counter-scale the overlay button so it stays a fixed size regardless of
  // the panel's frame zoom (the whole frame is scaled via transform).
  const closeBtnStyle: React.CSSProperties = {
    transform: `scale(${1 / zoom})`,
    transformOrigin: "top right",
  };

  return (
    <div
      ref={(el) => { frameRef.current = el; wheelRef.current = el; }}
      className={[
        "group fixed z-[600] inline-block select-none overflow-visible rounded-md shadow-[0_10px_35px_rgba(0,0,0,0.35)] opacity-0 transition-opacity duration-150 will-change-transform",
        isReady && "opacity-100",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      ].join(" ")}
      style={{
        left: pos.x,
        top: pos.y,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
        pointerEvents: isReady ? "auto" : "none",
      }}
      onMouseDown={onMouseDown}
      onDoubleClick={toggleFit}
      title={t("drag_scroll_zoom")}
    >
      <img
        src={src}
        className="block h-auto w-auto max-w-none rounded-[5px] object-contain [-webkit-user-drag:none]"
        draggable={false}
        alt={alt}
        onLoad={(event) => {
          const img = event.currentTarget;
          naturalSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight };
          if (attachedRef.current) recomputeAttached();
          requestAnimationFrame(() => setIsReady(true));
        }}
      />

      <CustomTooltip content={t("close")}>
        <button type="button"
          className="absolute right-2 top-2 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow transition-opacity duration-150 hover:bg-black/75 group-hover:opacity-100 [&_svg]:h-4 [&_svg]:w-4"
          style={closeBtnStyle}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <Icons.close />
        </button>
      </CustomTooltip>
    </div>
  );
}

// ── Mobile: fullscreen pinch-zoom lightbox (copy of AvatarPanel's MobileLightbox) ──

function MobileLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<number>(0);

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
      lastTouchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
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
        setTranslate((prev) => ({
          x: prev.x + (centerX - lastTouchCenter.current!.x),
          y: prev.y + (centerY - lastTouchCenter.current!.y),
        }));
      }
      lastTouchCenter.current = { x: centerX, y: centerY };
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
  }, []);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setScale((prev) => {
        if (Math.abs(prev - 1) < 0.1) { setTranslate({ x: 0, y: 0 }); return 2.5; }
        setTranslate({ x: 0, y: 0 });
        return 1;
      });
    }
    lastTapRef.current = now;
  }, []);

  return (
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/95"
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <button type="button"
        className="absolute right-3 top-3 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white active:bg-black/75"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title={t("close")}
      >
        <Icons.close />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full select-none object-contain"
        style={{
          transform: `scale(${scale}) translate(${translate.x}px, ${translate.y}px)`,
          transition: lastTouchDist.current !== null ? "none" : "transform 0.15s ease-out",
        }}
        draggable={false}
        onClick={(e) => { e.stopPropagation(); handleTap(); }}
      />
    </div>
  );
}
