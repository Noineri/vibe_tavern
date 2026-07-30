import { useState } from "react";
import { cn } from "../../../lib/cn.js";
import { brandId, type MessageId } from "@vibe-tavern/domain";
import { BottomSheet } from "../../shared/BottomSheet.js";
import { VariantStarButton } from "./variant-jump.js";
import type { VariantPickerItem } from "./types.js";

/**
 * Mobile half of the dual-mode variant jump: a shared/BottomSheet with one row
 * per variant. Owns its open state. Selecting a row fires onSelect then closes;
 * tapping a row's star toggles the star (via the ephemeral store) WITHOUT
 * selecting and WITHOUT closing the sheet — the user can star several variants
 * in one open. The desktop half (VariantJump) renders a Popover and delegates
 * to this sheet when `mobile` is set.
 *
 * Row layout: each row is a flex `<div>` (NOT a `<button>` — nested buttons are
 * invalid HTML) containing two sibling buttons: the row-select button (flex-1,
 * 52px min-height touch target — preserved from the pre-star layout so the
 * existing jump+swipe behavior is untouched) and a 44px star toggle on the
 * right (h-11 w-11 touch target per MAE-53 a11y).
 */
export function VariantJumpSheet({ items, messageId, selectedVariantIndex, variantCount, onSelect, trigger }: {
  items: VariantPickerItem[];
  /** Bare message id — keyed into the ephemeral star store. */
  messageId: string;
  selectedVariantIndex: number;
  variantCount: number;
  onSelect: (index: number) => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const brandedMessageId = brandId<MessageId>(messageId);
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
          {items.map((item, i) => {
            const isSelected = i === selectedVariantIndex;
            return (
              <div
                key={item.variantId}
                data-testid={`variant-row-${item.displayIndex}`}
                data-variant-row
                className={cn(
                  "flex w-full items-center gap-1 px-1 transition-colors active:bg-s3",
                )}
              >
                <button
                  type="button"
                  data-testid={`variant-select-${item.displayIndex}`}
                  data-selected={isSelected}
                  className={cn(
                    "flex min-h-[52px] flex-1 min-w-0 items-center gap-2 px-3 text-left text-[calc(var(--ui-fs)+1px)]",
                    isSelected ? "text-accent-t" : "text-t2",
                  )}
                  onClick={() => { onSelect(i); setOpen(false); }}
                >
                  <span className="w-6 shrink-0 text-t3">#{item.displayIndex}</span>
                  <span className="w-4 shrink-0 flex justify-center text-accent-t">
                    {isSelected && "✓"}
                  </span>
                  <span className="shrink-0 font-medium text-t1">{item.modelLabel || "—"}</span>
                  {item.presetName && <span className="min-w-0 truncate text-t3">· {item.presetName}</span>}
                </button>
                <VariantStarButton
                  messageId={brandedMessageId}
                  variantId={item.variantId}
                  displayIndex={item.displayIndex}
                  className="h-11 w-11"
                />
              </div>
            );
          })}
        </div>
      </BottomSheet>
    </>
  );
}
