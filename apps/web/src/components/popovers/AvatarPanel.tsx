import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../shared/icons.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
  t?: (key: string) => string;
}

const MIN_ZOOM = 0.2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AvatarPanel({ src, onClose, t = (k) => k }: AvatarPanelProps) {
  const [pos, setPos] = useState(() => ({ x: Math.max(16, window.innerWidth - 400), y: 76 }));
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const frameRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const targetZoomRef = useRef(1);
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
    const onResize = () => setPos((current) => clampFramePos(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampFramePos]);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
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

  return (
    <div
      ref={frameRef}
      className={[
        'group fixed z-[600] inline-block select-none overflow-visible rounded-md border border-border2/70 bg-bg/30 shadow-[0_10px_35px_rgba(0,0,0,0.35)] will-change-transform',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      ].join(' ')}
      style={{
        left: pos.x,
        top: pos.y,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}
      onMouseDown={onMouseDown}
      onDoubleClick={() => setTargetZoom(1)}
      onWheel={(event) => {
        event.preventDefault();
        setTargetZoom(targetZoomRef.current * (1 - event.deltaY * 0.0011));
      }}
      title={t('drag_scroll_zoom')}
    >
      <img
        src={src}
        className="block h-auto w-auto max-h-[min(720px,78vh)] max-w-[min(420px,80vw)] rounded-[5px] object-contain [-webkit-user-drag:none]"
        draggable={false}
        alt="Character avatar"
      />
      <button
        className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white opacity-0 shadow transition-opacity duration-150 hover:bg-black/70 group-hover:opacity-100"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onClose}
        title="Close"
      >
        <Icons.close />
      </button>
    </div>
  );
}
