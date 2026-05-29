import { useEffect, useRef, useState, useCallback } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { Icons } from '../shared/icons.js';
import { useT } from '../../i18n/context.js';
import { CustomTooltip } from '../shared/Tooltip.js';
import { useIsMobile } from '../../hooks/use-mobile.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
}

const TOPBAR_HEIGHT = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sw').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 248;
}

export function AvatarPanel({ src, onClose }: AvatarPanelProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileLightbox src={src} onClose={onClose} t={t} />;
  }

  return <DesktopPanel src={src} onClose={onClose} t={t} />;
}

/* ── Desktop: floating draggable panel with zoom-to-cursor ── */

function DesktopPanel({ src, onClose, t }: { src: string; onClose: () => void; t: (k: string) => string }) {
  const [pos, setPos] = useState(() => ({
    x: getSidebarWidth() + 22,
    y: TOPBAR_HEIGHT + 16,
  }));
  const [isReady, setIsReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Drag — move the floating panel
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    setIsDragging(true);
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const el = panelRef.current;
      const w = el?.offsetWidth ?? 360;
      const h = el?.offsetHeight ?? 480;
      setPos({
        x: clamp(e.clientX - dragStart.current.x, -w + 72, window.innerWidth - 48),
        y: clamp(e.clientY - dragStart.current.y, -h + 72, window.innerHeight - 48),
      });
    };
    const onUp = () => { dragging.current = false; setIsDragging(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Reposition on resize
  useEffect(() => {
    const onResize = () => {
      setPos((cur) => ({
        x: clamp(cur.x, -200, window.innerWidth - 48),
        y: clamp(cur.y, -200, window.innerHeight - 48),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Drag handle — top bar area only, so panning inside TransformComponent still works
  return (
    <div
      ref={panelRef}
      className={[
        'group fixed z-[600] inline-block select-none overflow-hidden rounded-md border border-border2/70 bg-bg/30',
        'shadow-[0_10px_35px_rgba(0,0,0,0.35)] opacity-0 transition-opacity duration-150',
        isReady && 'opacity-100',
      ].join(' ')}
      style={{ left: pos.x, top: pos.y, pointerEvents: isReady ? 'auto' : 'none' }}
    >
      {/* Drag handle — only the border area at the top */}
      <div
        className="flex h-5 cursor-grab items-center justify-between px-1 active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <span className="text-[9px] text-t4">{t('drag_scroll_zoom')}</span>
      </div>

      <TransformWrapper
        initialScale={1}
        minScale={0.2}
        maxScale={8}
        wheel={{ step: 0.08 }}
        doubleClick={{ step: 0.7, mode: 'toggle' }}
        panning={{ disabled: false }}
      >
        {({ resetTransform }) => (
          <>
            <TransformComponent
              wrapperStyle={{ width: 'auto', height: 'auto', overflow: 'hidden' }}
              contentClass="!flex !items-center !justify-center"
            >
              <img
                src={src}
                className="block max-h-[70vh] max-w-[420px] select-none rounded-b-md [-webkit-user-drag:none]"
                draggable={false}
                alt={t('character_avatar_alt')}
                onLoad={() => requestAnimationFrame(() => setIsReady(true))}
              />
            </TransformComponent>

            {/* Close button */}
            <CustomTooltip content={t('close')}>
              <button type="button"
                className="absolute right-2 top-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow transition-opacity duration-150 hover:bg-black/75 group-hover:opacity-100 [&_svg]:h-3.5 [&_svg]:w-3.5"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
              >
                <Icons.close />
              </button>
            </CustomTooltip>

            {/* Reset zoom button */}
            <button type="button"
              className="absolute bottom-2 right-2 flex h-7 cursor-pointer items-center justify-center rounded bg-black/55 px-1.5 text-[10px] text-white opacity-0 hover:bg-black/75 group-hover:opacity-100"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); resetTransform(); }}
            >1:1</button>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

/* ── Mobile: fullscreen lightbox with pinch-to-zoom ── */

function MobileLightbox({ src, onClose, t }: { src: string; onClose: () => void; t: (k: string) => string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[600] bg-black/95">
      {/* Close button */}
      <button type="button"
        className="absolute right-3 top-3 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white active:bg-black/75"
        onClick={onClose}
      >
        <Icons.close />
      </button>

      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={5}
        wheel={{ disabled: true }}
        doubleClick={{ step: 0.7, mode: 'toggle' }}
        panning={{ disabled: false }}
        centerOnInit
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentClass="!flex !items-center !justify-center"
        >
          <img
            src={src}
            alt={t('character_avatar_alt')}
            className="max-h-[90vh] max-w-full select-none object-contain"
            draggable={false}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}
