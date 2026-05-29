import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../shared/icons.js';
import { useT } from '../../i18n/context.js';
import { CustomTooltip } from '../shared/Tooltip.js';
import { useIsMobile } from '../../hooks/use-mobile.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
}

const MIN_ZOOM = 0.2;
const TOPBAR_HEIGHT = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sw').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 248;
}

function getAttachedPosition(): { x: number; y: number } {
  return {
    x: getSidebarWidth() + 22,
    y: TOPBAR_HEIGHT + 16,
  };
}

function getFitZoom(naturalWidth: number, naturalHeight: number): number {
  const maxVisualWidth = Math.min(380, Math.max(260, window.innerWidth - getSidebarWidth() - 56));
  const maxVisualHeight = Math.min(560, Math.max(260, window.innerHeight - TOPBAR_HEIGHT - 44));
  return Math.min(1, maxVisualWidth / naturalWidth, maxVisualHeight / naturalHeight);
}

export function AvatarPanel({ src, onClose }: AvatarPanelProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  // ── Mobile: fullscreen lightbox with pinch-to-zoom ──
  if (isMobile) {
    return <MobileLightbox src={src} onClose={onClose} t={t} />;
  }

  // ── Desktop: draggable floating panel ──
  const [pos, setPos] = useState(() => getAttachedPosition());
  const [zoom, setZoom] = useState(1);
  const [isReady, setIsReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const attachedRef = useRef(true);
  const dragStart = useRef({ x: 0, y: 0 });
  const frameRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const targetZoomRef = useRef(1);
  const fitZoomRef = useRef(1);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const zoomRafRef = useRef<number | null>(null);

  const clampFramePos = useCallback((next: { x: number; y: number }) => {
    const rect = frameRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 360;
    const height = rect?.height ?? 480;
    return {
      x: clamp(next.x, -width + 72, window.innerWidth - 48),
      y: clamp(next.y, 8, window.innerHeight - Math.min(48, height)),
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (zoomRafRef.current !== null) {
        window.cancelAnimationFrame(zoomRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (attachedRef.current) {
        recomputeAttached();
      } else {
        setPos((current) => clampFramePos(current));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampFramePos, recomputeAttached]);

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

  const onMouseUp = useCallback(() => {
    dragging.current = false;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const toggleFit = () => {
    const fit = fitZoomRef.current;
    setTargetZoom(Math.abs(targetZoomRef.current - 1) < 0.04 ? fit : 1);
  };

  return (
    <div
      ref={frameRef}
      className={[
        'group fixed z-[600] inline-block select-none overflow-visible rounded-md border border-border2/70 bg-bg/30 shadow-[0_10px_35px_rgba(0,0,0,0.35)] opacity-0 transition-opacity duration-150 will-change-transform',
        isReady && 'opacity-100',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      ].join(' ')}
      style={{
        left: pos.x,
        top: pos.y,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        pointerEvents: isReady ? 'auto' : 'none',
      }}
      onMouseDown={onMouseDown}
      onDoubleClick={toggleFit}
      onWheel={(event) => {
        event.preventDefault();
        setTargetZoom(targetZoomRef.current * (1 - event.deltaY * 0.0011));
      }}
      title={t('drag_scroll_zoom')}
    >
      <img
        src={src}
        className="block h-auto w-auto max-w-none rounded-[5px] object-contain [-webkit-user-drag:none]"
        draggable={false}
        alt={t('character_avatar_alt')}
        onLoad={(event) => {
          const img = event.currentTarget;
          naturalSizeRef.current = { width: img.naturalWidth, height: img.naturalHeight };
          if (attachedRef.current) recomputeAttached();
          requestAnimationFrame(() => setIsReady(true));
        }}
      />
      <CustomTooltip content={t('close')}>
      <button type="button"
        className="absolute right-2 top-2 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow transition-opacity duration-150 hover:bg-black/75 group-hover:opacity-100 [&_svg]:h-4 [&_svg]:w-4"
        style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top right' }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onClose}
      >
        <Icons.close />
      </button>
      </CustomTooltip>
    </div>
  );
}

// ── Mobile fullscreen lightbox with pinch-to-zoom ──

interface MobileLightboxProps {
  src: string;
  onClose: () => void;
  t: (key: string) => string;
}

function MobileLightbox({ src, onClose, t }: MobileLightboxProps) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pinch-to-zoom touch handlers
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

  // Double-tap toggle
  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      // Double tap
      setScale((prev) => {
        if (Math.abs(prev - 1) < 0.1) {
          setTranslate({ x: 0, y: 0 });
          return 2.5;
        }
        setTranslate({ x: 0, y: 0 });
        return 1;
      });
    }
    lastTapRef.current = now;
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/95"
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Close button */}
      <button type="button"
        className="absolute right-3 top-3 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white active:bg-black/75"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >
        <Icons.close />
      </button>

      {/* Image */}
      <img
        src={src}
        alt={t("character_avatar_alt")}
        className="max-h-full max-w-full object-contain select-none"
        style={{
          transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
          transition: lastTouchDist.current !== null ? "none" : "transform 0.15s ease-out",
        }}
        draggable={false}
        onClick={(e) => { e.stopPropagation(); handleTap(); }}
      />
    </div>
  );
}
