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
import { useCallback, useRef, useState } from "react";
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
  /** Current scale (starts at 1). */
  scale: number;
  /** Current pan offset in px (starts at {0,0}). */
  translate: { x: number; y: number };
  /** True while a two-finger pinch is active (disables the transform transition). */
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
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  // Baseline for single-finger pan (D5b): only active while zoomed in.
  const lastSingleTouch = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<number>(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      lastSingleTouch.current = null;
    } else if (e.touches.length === 1) {
      // Capture the baseline unconditionally; pan ELIGIBILITY is checked at
      // move time against the current scale, and a fresh baseline at scale<=1
      // prevents a jump on the first frame after zooming in.
      lastSingleTouch.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
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
      // D5 (v1.2.1): capture the previous center at QUEUE time. The old updater
      // read `lastTouchCenter.current` at RENDER time, which was wrong twice:
      // (a) if touchEnd ran before the commit, the ref was null and `null!.x`
      // threw during render — with no root ErrorBoundary the whole tree
      // unmounted (blank page on real devices);
      // (b) if a later touchMove had already reassigned the ref, the delta was
      // computed against the NEW center (≈0) and the pinch pan was silently
      // lost. Updaters must be pure over queue-time captured values.
      const prevCenter = lastTouchCenter.current;
      if (prevCenter) {
        setTranslate((prev) => ({
          x: prev.x + (centerX - prevCenter.x),
          y: prev.y + (centerY - prevCenter.y),
        }));
      }
      lastTouchCenter.current = { x: centerX, y: centerY };
    } else if (e.touches.length === 1 && lastSingleTouch.current && scale > 1) {
      // D5b: single-finger pan while zoomed in. Queue-time capture (D5 lesson):
      // the updater must not read refs that a later event may have reassigned.
      const prev = lastSingleTouch.current;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      setTranslate((p) => ({
        x: p.x + (x - prev.x),
        y: p.y + (y - prev.y),
      }));
      lastSingleTouch.current = { x, y };
    } else if (e.touches.length === 1) {
      // Not zoomed in (or baseline lost): keep the baseline fresh so pan
      // starts from the finger's CURRENT position once scale exceeds 1.
      lastSingleTouch.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  }, [scale]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    if (e.touches.length === 1) {
      // Pinch → pan handoff (2→1): re-baseline on the finger that stays down
      // so continuing to drag pans from its current position with no jump.
      lastSingleTouch.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    } else {
      lastSingleTouch.current = null;
    }
  }, []);

  const handleTouchCancel = useCallback((e: React.TouchEvent) => {
    // Same cleanup as end; no handoff baseline — the browser took the gesture
    // away and the next touch will re-baseline at touchStart anyway.
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    lastSingleTouch.current = null;
  }, []);

  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
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

  return {
    scale,
    translate,
    isPinching: lastTouchDist.current !== null,
    touchHandlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
    },
    handleTap,
  };
}
