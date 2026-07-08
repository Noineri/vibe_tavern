import * as Select from "@radix-ui/react-select";
import { Icons } from "../../shared/icons.js";
import { VariantJumpSheet } from "./variant-jump-sheet.js";
import type { VariantProvenance } from "./types.js";

/**
 * Q5: jump-to-variant dropdown for messages with >6 variants. Each row shows
 * provenance (model + preset); selecting one jumps via the existing
 * selectVariant path. Dual-mode by viewport, both on shared primitives:
 * desktop uses Radix Select (compact upward popper, arrow/type-ahead); mobile
 * uses shared/BottomSheet via VariantJumpSheet. The desktop trigger shows a
 * counter ('N/total'), so Select.Value is unused.
 */
export function VariantJump({ mobile, provenance, selectedVariantIndex, variantCount, onSelect }: {
  mobile?: boolean;
  provenance: VariantProvenance[];
  selectedVariantIndex: number;
  variantCount: number;
  onSelect: (index: number) => void;
}) {
  const counter = <>{selectedVariantIndex + 1}/{variantCount}<span className="text-t3"><Icons.Caret direction="d" /></span></>;

  if (mobile) {
    return <VariantJumpSheet provenance={provenance} selectedVariantIndex={selectedVariantIndex} variantCount={variantCount} onSelect={onSelect} trigger={counter} />;
  }

  return (
    <Select.Root
      value={String(selectedVariantIndex)}
      onValueChange={(v) => onSelect(Number(v))}
    >
      <Select.Trigger asChild aria-label={`Variant ${selectedVariantIndex + 1} of ${variantCount}`}>
        <button
          type="button"
          className="flex items-center gap-0.5 rounded-[3px] px-1 font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
        >
          {counter}
        </button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="top"
          sideOffset={4}
          className="glass-blur z-50 w-64 overflow-hidden rounded-lg border border-border bg-glass-bg shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
        >
          <Select.Viewport className="max-h-64 overflow-y-auto p-1">
            {provenance.map((p, i) => (
              <Select.Item
                key={i}
                value={String(i)}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-2 text-left text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors data-[highlighted]:bg-s2 data-[state=checked]:text-accent-t"
              >
                <Select.ItemText asChild>
                  <span className="flex w-full items-center gap-2">
                    <span className="w-6 shrink-0 text-t3">#{i + 1}</span>
                    <span className="shrink-0 font-medium text-t1">{p.modelLabel || "—"}</span>
                    {p.presetName && <span className="truncate text-t3">· {p.presetName}</span>}
                  </span>
                </Select.ItemText>
                <Select.ItemIndicator className="ml-auto shrink-0 text-accent-t">✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
