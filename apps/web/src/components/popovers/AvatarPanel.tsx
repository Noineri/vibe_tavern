import { useEffect, useRef, useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { Icons } from '../shared/icons.js';
import { useT } from '../../i18n/context.js';
import { CustomTooltip } from '../shared/Tooltip.js';
import { useIsMobile } from '../../hooks/use-mobile.js';

interface AvatarPanelProps {
  src: string;
  onClose: () => void;
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

const TOPBAR_HEIGHT = 60;

function DesktopPanel({ src, onClose, t }: { src: string; onClose: () => void; t: (k: string) => string }) {
  const [pos, setPos] = useState(() => {
    const sw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sw')) || 248;
    return { x: sw + 22, y: TOPBAR_HEIGHT + 16 };
  });
  const [isReady, setIsReady] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Drag handlers
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const el = panelRef.current;
      const w = el?.offsetWidth ?? 360;
      const h = el?.offsetHeight ?? 480;
      setPos({
        x: Math.max(-w + 72, Math.min(e.clientX - dragStart.current.x, window.innerWidth - 48)),
        y: Math.max(-h + 72, Math.min(e.clientY - dragStart.current.y, window.innerHeight - 48)),
      });
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  return (
    <div
      ref={panelRef}
      className={[
        'group fixed z-[600] select-none overflow-visible rounded-md border border-border2/70 bg-bg/30',
        'shadow-[0_10px_35px_rgba(0,0,0,0.35)] opacity-0 transition-opacity duration-150',
        isReady && 'opacity-100',
        dragging.current ? 'cursor-grabbing' : 'cursor-grab',
      ].join(' ')}
      style={{ left: pos.x, top: pos.y, pointerEvents: isReady ? 'auto' : 'none' }}
      onMouseDown={onMouseDown}
    >
      <TransformWrapper
        initialScale={1}
        minScale={0.2}
        maxScale={5}
        wheel={{ step: 0.08 }}
        doubleClick={{ step: 0.7 }}
        panning={{ disabled: false }}
      >
        {({ zoomIn, zoomOut, resetTransform, state }) => (
          <>
            <TransformComponent
              wrapperStyle={{ borderRadius: 6, overflow: 'hidden' }}
              contentStyle={{ pointerEvents: 'auto' }}
            >
              <img
                src={src}
                className="block max-w-none select-none [-webkit-user-drag:none]"
                draggable={false}
                alt={t('character_avatar_alt')}
                onLoad={() => requestAnimationFrame(() => setIsReady(true))}
              />
            </TransformComponent>

            {/* Close button */}
            <CustomTooltip content={t('close')}>
              <button type="button"
                className="absolute right-2 top-2 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow transition-opacity duration-150 hover:bg-black/75 group-hover:opacity-100 [&_svg]:h-4 [&_svg]:w-4"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
              >
                <Icons.close />
              </button>
            </CustomTooltip>

            {/* Zoom controls */}
            <div className="absolute bottom-2 left-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button type="button"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded bg-black/55 text-white hover:bg-black/75"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); zoomOut(); }}
              >−</button>
              <button type="button"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded bg-black/55 text-[11px] text-white hover:bg-black/75"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); resetTransform(); }}
              >1:1</button>
              <button type="button"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded bg-black/55 text-white hover:bg-black/75"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); zoomIn(); }}
              >+</button>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}

/* ── Mobile: fullscreen lightbox with pinch-to-zoom ── */

function MobileLightbox({ src, onClose, t }: { src: string; onClose: () => void; t: (k: string) => string }) {
  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/95">
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
        doubleClick={{ step: 0.7 }}
        panning={{ disabled: false }}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentStyle={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
