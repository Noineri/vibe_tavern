import { useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Markdown } from "../../../lib/markdown.js";
import { cn } from "../../../lib/cn.js";
import type { SwipeDirection } from "./types.js";
import { getVariantRenderWindow, observeVariantScrollSettle } from "./variant-scroll-snap.js";

export type MobileVariantCarouselHandle = {
  selectVariant: (index: number) => void;
};

type MobileVariantCarouselProps = {
  ref?: Ref<MobileVariantCarouselHandle>;
  selectedVariantIndex: number;
  variants: { id?: string; variantIndex?: number; content: string }[];
  isBusy: boolean;
  /** Image slots keep the same busy exception as VariantControls. */
  swipeWhileBusy?: boolean;
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
  /** IG-CF11 (mobile swipe zone): panel renderer for pure image slots. Their
   *  variant panels carry no text, so the Markdown panels collapsed to ~0
   *  height — the swipe gesture had no surface and phones could only use the
   *  chevrons. When provided, each panel renders this instead of the Markdown
   *  block (position-aligned with `variants`). Neighbor panels are inert:
   *  their images must not open the lightbox/menus. */
  renderPanel?: (position: number) => ReactNode;
};

/** Native scroll-snap pager: the browser owns axis arbitration and motion.
 *  Every variant keeps a full-width slot; only current ±1 mount content.
 *  Height follows the selected panel, not the tallest neighbor. */
export function MobileVariantCarousel(props: MobileVariantCarouselProps) {
  const { selectedVariantIndex, variants, isBusy, swipeWhileBusy = false, onSelectVariant, renderPanel } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const currentPanelRef = useRef<HTMLDivElement>(null);
  const slotWidthRef = useRef(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const currentIndex = Math.max(0, Math.min(variants.length - 1, selectedVariantIndex));
  const currentVariant = variants[currentIndex];
  const hasVariants = variants.length > 0;
  const swipeLocked = isBusy && !swipeWhileBusy;
  const renderWindow = getVariantRenderWindow(currentIndex, variants.length);

  useImperativeHandle(props.ref, () => ({
    selectVariant(index) {
      if (swipeLocked || !Number.isInteger(index) || index < 0 || index >= variants.length || index === currentIndex) return;
      const el = viewportRef.current;
      // Preserve instant jump-list selection outside the adjacent render
      // window, or before layout exists; only chevrons need a visible slide.
      if (!el || slotWidthRef.current <= 0 || Math.abs(index - currentIndex) > 1) {
        onSelectVariant(index, index > currentIndex ? 1 : -1);
        return;
      }
      el.scrollTo({
        left: index * slotWidthRef.current,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    },
  }), [currentIndex, swipeLocked, variants.length, onSelectVariant]);

  const alignSelected = useEffectEvent(() => {
    const el = viewportRef.current;
    if (el && slotWidthRef.current > 0) el.scrollLeft = currentIndex * slotWidthRef.current;
  });

  const updateWidth = useEffectEvent(() => {
    const el = viewportRef.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width <= 0) return;
    // The gap lives on the track, never inside a panel. Read the CSS source
    // instead of duplicating its size in the scroll/index calculations.
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    const pitch = width + gap;
    if (pitch === slotWidthRef.current) return;
    slotWidthRef.current = pitch;
    alignSelected();
  });

  const readMetrics = useEffectEvent(() => ({
    scrollLeft: viewportRef.current?.scrollLeft ?? 0,
    slotWidth: slotWidthRef.current,
    variantCount: variants.length,
  }));

  const commitSettled = useEffectEvent((index: number) => {
    if (swipeLocked) {
      alignSelected();
      return;
    }
    if (index !== currentIndex) onSelectVariant(index, index > currentIndex ? 1 : -1);
  });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    updateWidth();
    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasVariants]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    return observeVariantScrollSettle(el, {
      readMetrics: () => readMetrics(),
      onSettle: (index) => commitSettled(index),
    });
  }, [hasVariants]);

  useLayoutEffect(() => {
    const el = currentPanelRef.current;
    if (!el) return;

    const updateHeight = () => {
      const nextHeight = el.getBoundingClientRect().height;
      setViewportHeight((currentHeight) => currentHeight === null || Math.abs(currentHeight - nextHeight) > 0.5 ? nextHeight : currentHeight);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentIndex, currentVariant?.id, currentVariant?.content, renderPanel]);

  useLayoutEffect(() => {
    // Structural/external selection aligns instantly; chevrons use the handle
    // above and do not change selection until the native motion settles.
    // Lock activation also cancels an in-flight swipe back to the selection.
    alignSelected();
  }, [currentIndex, currentVariant?.id, variants.length, swipeLocked]);

  if (!currentVariant) return null;

  return (
    <div
      ref={viewportRef}
      data-testid="mobile-variant-carousel"
      className={cn(
        "relative flex items-start gap-3 overflow-y-hidden snap-x snap-mandatory overscroll-x-contain scrollbar-hide",
        swipeLocked ? "overflow-x-hidden" : "overflow-x-auto",
      )}
      style={{ height: viewportHeight ?? undefined, transition: "height 180ms ease" }}
    >
      {variants.map((variant, index) => {
        const isCurrent = index === currentIndex;
        return (
          <div
            key={variant.id ?? variant.variantIndex ?? index}
            ref={isCurrent ? currentPanelRef : undefined}
            data-variant-index={index}
            className={cn("min-w-0 w-full shrink-0 snap-start snap-always", !isCurrent && "pointer-events-none")}
            aria-hidden={isCurrent ? undefined : true}
            inert={isCurrent ? undefined : true}
            translate={isCurrent ? "yes" : "no"}
          >
            {renderWindow.includes(index) && (renderPanel
              ? renderPanel(index)
              : (
                <div className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
                  <Markdown text={variant.content} />
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
