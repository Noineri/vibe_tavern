import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyDown } from '../../../hooks/use-key-down.js';
import { Icons } from '../../shared/icons.js';
import { useT } from '../../../i18n/context.js';
import { CustomTooltip } from '../../shared/Tooltip.js';
import { useIsMobile } from '../../../hooks/use-mobile.js';
import {
  useImageZoomPan,
  clamp,
  MIN_ZOOM,
  TOPBAR_HEIGHT,
  getSidebarWidth,
  getAttachedPosition,
} from '../../../hooks/use-image-zoom-pan.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
}

function getFitZoom(naturalWidth: number, naturalHeight: number): number {
  const maxVisualWidth = Math.min(380, Math.max(260, window.innerWidth - getSidebarWidth() - 56));
  const maxVisualHeight = Math.min(560, Math.max(260, window.innerHeight - TOPBAR_HEIGHT - 44));
  return Math.min(1, maxVisualWidth / naturalWidth, maxVisualHeight / naturalHeight);
}

export function AvatarPanel({ src, onClose }: AvatarPanelProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileLightbox src={src} onClose={onClose} />;
  }

  return <DesktopAvatarPanel src={src} onClose={onClose} />;
}

// ── Desktop: draggable floating panel ──

function DesktopAvatarPanel({ src, onClose }: AvatarPanelProps) {
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
    const width = rect?.width ?? 360;
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

  useKeyDown("Escape", onClose);

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

  // Non-passive wheel listener to allow preventDefault (zoom)
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTargetZoom(targetZoomRef.current * (1 - event.deltaY * 0.0011));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
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
      ref={(el) => { frameRef.current = el; wheelRef.current = el; }}
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

function MobileLightbox({ src, onClose }: AvatarPanelProps) {
  const { t } = useT();
  const { scale, translate, isPinching, touchHandlers, handleTap } = useImageZoomPan();
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape key
  useKeyDown("Escape", onClose);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/95"
      onClick={onClose}
      onTouchStart={touchHandlers.onTouchStart}
      onTouchMove={touchHandlers.onTouchMove}
      onTouchEnd={touchHandlers.onTouchEnd}
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
          transform: `scale(${scale}) translate(${translate.x}px, ${translate.y}px)`,
          transition: isPinching ? "none" : "transform 0.15s ease-out",
        }}
        draggable={false}
        onClick={(e) => { e.stopPropagation(); handleTap(); }}
      />
    </div>
  );
}
