import { useState } from "react";
import { cn } from "../../../lib/cn.js";
import { BottomSheet } from "../../shared/BottomSheet.js";
import type { VariantProvenance } from "./types.js";

/**
 * Mobile half of the dual-mode variant jump: a shared/BottomSheet with one row
 * per variant. Owns its open state; selecting a row fires onSelect then closes.
 * The desktop half (VariantJump) renders a Radix Select and delegates to this
 * sheet when `mobile` is set.
 */
export function VariantJumpSheet({ provenance, selectedVariantIndex, variantCount, onSelect, trigger }: {
  provenance: VariantProvenance[];
  selectedVariantIndex: number;
  variantCount: number;
  onSelect: (index: number) => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="flex min-h-10 min-w-12 items-center justify-center gap-0.5 rounded-lg px-2 font-ui text-[13px] tabular-nums text-t2 active:bg-s2"
        aria-label={`Variant ${selectedVariantIndex + 1} of ${variantCount}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {trigger}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)}>
        <div className="max-h-[50vh] overflow-y-auto pb-2">
          {provenance.map((p, i) => (
            <button
              key={i}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 text-left transition-colors min-h-[52px] text-[calc(var(--ui-fs)+1px)] active:bg-s3",
                i === selectedVariantIndex ? "text-accent-t" : "text-t2",
              )}
              onClick={() => { onSelect(i); setOpen(false); }}
            >
              <span className="w-6 shrink-0 text-t3">#{i + 1}</span>
              <span className="shrink-0 font-medium text-t1">{p.modelLabel || "—"}</span>
              {p.presetName && <span className="truncate text-t3">· {p.presetName}</span>}
              {i === selectedVariantIndex && <span className="ml-auto shrink-0 text-accent-t">✓</span>}
            </button>
          ))}
        </div>
      </BottomSheet>
    </>
  );
}
