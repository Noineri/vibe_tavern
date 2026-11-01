/**
 * Pinch-zoom + double-tap + pan hook for fullscreen mobile image lightboxes.
 *
 * Extracted from the near-identical MobileLightbox components in
 * AvatarPanel.tsx and GalleryViewer.tsx (jscpd §2.1 — the repo's largest
 * cross-file clone). The logic is pure state + refs + touch handlers, no JSX,
 * so it factors cleanly into a hook returning bindable handlers.
 *
 * Also re-exports the module-level helpers shared by the desktop floating
 * panels in the same two files (clamp, getSidebarWidth, getAttachedPosition,
 * MIN_ZOOM, TOPBAR_HEIGHT). `getFitZoom` stays per-consumer — the gallery and
 * avatar panels use different max-size budgets.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

// ─── Shared module helpers (used by the desktop floating panels too) ─────

export const MIN_ZOOM = 0.2;
export const TOPBAR_HEIGHT = 60;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sw").trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 248;
}

export function getAttachedPosition(): { x: number; y: number } {
  return { x: getSidebarWidth() + 22, y: TOPBAR_HEIGHT + 16 };
}

// ─── Hook: pinch-zoom + pan + double-tap ─────────────────────────────────

export interface ImageZoomPan {
  containerRef: React.RefObject<HTMLDivElement | null>;
  imageRef: React.RefObject<HTMLImageElement | null>;
  /** The one transform/transition derivation consumed by every lightbox. */
  imageStyle: React.CSSProperties;
  /** Current scale (starts at 1). */
  scale: number;
  /** Current pan offset in px (starts at {0,0}). */
  translate: { x: number; y: number };
  /** True while a two-finger pinch is active. All active touches disable easing. */
  isPinching: boolean;
  /** Spread onto the container element that captures the touches. */
  touchHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    /** Reads `e.touches` (the fingers still down) to re-baseline a pinch→pan
     *  handoff; pass the real React event. */
    onTouchEnd: (e: React.TouchEvent) => void;
    /** Same cleanup as end — native gesture interruption (browser UI takeover)
     *  must not leave stale refs behind. */
    onTouchCancel: (e: React.TouchEvent) => void;
  };
  /** Call on image click — toggles 1↔2.5x on double-tap (≤300ms), resets pan. */
  handleTap: () => void;
}

/**
 * Mobile lightbox zoom/pan/double-tap state. Clamp range mirrors the original
 * AvatarPanel/GalleryViewer behavior (scale 0.5–5, double-tap target 2.5x).
 */
export function useImageZoomPan(): ImageZoomPan {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  // Touch events can arrive before React commits. Every event reads the
  // latest queued transform, never a stale scale from a render closure.
  const transformRef = useRef(transform);
  const [touchCount, setTouchCount] = useState(0);
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const lastSingleTouch = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<number | null>(null);

  const updateTransform = useCallback((next: typeof transform) => {
    const viewport = containerRef.current?.getBoundingClientRect();
    const image = imageRef.current;
    const maxX = next.scale > 1 && viewport && image ? Math.max(0, (image.offsetWidth * next.scale - viewport.width) / 2) : 0;
    const maxY = next.scale > 1 && viewport && image ? Math.max(0, (image.offsetHeight * next.scale - viewport.height) / 2) : 0;
    const bounded = { scale: next.scale, x: maxX === 0 ? 0 : clamp(next.x, -maxX, maxX), y: maxY === 0 ? 0 : clamp(next.y, -maxY, maxY) };
    const previous = transformRef.current;
    if (previous.scale === bounded.scale && previous.x === bounded.x && previous.y === bounded.y) return;
    transformRef.current = bounded;
    setTransform(bounded);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const image = imageRef.current;
    if (!container || !image) return;
    const observer = new ResizeObserver(() => updateTransform(transformRef.current));
    observer.observe(container);
    observer.observe(image);
    return () => observer.disconnect();
  }, [updateTransform]);

  const baseline = useCallback((touches: React.TouchList) => {
    setTouchCount(touches.length);
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    lastSingleTouch.current = null;
    if (touches.length === 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      lastTouchDist.current = Math.hypot(dx, dy);
      lastTouchCenter.current = {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    } else if (touches.length === 1) {
      lastSingleTouch.current = { x: touches[0].clientX, y: touches[0].clientY };
    }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => baseline(e.touches), [baseline]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const previous = transformRef.current;
    if (e.touches.length === 2 && lastTouchDist.current !== null && lastTouchCenter.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.hypot(dx, dy);
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastTouchDist.current > 0 && distance > 0) {
        const scale = clamp(previous.scale * distance / lastTouchDist.current, 0.5, 5);
        const ratio = scale / previous.scale;
        // All consumers center the fitted image in this viewport. Keep the
        // image-space point under the old midpoint under the new midpoint.
        const viewport = containerRef.current?.getBoundingClientRect();
        const originX = viewport ? viewport.left + viewport.width / 2 : 0;
        const originY = viewport ? viewport.top + viewport.height / 2 : 0;
        const oldCenter = lastTouchCenter.current;
        updateTransform({
          scale,
          x: centerX - originX - ratio * (oldCenter.x - originX - previous.x),
          y: centerY - originY - ratio * (oldCenter.y - originY - previous.y),
        });
      }
      lastTouchDist.current = distance;
      lastTouchCenter.current = { x: centerX, y: centerY };
    } else if (e.touches.length === 1 && lastSingleTouch.current) {
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      if (previous.scale > 1) {
        e.preventDefault();
        updateTransform({ ...previous, x: previous.x + x - lastSingleTouch.current.x, y: previous.y + y - lastSingleTouch.current.y });
      }
      lastSingleTouch.current = { x, y };
    }
  }, [updateTransform]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => baseline(e.touches), [baseline]);

  const handleTouchCancel = useCallback((e: React.TouchEvent) => {
    setTouchCount(0);
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    lastSingleTouch.current = null;
  }, []);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (lastTapRef.current !== null && now - lastTapRef.current < 300) {
      updateTransform({ scale: Math.abs(transformRef.current.scale - 1) < 0.1 ? 2.5 : 1, x: 0, y: 0 });
    }
    lastTapRef.current = now;
  }, [updateTransform]);

  return {
    containerRef,
    imageRef,
    imageStyle: {
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      transformOrigin: "center center",
      transition: touchCount > 0 ? "none" : "transform 0.15s ease-out",
    },
    scale: transform.scale,
    translate: { x: transform.x, y: transform.y },
    isPinching: touchCount === 2,
    touchHandlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
    },
    handleTap,
  };
}
