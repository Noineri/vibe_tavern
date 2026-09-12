/**
 * Stacked-Modal dropdown portal regression test (MUI step 3).
 *
 * The mobile defect (owner 2026-09-11): a dropdown inside the preset import
 * modal opened UNDER the modal — `Modal` rendered its `#modal-portal` anchor
 * but never REGISTERED it in the overlay stack (only BottomSheet registered),
 * so `getModalPortal()` fell back to `document.getElementById("modal-portal")`,
 * which with two stacked Modals resolves DOM-first = the BOTTOM modal's anchor
 * → the popup portals into the bottom modal's z-context and paints under the
 * top modal. Confirmed stacked pair: PromptManagerModal → PresetImportModal
 * (SegmentedControl mobileSelect renders a DropdownSelect on phones).
 *
 * Pinned here at the RESOLUTION boundary, not the popup mount: in happy-dom
 * every box is 0×0 and Radix Popover.Content never anchors/mounts (see the
 * STATUS note in DropdownSelect.test.tsx), so popup containment cannot be
 * asserted. What CAN be asserted — and is exactly where the bug lives — is
 * which anchor `getModalPortal()` resolves to while two Modals are stacked,
 * and that the stack unwinds when the top modal closes.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, cleanup, render } = await import("@testing-library/react");
const { Modal } = await import("./Modal.js");
const { getModalPortal } = await import("./modal-helpers.js");

/** Which modal's Dialog.Content does the currently resolved portal anchor
 *  belong to? The anchor is a direct child of Dialog.Content, sibling of the
 *  wrapper that renders the children markers. */
function anchorOwner(): "bottom" | "top" | "none" {
  const host = getModalPortal();
  if (!host) return "none";
  const content = host.parentElement;
  if (!content) return "none";
  if (content.querySelector('[data-testid="top-modal-marker"]')) return "top";
  if (content.querySelector('[data-testid="bottom-modal-marker"]')) return "bottom";
  return "none";
}

describe("stacked Modal overlay-portal registration", () => {
  it("with two stacked Modals, getModalPortal resolves the TOP modal's anchor (not DOM-first getElementById)", () => {
    render(
      <Modal open onClose={() => {}}>
        <div data-testid="bottom-modal-marker">bottom</div>
      </Modal>,
    );
    // Single modal: its own anchor resolves.
    expect(anchorOwner()).toBe("bottom");

    // Stack a second modal on top (mounted after → registered later → topmost).
    render(
      <Modal open onClose={() => {}}>
        <div data-testid="top-modal-marker">top</div>
      </Modal>,
    );
    // Pre-fix: Modal never registered, getElementById returns DOM-first =
    // the BOTTOM modal's anchor → "bottom". Post-fix: the stack's topmost
    // registered anchor = the TOP modal's.
    expect(anchorOwner()).toBe("top");
    cleanup();
  });

  it("closing the top modal pops it off the overlay stack", async () => {
    const bottom = render(
      <Modal open onClose={() => {}}>
        <div data-testid="bottom-modal-marker">bottom</div>
      </Modal>,
    );
    const top = render(
      <Modal open onClose={() => {}}>
        <div data-testid="top-modal-marker">top</div>
      </Modal>,
    );
    expect(anchorOwner()).toBe("top");

    await act(async () => {
      top.rerender(
        <Modal open={false} onClose={() => {}}>
          <div data-testid="top-modal-marker">top</div>
        </Modal>,
      );
    });
    // The top modal's portal unmounted and unregistered; the bottom modal's
    // anchor must resolve again. (A stale detached anchor left on the stack
    // is pruned by getTopmostOverlayPortal's isConnected walk.)
    expect(anchorOwner()).toBe("bottom");

    await act(async () => {
      bottom.rerender(
        <Modal open={false} onClose={() => {}}>
          <div data-testid="bottom-modal-marker">bottom</div>
        </Modal>,
      );
    });
    // No overlay open: nothing registered; the getElementById fallback finds
    // no mounted #modal-portal at all.
    expect(getModalPortal()).toBeNull();
    cleanup();
  });
});
