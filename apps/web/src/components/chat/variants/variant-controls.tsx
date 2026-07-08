import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { VariantJump } from "./variant-jump.js";
import type { SwipeDirection, VariantProvenance } from "./types.js";

type VariantControlsProps = {
  isBusy: boolean;
  selectedVariantIndex: number;
  variantCount: number;
  /** Per-variant provenance for the jump dropdown (only populated when variantCount > 6). */
  provenance?: VariantProvenance[];
  controlsRef?: React.RefObject<HTMLSpanElement | null>;
  hidden?: boolean;
  mobile?: boolean;
  overlay?: boolean;
  onSelectVariant: (targetIndex: number, direction: SwipeDirection) => void;
};

/** Prev/next variant arrows + counter or jump dropdown. Dual-mode by viewport:
 *  mobile renders large 40px touch targets in a pill; desktop renders compact
 *  20px buttons. When variantCount > 6 and provenance is populated, the counter
 *  is replaced by VariantJump (Radix Select desktop / BottomSheet mobile). */
export function VariantControls(props: VariantControlsProps) {
  const { controlsRef, hidden = false, isBusy, selectedVariantIndex, variantCount, provenance, mobile = false, overlay = false, onSelectVariant } = props;
  const showJump = variantCount > 6 && provenance && provenance.length > 0 && !overlay;

  const canGoPrevious = !isBusy && selectedVariantIndex > 0;
  const canGoNext = !isBusy && selectedVariantIndex < variantCount - 1;
  const selectPrevious = () => { if (canGoPrevious) onSelectVariant(selectedVariantIndex - 1, -1); };
  const selectNext = () => { if (canGoNext) onSelectVariant(selectedVariantIndex + 1, 1); };

  if (mobile) {
    return (
      <div className="inline-flex items-center justify-center gap-1 rounded-lg bg-s1/60 px-1 py-0.5">
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:opacity-35 [&_svg]:h-5 [&_svg]:w-5"
          disabled={!canGoPrevious}
          onClick={selectPrevious}
        ><Icons.Caret direction="l" /></button>
        {showJump ? (
          <VariantJump
            mobile
            provenance={provenance!}
            selectedVariantIndex={selectedVariantIndex}
            variantCount={variantCount}
            onSelect={(index) => onSelectVariant(index, index > selectedVariantIndex ? 1 : -1)}
          />
        ) : (
          <span className="min-w-12 text-center font-ui text-[13px] tabular-nums text-t2">{selectedVariantIndex + 1}/{variantCount}</span>
        )}
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:opacity-35 [&_svg]:h-5 [&_svg]:w-5"
          disabled={!canGoNext}
          onClick={selectNext}
        ><Icons.Caret direction="r" /></button>
      </div>
    );
  }

  return (
    <span
      ref={controlsRef}
      className={cn(
        "flex items-center gap-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3",
        !overlay && "ml-auto mr-auto",
      )}
      style={hidden ? { visibility: "hidden" } : undefined}
    >
      <button type="button"
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
        disabled={!canGoPrevious}
        onClick={selectPrevious}
      ><Icons.Caret direction="l" /></button>
      {showJump ? (
        <VariantJump
          provenance={provenance!}
          selectedVariantIndex={selectedVariantIndex}
          variantCount={variantCount}
          onSelect={(index) => onSelectVariant(index, index > selectedVariantIndex ? 1 : -1)}
        />
      ) : (
        <span className="min-w-6 text-center tabular-nums">{selectedVariantIndex + 1}/{variantCount}</span>
      )}
      <button type="button"
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] transition-colors duration-100 hover:bg-s2 hover:text-t1"
        disabled={!canGoNext}
        onClick={selectNext}
      ><Icons.Caret direction="r" /></button>
    </span>
  );
}
