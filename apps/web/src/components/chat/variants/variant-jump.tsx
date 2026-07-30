import { useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { useMessageAiEditorStore } from "../../../stores/message-ai-editor-store.js";
import { brandId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { VariantJumpSheet } from "./variant-jump-sheet.js";
import type { VariantPickerItem } from "./types.js";

/**
 * Q5/MAE-53: jump-to-variant browser for messages with >6 variants. Each row
 * shows provenance (model + preset) AND carries an independent star toggle.
 *
 * Dual-mode by viewport, both on shared primitives: desktop uses a Radix
 * Popover (NOT Select — Select is single-action: selecting a value is the only
 * interaction. Here row-select and star-toggle are INDEPENDENT actions, so
 * Popover is the right primitive). Mobile delegates to VariantJumpSheet
 * (shared/BottomSheet).
 *
 * Independence contract:
 *  - Row click  → onSelect(index) + close the popover.
 *  - Star click → toggleStar(messageId, variantId); NO selection, NO close.
 *
 * The selected checkmark and the starred glyph are VISUALLY DISTINCT: the
 * checkmark is a `<Icons.check />` in a fixed slot beside the index; the star
 * is a separate button on the right, filled when starred / outlined when not.
 * A variant can be starred-without-selected and selected-without-starred.
 *
 * Stars key on the immutable `variantId` (canonical `message_variants.id`),
 * never on the display index — so a star survives variant deletion / index
 * recompaction (the store's `pruneStaleStars` drops deleted IDs; the star
 * never silently retargets the variant now occupying the deleted one's index).
 */
export function VariantJump({ mobile, items, messageId, selectedVariantIndex, variantCount, onSelect }: {
  mobile?: boolean;
  items: VariantPickerItem[];
  /** Bare message id — keyed into the ephemeral star store. */
  messageId: string;
  selectedVariantIndex: number;
  variantCount: number;
  onSelect: (index: number) => void;
}) {
  const counter = <>{selectedVariantIndex + 1}/{variantCount}<span className="text-t3"><Icons.Caret direction="d" /></span></>;

  if (mobile) {
    return (
      <VariantJumpSheet
        items={items}
        messageId={messageId}
        selectedVariantIndex={selectedVariantIndex}
        variantCount={variantCount}
        onSelect={onSelect}
        trigger={counter}
      />
    );
  }

  return (
    <VariantJumpDesktop
      items={items}
      messageId={messageId}
      selectedVariantIndex={selectedVariantIndex}
      variantCount={variantCount}
      onSelect={onSelect}
      counter={counter}
    />
  );
}

function VariantJumpDesktop({
  items, messageId, selectedVariantIndex, variantCount, onSelect, counter,
}: {
  items: VariantPickerItem[];
  messageId: string;
  selectedVariantIndex: number;
  variantCount: number;
  onSelect: (index: number) => void;
  counter: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const brandedMessageId = brandId<MessageId>(messageId);

  // Roving focus across the row-selection buttons — keyboard parity with the
  // prior Radix Select (ArrowUp/Down/Home/End). Star buttons are reachable
  // via Tab; they intentionally stay out of the arrow-rotation count.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const nodes = contentRef.current?.querySelectorAll<HTMLElement>("[data-vj-item]");
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const currentIndex = list.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[currentIndex === -1 ? 0 : (currentIndex + 1) % list.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[currentIndex === -1 ? list.length - 1 : (currentIndex - 1 + list.length) % list.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1].focus();
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Variant ${selectedVariantIndex + 1} of ${variantCount}`}
          aria-expanded={open}
          className="flex items-center gap-0.5 rounded-[3px] px-1 font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
        >
          {counter}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          side="top"
          sideOffset={4}
          align="center"
          onKeyDown={handleKeyDown}
          className="glass-blur z-50 w-72 overflow-hidden rounded-lg border border-border bg-glass-bg p-1 shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
        >
          <div className="max-h-64 overflow-y-auto">
            {items.map((item, i) => {
              const isSelected = i === selectedVariantIndex;
              return (
                <div
                  key={item.variantId}
                  data-testid={`variant-row-${item.displayIndex}`}
                  data-variant-row
                  className="flex w-full items-center gap-1 rounded px-1 py-1"
                >
                  <button
                    type="button"
                    data-vj-item
                    data-testid={`variant-select-${item.displayIndex}`}
                    data-selected={isSelected}
                    onClick={() => {
                      onSelect(i);
                      setOpen(false);
                    }}
                    className="flex flex-1 min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors hover:bg-s2 focus-visible:bg-s2 data-[selected=true]:text-accent-t"
                  >
                    <span className="w-6 shrink-0 tabular-nums text-t3">#{item.displayIndex}</span>
                    <span className="flex w-4 shrink-0 justify-center text-accent-t">
                      {isSelected && <Icons.check />}
                    </span>
                    <span className="shrink-0 font-medium text-t1">{item.modelLabel || "—"}</span>
                    {item.presetName && <span className="min-w-0 truncate text-t3">· {item.presetName}</span>}
                  </button>
                  <VariantStarButton
                    messageId={brandedMessageId}
                    variantId={item.variantId}
                    displayIndex={item.displayIndex}
                    className="h-7 w-7"
                  />
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const EMPTY_STARS: MessageVariantId[] = [];

/**
 * Star toggle button shared between the desktop Popover (above) and the mobile
 * sheet (variant-jump-sheet.tsx). Reads/toggles from the ephemeral
 * `useMessageAiEditorStore` keyed by the immutable `variantId` — so a star
 * survives index recompaction. NO selection, NO close on click; the parent
 * popover/sheet stays open. Exported so the mobile sheet can reuse it without
 * duplicating the store wiring.
 */
export function VariantStarButton({ messageId, variantId, displayIndex, className }: {
  messageId: MessageId;
  variantId: MessageVariantId;
  displayIndex: number;
  className?: string;
}) {
  const { tDynamic } = useT();
  const starredList = useMessageAiEditorStore((s) => s.starredVariantIdsByMessage[messageId] ?? EMPTY_STARS);
  const toggleStar = useMessageAiEditorStore((s) => s.toggleStar);
  const isStarred = starredList.includes(variantId);
  return (
    <button
      type="button"
      data-testid={`variant-star-${displayIndex}`}
      data-variant-star
      aria-pressed={isStarred}
      aria-label={tDynamic(isStarred ? "variant_jump_unstar_label" : "variant_jump_star_label", { n: displayIndex })}
      onClick={() => toggleStar(messageId, variantId)}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[5px] outline-none transition-colors",
        isStarred ? "text-accent-t hover:bg-s2" : "text-t3 hover:bg-s2 hover:text-t1 focus-visible:bg-s2",
        className,
      )}
    >
      {isStarred ? <Icons.starFilled /> : <Icons.star />}
    </button>
  );
}
