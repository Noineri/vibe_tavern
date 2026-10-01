/**
 * The fine-tuning chip's collapsible section shell (IMAGEGEN_CHIP_REDESIGN_PLAN
 * ICR-1, owner-approved mockups `plans/IMAGEGEN_CHIP_REDESIGN_mockups/chip-redesign.html`):
 * a bordered card with a one-line header (title + summary) and an
 * `AnimatedDisclosure` body on the shared two-column grid. Chip-local — NOT a
 * shared primitive (one consumer family; the third generic caller is the
 * promotion point, AGENTS.md §3).
 *
 * Two variants (the mockup's two header shapes):
 * - `disclosure` — the whole header is the toggle button (`aria-expanded`),
 *   caret chevron via the shared `Icons.Caret` (r closed / d open). Desktop
 *   puts the caret FIRST, mobile LAST (the mockup's two layouts).
 * - `toggle` — the header is a row with the shared `Toggle` as its LAST child;
 *   the body follows the toggle's checked value (Hires, ADetailer).
 *
 * Sections have NO background of their own (transparent over the popover's
 * `bg-glass-bg` — glass themes must show through; the mockup's Coffee colors
 * are preview-only). The title wraps (authored copy never truncates, AD-022);
 * only the SUMMARY truncates (user data — the full value stays reachable by
 * expanding the section). The container-query classes work because the chip's
 * body root is the Tailwind `@container`.
 */

import type { ReactNode } from "react";

import { Icons } from "../shared/icons.js";
import { Toggle } from "../shared/Toggle.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

export interface ImageGenChipSectionTestIds {
  /** The section's root card. */
  root?: string;
  /** The header row (button for disclosure, plain div for toggle). */
  header?: string;
  /** The disclosure body (present only while open — the AnimatedDisclosure
   *  wrapper itself carries it). */
  body?: string;
}

export interface ImageGenChipSectionProps {
  /** The section title (authored i18n copy — wraps, never truncates). */
  title: string;
  /** The one-line header summary (user data — truncates; the full value is
   *  reachable by expanding the section). Omit for no summary. */
  summary?: string;
  variant: "disclosure" | "toggle";
  /** Disclosure variant: whether the body is expanded. */
  open?: boolean;
  /** Disclosure variant: commits a header click. */
  onOpenChange?: (open: boolean) => void;
  /** Toggle variant: the switch's checked value (drives the body). */
  checked?: boolean;
  /** Toggle variant: commits the switch. */
  onCheckedChange?: (checked: boolean) => void;
  /** Toggle variant: disables the switch (the unavailable state). */
  toggleDisabled?: boolean;
  /** Toggle variant: the switch's accessible name (defaults to the title). */
  toggleAriaLabel?: string;
  /** Rendered under the header (the ADetailer «unavailable» hint). */
  hint?: ReactNode;
  testIds?: ImageGenChipSectionTestIds;
  /** The section body (the two-column grid's cells). */
  children: ReactNode;
}

export function ImageGenChipSection({
  title,
  summary,
  variant,
  open = false,
  onOpenChange,
  checked = false,
  onCheckedChange,
  toggleDisabled,
  toggleAriaLabel,
  hint,
  testIds,
  children,
}: ImageGenChipSectionProps) {
  const isMobile = useIsMobile();
  const caret = <Icons.Caret direction={open ? "d" : "r"} />;
  const titleBlock = (
    <span className="flex min-w-0 flex-1 flex-col @min-[480px]:flex-row @min-[480px]:items-center @min-[480px]:gap-2.5">
      <span className="break-words font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{title}</span>
      {summary !== undefined && (
        <span className="min-w-0 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3 @min-[480px]:ml-auto">
          {summary}
        </span>
      )}
    </span>
  );

  return (
    <div className="rounded-lg border border-border" data-testid={testIds?.root}>
      {variant === "disclosure" ? (
        <button
          type="button"
          data-testid={testIds?.header}
          aria-expanded={open}
          onClick={() => onOpenChange?.(!open)}
          className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left"
        >
          {!isMobile && caret}
          {titleBlock}
          {isMobile && caret}
        </button>
      ) : (
        <div
          data-testid={testIds?.header}
          className="flex min-h-9 w-full items-center gap-2.5 px-3 py-2 text-left"
        >
          {titleBlock}
          <Toggle
            checked={checked}
            onChange={(next) => onCheckedChange?.(next)}
            disabled={toggleDisabled}
            aria-label={toggleAriaLabel ?? title}
          />
        </div>
      )}
      {hint !== undefined && <div className="px-3 pb-2 pt-0.5">{hint}</div>}
      <AnimatedDisclosure
        open={variant === "disclosure" ? open : checked}
        data-testid={testIds?.body}
        className="grid grid-cols-1 gap-x-3 gap-y-2.5 px-3 pb-3 pt-1 @min-[480px]:grid-cols-2"
      >
        {children}
      </AnimatedDisclosure>
    </div>
  );
}
