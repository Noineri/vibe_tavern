/**
 * Toast-under-modal-scrim regression pin (owner-reported UX defect: an error
 * toast fired inside an open modal painted BEHIND the modal scrim — «тост под
 * затемнением модалки», invisible or half-glimpsed).
 *
 * Mechanism (NOT a sonner z-index shortage): #root carries
 * `position:relative;z-index:1` (styles.css — it must paint above the lava
 * canvas portaled to <body> at z-index:0), which makes #root a STACKING
 * CONTEXT. An inline Toaster renders inside that context, so the whole app
 * subtree — sonner's z-index:999999999 viewport included — paints at #root's
 * z≈1, UNDER every overlay that portals to <body> (shared Modal z-[500]
 * overlay / z-[501] content, MediaModal z-[700]). Mounting the toaster
 * through a <body> portal restores what the styles.css comment already
 * assumed ("portaled modals/toasts (body children) still stack above both").
 *
 * Pinned at the DOM boundary, mirroring modal-portal-stacking.test.tsx: the
 * sonner viewport must be a DIRECT child of <body> — a sibling of the Radix
 * dialog portals — so its own z-index applies in the root stacking context,
 * and that z must clear the app's highest overlay layer. (Sonner's fixed
 * layer is the `<ol data-sonner-toaster>` INSIDE the Toaster's section, and
 * it only mounts once a toast is fired — hence the fired toast below.)
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { act, render } = await import("@testing-library/react");
const { toast } = await import("sonner");
const { AppToaster } = await import("./AppToaster.js");
const { Modal } = await import("../shared/Modal.js");

/** The app's highest overlay layer (survey of apps/web/src): MediaModal's
 *  fullscreen viewer rides `z-[700]`; the shared Modal is z-[500] overlay /
 *  z-[501] content; the destructive confirms render no z-[700] overlay at all
 *  (`hideOverlay` skips Dialog.Overlay, so their `overlayClassName="z-[700]"`
 *  is inert and they ride z-[501]). A body-level toaster clears all of these
 *  once its own z-index beats 700. */
const HIGHEST_OVERLAY_Z = 700;

/** Sonner's toast pipeline settles on macrotask ticks (publish → Toaster
 *  subscription → render). Bounded poll, in the spirit of dom-env's
 *  flushSchedulerQueue: 10 ticks × 10ms, breaking the moment the viewport
 *  mounts. */
async function settleToasterViewport(): Promise<HTMLElement | null> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const ol = document.querySelector("[data-sonner-toaster]");
    if (ol) return ol as HTMLElement;
  }
  return null;
}

describe("AppToaster mounts above every modal overlay", () => {
  let toastId: string | number = "";

  afterEach(() => {
    // The mirror-#root div is created manually, outside RTL's tracking —
    // remove it so the process DOM (shared across files in a worker) stays
    // clean even when an assertion above throws.
    document.getElementById("app-toaster-test-root")?.remove();
  });

  afterAll(async () => {
    // Sonner's toast store is module-global: dismiss the fired toast so a
    // later file in this shared worker never sees a ghost "boom" toast.
    if (toastId !== "") toast.dismiss(toastId);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  it("the sonner viewport is a <body> child — outside #root's stacking context — and clears the highest overlay z", async () => {
    // Mirror the production root: styles.css `#root{position:relative;z-index:1}`
    // — the stacking context that traps inline fixed descendants below every
    // body-level overlay.
    const root = document.createElement("div");
    root.id = "app-toaster-test-root";
    root.style.position = "relative";
    root.style.zIndex = "1";
    document.body.appendChild(root);

    render(
      <>
        <AppToaster />
        {/* A real open Modal — Radix portals overlay+content to <body>,
            exactly the layers an in-modal error toast must paint above. */}
        <Modal open onClose={() => {}}>
          <div>modal body</div>
        </Modal>
      </>,
      { container: root },
    );

    // The in-modal failure path: an error toast fires while the modal is open.
    await act(async () => {
      toastId = toast.error("boom");
    });
    const ol = await settleToasterViewport();
    expect(ol).not.toBeNull();

    // The Radix dialog portal is a <body> child (Radix Dialog.Portal default).
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.closest("#app-toaster-test-root")).toBeNull();

    // THE boundary: the toaster's section (ol → section → parent) is a direct
    // <body> child — a sibling of the dialog portals, in the ROOT stacking
    // context. Pre-fix the section stayed inside #root and its 999999999 was
    // trapped under every z≥500 overlay.
    const section = ol!.parentElement;
    expect(section!.parentElement).toBe(document.body);

    // Same stacking context as the modal portals, so the z comparison is
    // meaningful: sonner's injected `[data-sonner-toaster]{z-index:…}` rule
    // must beat the app's highest overlay layer.
    const toasterZ = Number(window.getComputedStyle(ol!).zIndex);
    expect(toasterZ).toBeGreaterThan(HIGHEST_OVERLAY_Z);
  });
});
