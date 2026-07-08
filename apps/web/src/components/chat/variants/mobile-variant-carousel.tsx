import { useLayoutEffect, useRef, useState } from "react";
import { motion, useAnimationControls, type PanInfo } from "framer-motion";
import { Markdown } from "../../../lib/markdown.js";
import type { SwipeDirection } from "./types.js";

type MobileVariantCarouselProps = {
  selectedVariantIndex: number;
  variants: { content: string }[];
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

/** Three-panel swipe carousel for variant browsing on mobile (framer-motion
 *  drag). Renders prev / current / next variants side by side in a 300%-wide
 *  track; drag past threshold snaps to the neighbor and fires onSelectVariant.
 *  Height auto-fits the current panel via a ResizeObserver (no inner scroll). */
export function MobileVariantCarousel(props: MobileVariantCarouselProps) {
  const { selectedVariantIndex, variants, onSelectVariant } = props;
  const controls = useAnimationControls();
  const viewportRef = useRef<HTMLDivElement>(null);
  const currentPanelRef = useRef<HTMLDivElement>(null);
  const isAnimatingRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const currentVariant = variants[selectedVariantIndex] ?? variants[0];
  const previousVariant = selectedVariantIndex > 0 ? variants[selectedVariantIndex - 1] : null;
  const nextVariant = selectedVariantIndex < variants.length - 1 ? variants[selectedVariantIndex + 1] : null;
  const canGoPrevious = selectedVariantIndex > 0;
  const canGoNext = selectedVariantIndex < variants.length - 1;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      const nextWidth = el.getBoundingClientRect().width;
      setViewportWidth((currentWidth) => Math.abs(currentWidth - nextWidth) > 0.5 ? nextWidth : currentWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
  }, [currentVariant?.content, selectedVariantIndex]);

  useLayoutEffect(() => {
    if (viewportWidth > 0) controls.set({ x: -viewportWidth });
  }, [controls, selectedVariantIndex, viewportWidth]);

  const snapToCenter = () => {
    void controls.start({
      x: -viewportWidth,
      transition: { type: "spring", stiffness: 420, damping: 38 },
    });
  };

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (isAnimatingRef.current || viewportWidth <= 0) return;

    const threshold = Math.min(120, Math.max(55, viewportWidth * 0.22));
    const shouldGoNext = canGoNext && (info.offset.x < -threshold || info.velocity.x < -650);
    const shouldGoPrevious = canGoPrevious && (info.offset.x > threshold || info.velocity.x > 650);

    if (!shouldGoNext && !shouldGoPrevious) {
      snapToCenter();
      return;
    }

    const swipeDirection: SwipeDirection = shouldGoNext ? 1 : -1;
    const targetIndex = selectedVariantIndex + swipeDirection;
    const targetX = shouldGoNext ? -viewportWidth * 2 : 0;

    isAnimatingRef.current = true;
    void controls.start({
      x: targetX,
      transition: { type: "spring", stiffness: 420, damping: 38 },
    }).then(() => {
      onSelectVariant(targetIndex, swipeDirection);
      controls.set({ x: -viewportWidth });
      isAnimatingRef.current = false;
    });
  };

  if (!currentVariant) return null;

  return (
    <motion.div
      ref={viewportRef}
      className="relative overflow-hidden"
      style={{ height: viewportHeight ?? undefined, transition: "height 180ms ease", touchAction: "pan-y" }}
    >
      <motion.div
        className="absolute left-0 top-0 flex w-[300%] items-start"
        animate={controls}
        drag="x"
        dragConstraints={{
          left: canGoNext ? -viewportWidth * 2 : -viewportWidth,
          right: canGoPrevious ? 0 : -viewportWidth,
        }}
        dragDirectionLock
        dragElastic={0.08}
        onDragEnd={handleDragEnd}
      >
        <div className="w-1/3 shrink-0 pr-3" aria-hidden={!previousVariant}>
          {previousVariant && (
            <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
              <Markdown text={previousVariant.content} />
            </div>
          )}
        </div>
        <div ref={currentPanelRef} className="w-1/3 shrink-0" translate="yes">
          <div className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
            <Markdown text={currentVariant.content} />
          </div>
        </div>
        <div className="w-1/3 shrink-0 pl-3" aria-hidden={!nextVariant}>
          {nextVariant && (
            <div translate="yes" className="font-body text-[length:var(--mfs)] leading-[1.65] text-msg-t1 [&_em]:italic [&_em]:text-msg-t2">
              <Markdown text={nextVariant.content} />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
