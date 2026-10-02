/**
 * The fine-tuning chip body's frame (extracted from ImageGenFineTuningChip.tsx
 * — the file-size ratchet): the body root, the scroll layout, and the pinned
 * footer. The chip builds the field blocks as element variables; this module
 * only places them, in one of three sequences:
 *
 * - desktop single column (ICR-3): base 2×2 → prompts → sections stack, one
 *   scroll region;
 * - mobile sheet (ICR-3): prompts → divider → base → sections stack;
 * - wide two-pane (owner-approved mockup
 *   `plans/IMAGEGEN_CHIP_REDESIGN_mockups/chip-wide.html`, 2026-10-01): left
 *   a fixed 400px «what to draw» (base + prompts), right «how to draw it»
 *   (the sections stack), each scrolling on its own. The grid carries the
 *   `data-ft-two-pane` marker the popover's `has-[…]` variants key on to
 *   grow to min(960px, 60vw) × 85vh — the chip decides `twoPane`
 *   (wide viewport + a sections stack + not mobile), the popover follows.
 *
 * Footer: pinned outside the scroll region with a border-top (ICR-3);
 * mobile gets the thumb pair (the buttons' own classes fork on mobile).
 */

import type { ReactNode } from "react";

export interface ImageGenChipBodyLayoutProps {
  isMobile: boolean;
  /** Wide two-pane layout — the caller has already folded in "not mobile"
   *  and "a sections stack exists". */
  twoPane: boolean;
  baseFieldsDesktop: ReactNode;
  baseFieldsMobile: ReactNode;
  promptsBlock: ReactNode;
  /** null when the profile has no advanced content (no dead half-column). */
  sectionsStack: ReactNode;
  clearButton: ReactNode;
  generateButton: ReactNode;
}

export function ImageGenChipBodyLayout({
  isMobile,
  twoPane,
  baseFieldsDesktop,
  baseFieldsMobile,
  promptsBlock,
  sectionsStack,
  clearButton,
  generateButton,
}: ImageGenChipBodyLayoutProps) {
  return (
    <div
      className="@container flex min-h-0 max-h-[80dvh] flex-1 flex-col"
      data-testid="image-gen-ft-body"
    >
      {/* Scroll region (set-switch report C → ICR-3): the popover caps its
          height at the space Radix actually has above the trigger; the body
          rolls inside this region and the footer stays pinned below it (the
          DiceTray 616–640 canon). The body root's max-h-[80dvh] is the same
          cap's mobile twin — the sheet does not bound height, the caller
          must (the DiceTray rule; inert on desktop where the popover caps
          first). The scroll region's own px-3/pt-3 is the body's only inset. */}
      {twoPane ? (
        // Wide two-pane: the bounded single row lets each pane scroll by
        // itself — open samplers never push the prompt out of view.
        <div
          className="grid min-h-0 flex-1 grid-cols-[400px_1px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
          data-testid="image-gen-ft-two-pane"
          data-ft-two-pane=""
        >
          <div
            className="flex min-h-0 flex-col gap-2.5 overflow-y-auto p-3"
            data-testid="image-gen-ft-pane-left"
          >
            {baseFieldsDesktop}
            {promptsBlock}
          </div>
          <div className="bg-border" />
          {/* Its own container: the sections' two-column grids query this
              pane's width, not the whole popover's. */}
          <div className="@container min-h-0 overflow-y-auto p-3" data-testid="image-gen-ft-pane-right">
            {sectionsStack}
          </div>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3 pt-3"
          data-testid="image-gen-ft-scroll"
        >
          {isMobile ? (
            <>
              {promptsBlock}
              <div className="my-0.5 h-px shrink-0 bg-border opacity-40" />
              {baseFieldsMobile}
            </>
          ) : (
            <>
              {baseFieldsDesktop}
              {promptsBlock}
            </>
          )}
          {sectionsStack}
        </div>
      )}
      {isMobile ? (
        <div className="flex shrink-0 gap-2.5 border-t border-border px-4 pb-4 pt-2.5">
          {clearButton}
          {generateButton}
        </div>
      ) : (
        <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border px-3 pt-2">
          {clearButton}
          {generateButton}
        </div>
      )}
    </div>
  );
}
