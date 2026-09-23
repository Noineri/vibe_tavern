/**
 * VariantControls — the busy gate split (IF-4b, IMAGEGEN_FOLLOWUP_REPORT).
 *
 * WHAT THIS PROVES
 *   The prev/next arrows lock while the message is busy — but ONLY for the
 *   default (text) callers. `swipeWhileBusy` (the image-slot path) must keep
 *   the arrows live while another slot generates: the owner ruling
 *   (2026-09-22) is that the busy lock exists for text swipes; a generating
 *   sibling must not freeze this slot's carousel.
 *
 * HOW THIS PROVES IT
 *   The real VariantControls mounts with three variants (middle selected, so
 *   both arrows are positionally legal) under busy/not-busy ×
 *   swipeWhileBusy/default. The arrow <button>s' `disabled` state is the pin.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, cleanup } = await import("@testing-library/react");

const { VariantControls } = await import("./variant-controls.js");

const NOOP = () => {};

function arrowsOf(view: { container: HTMLElement }) {
  const row = view.container.querySelector("span");
  expect(row).toBeTruthy();
  const buttons = [...row!.querySelectorAll("button")];
  // No jump browser (variantCount 3 < 6): exactly the prev/next pair.
  expect(buttons.length).toBe(2);
  return buttons.map((button) => button.disabled) as [boolean, boolean];
}

describe("VariantControls — busy gate (IF-4b)", () => {
  test("default (text): busy locks both arrows", async () => {
    const view = render(
      <VariantControls
        isBusy
        messageId="m1"
        selectedVariantIndex={1}
        variantCount={3}
        onSelectVariant={NOOP}
      />,
    );
    expect(arrowsOf(view)).toEqual([true, true]);
  });

  test("default (text): not busy keeps both arrows live", async () => {
    const view = render(
      <VariantControls
        isBusy={false}
        messageId="m1"
        selectedVariantIndex={1}
        variantCount={3}
        onSelectVariant={NOOP}
      />,
    );
    expect(arrowsOf(view)).toEqual([false, false]);
  });

  test("swipeWhileBusy (image slot): busy does NOT lock the arrows", async () => {
    const view = render(
      <VariantControls
        isBusy
        swipeWhileBusy
        messageId="m1"
        selectedVariantIndex={1}
        variantCount={3}
        onSelectVariant={NOOP}
      />,
    );
    expect(arrowsOf(view)).toEqual([false, false]);
  });

  test("swipeWhileBusy respects positional bounds (first variant: prev still disabled)", async () => {
    const view = render(
      <VariantControls
        isBusy
        swipeWhileBusy
        messageId="m1"
        selectedVariantIndex={0}
        variantCount={3}
        onSelectVariant={NOOP}
      />,
    );
    expect(arrowsOf(view)).toEqual([true, false]);
  });
});

afterAll(() => {
  cleanup();
});
