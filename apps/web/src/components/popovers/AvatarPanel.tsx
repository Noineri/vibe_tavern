import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../shared/icons.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
  t?: (key: string) => string;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.75;
const ZOOM_STEP = 0.15;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AvatarPanel({ src, onClose, t = (k) => k }: AvatarPanelProps) {
  const [pos, setPos] = useState(() => ({ x: Math.max(16, window.innerWidth - 460), y: 76 }));
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const clampPanelPos = useCallback((next: { x: number; y: number }) => {
    const rect = panelRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 420;
    const height = rect?.height ?? 560;
    return {
      x: clamp(next.x, -width + 96, window.innerWidth - 72),
      y: clamp(next.y, 8, window.innerHeight - Math.min(72, height)),
    };
  }, []);

  const setZoomClamped = useCallback((next: number | ((current: number) => number)) => {
    setZoom((current) => clamp(typeof next === 'function' ? next(current) : next, MIN_ZOOM, MAX_ZOOM));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const onResize = () => setPos((current) => clampPanelPos(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPanelPos]);

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging.current = true;
    setIsDragging(true);
    dragStart.current = { x: event.clientX - pos.x, y: event.clientY - pos.y };
  };

  const onMouseMove = useCallback((event: MouseEvent) => {
    if (!dragging.current) return;
    setPos(clampPanelPos({ x: event.clientX - dragStart.current.x, y: event.clientY - dragStart.current.y }));
  }, [clampPanelPos]);

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

  const stopDrag = (event: React.MouseEvent) => event.stopPropagation();
  const reset = () => { setZoom(1); setPos({ x: Math.max(16, window.innerWidth - 460), y: 76 }); };
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div
      ref={panelRef}
      className={[
        'fixed z-[600] overflow-hidden rounded-xl border border-border2 bg-surface text-t2 shadow-[0_18px_50px_rgba(0,0,0,0.45)] select-none',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      ].join(' ')}
      style={{ left: pos.x, top: pos.y, width: 'min(420px, calc(100vw - 32px))' }}
      onMouseDown={onMouseDown}
      onDoubleClick={reset}
      title={t('drag_scroll_zoom')}
    >
      <div className="flex items-center justify-between border-b border-border bg-surface/95" style={{ padding: '8px 10px' }}>
        <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.07em] text-t3">
          Avatar
        </div>
        <button
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1"
          onMouseDown={stopDrag}
          onClick={onClose}
          title="Close"
        >
          <Icons.close />
        </button>
      </div>

      <div
        className="relative flex h-[min(620px,calc(100vh-170px))] items-center justify-center overflow-hidden bg-bg"
        onWheel={(event) => {
          event.preventDefault();
          setZoomClamped((current) => current * (1 - event.deltaY * 0.001));
        }}
      >
        <img
          src={src}
          className="block max-h-full max-w-full object-contain transition-transform duration-100 ease-out will-change-transform [-webkit-user-drag:none]"
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
          alt="Character avatar"
        />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-surface/95" style={{ padding: '8px 10px' }}>
        <div className="flex items-center gap-1.5" onMouseDown={stopDrag}>
          <button
            className="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoomClamped((current) => current - ZOOM_STEP)}
            title="Zoom out"
          >−</button>
          <div className="min-w-[54px] text-center text-[calc(var(--ui-fs)-3px)] tabular-nums text-t2">{zoomPercent}%</div>
          <button
            className="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoomClamped((current) => current + ZOOM_STEP)}
            title="Zoom in"
          >+</button>
        </div>
        <div className="flex items-center gap-1.5" onMouseDown={stopDrag}>
          <button
            className="h-7 cursor-pointer rounded-md text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1"
            style={{ padding: '0 9px' }}
            onClick={() => setZoom(1)}
            title="Actual size"
          >1:1</button>
          <button
            className="h-7 cursor-pointer rounded-md text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t1"
            style={{ padding: '0 9px' }}
            onClick={reset}
            title="Reset position and zoom"
          >Reset</button>
        </div>
      </div>
    </div>
  );
}
