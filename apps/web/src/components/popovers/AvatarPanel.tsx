import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icons } from '../shared/icons.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
  t?: (key: string) => string;
}

export function AvatarPanel({ src, onClose, t = (k) => k }: AvatarPanelProps) {
  const [pos, setPos] = useState({ x: window.innerWidth - 360, y: 80 });
  const [scale, setScale] = useState(1);
  const dragging = useRef(false);
  const dragStart = useRef({ x:0, y:0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale(s => Math.max(0.3, Math.min(4, s * (1 - e.deltaY * 0.001))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onMD = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };
  const onMM = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    setPos({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, []);
  const onMU = () => { dragging.current = false; };

  useEffect(() => {
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
    return () => { window.removeEventListener('mousemove', onMM); window.removeEventListener('mouseup', onMU); };
  }, [onMM]);

  return (
    <div ref={ref} className="fixed z-[100] select-none group" style={{ left: pos.x, top: pos.y }}>
      <img src={src} className="block w-[320px] max-w-[320px] cursor-grab rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.45)] [-webkit-user-drag:none] active:cursor-grabbing"
        style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
        onMouseDown={onMD}
        draggable={false}
      />
      <div className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100" onClick={onClose}><Icons.close/></div>
      <div className="pointer-events-none absolute bottom-[-20px] left-0 right-0 whitespace-nowrap text-center text-[calc(var(--ui-fs)-3px)] text-t3 opacity-0 transition-opacity duration-150 group-hover:opacity-100">{t("drag_scroll_zoom")}</div>
    </div>
  );
}
