/**
 * BottomSheet characterization test.
 *
 * Pins the behavioral contract of the mobile bottom sheet BEFORE the migration
 * to vaul (Drawer.Root + Overlay + Content + Handle + Title). The migration
 * replaces the hand-rolled scrim + slideUp + manual swipe-to-dismiss with
 * vaul's Radix-Dialog-backed implementation, but must NOT change the contract:
 *   - open=false renders nothing; open=true mounts the sheet (via portal)
 *   - the sheet surfaces its `title` (when passed) and its `children`
 *   - tapping the scrim fires onClose; tapping the sheet body does NOT
 *   - swiping the sheet down past the ~80px threshold fires onClose; a short
 *     swipe and an upward swipe do NOT
 *
 * What is deliberately NOT pinned (and will change under vaul): the DOM tag
 * shape (a fragment of two fixed divs today → Drawer.Overlay + Drawer.Content
 * after), the inline touch handlers (deleted — vaul owns the drag), and the
 * absence of role="dialog" (vaul adds it). Selectors below target the CHROME
 * classes carried over verbatim to the vaul wrapper (`.inset-0` scrim,
 * `.glass-blur` content), so they survive the swap.
 *
 * Swipe IS unit-testable here (unlike Radix roving-focus): the current logic
 * reads touches[0].clientY directly — no getBoundingClientRect involved — so
 * happy-dom's 0x0 layout does not block the gesture. After the vaul swap the
 * gesture tests are expected to retire to manual verification (vaul drives drag
 * via pointer/animation listeners that happy-dom cannot dispatch realistically),
 * but pinning the 80px-threshold contract now is what catches a drift if the
 * new wrapper ever re-implements swipe manually.
 */
import { describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";
import { BottomSheet } from "./BottomSheet.js";

useDomEnv();

/** Scrim overlay — `.inset-0` (full-screen fixed) is unique to the scrim; the
 *  sheet uses `inset-x-0 bottom-0`. Carried over verbatim to Drawer.Overlay. */
function scrimEl(doc: Document): HTMLElement {
	const el = doc.querySelector<HTMLElement>(".inset-0");
	if (!el) throw new Error("scrim (.inset-0) not rendered");
	return el;
}

/** Sheet content — `.glass-blur` is the shared chrome class carried over to
 *  Drawer.Content. */
function sheetEl(doc: Document): HTMLElement {
	const el = doc.querySelector<HTMLElement>(".glass-blur");
	if (!el) throw new Error("sheet (.glass-blur) not rendered");
	return el;
}

describe("BottomSheet", () => {
	it("open=false renders nothing", () => {
		render(<BottomSheet open={false} onClose={() => {}}><span>BODY</span></BottomSheet>);
		expect(document.body.textContent).not.toContain("BODY");
		expect(document.querySelector(".glass-blur")).toBeNull();
	});

	it("open=true renders the sheet with children", () => {
		render(<BottomSheet open={true} onClose={() => {}}><span>SHEETBODY</span></BottomSheet>);
		expect(document.body.textContent).toContain("SHEETBODY");
		expect(sheetEl(document)).toBeTruthy();
	});

	it("renders the title when passed", () => {
		render(<BottomSheet open={true} onClose={() => {}} title="My Sheet Title"><span>x</span></BottomSheet>);
		expect(document.body.textContent).toContain("My Sheet Title");
	});

	it("omits the title slot when title is not passed", () => {
		// A header-less sheet must not render an empty title block. The title
		// row is conditional on `title != null`; the only text in the sheet
		// should be the children, with no stray `.text-t1` title span.
		render(<BottomSheet open={true} onClose={() => {}}><span>ONLYCHILDREN</span></BottomSheet>);
		expect(document.body.textContent).toContain("ONLYCHILDREN");
		expect(sheetEl(document).querySelector(".text-t1")).toBeNull();
	});

	it("tapping the scrim fires onClose", () => {
		const onClose = mock(() => {});
		render(<BottomSheet open={true} onClose={onClose}><span>x</span></BottomSheet>);
		fireEvent.click(scrimEl(document));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("tapping the sheet body does NOT fire onClose", () => {
		// Interacting with the content must not dismiss. The scrim and the sheet
		// are sibling elements today, so a click on the sheet cannot reach the
		// scrim's onClick. The vaul wrapper preserves this (Drawer.Content stops
		// the dismissal that Drawer.Overlay would trigger).
		const onClose = mock(() => {});
		render(<BottomSheet open={true} onClose={onClose}><span>x</span></BottomSheet>);
		fireEvent.click(sheetEl(document));
		expect(onClose).not.toHaveBeenCalled();
	});

	it("swiping down past the ~80px threshold fires onClose", () => {
		const onClose = mock(() => {});
		render(<BottomSheet open={true} onClose={onClose}><span>x</span></BottomSheet>);
		const sheet = sheetEl(document);
		fireEvent.touchStart(sheet, { touches: [{ clientY: 500 }] });
		fireEvent.touchMove(sheet, { touches: [{ clientY: 610 }] }); // delta +110 > 80
		fireEvent.touchEnd(sheet);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("a short downward swipe does NOT fire onClose", () => {
		const onClose = mock(() => {});
		render(<BottomSheet open={true} onClose={onClose}><span>x</span></BottomSheet>);
		const sheet = sheetEl(document);
		fireEvent.touchStart(sheet, { touches: [{ clientY: 500 }] });
		fireEvent.touchMove(sheet, { touches: [{ clientY: 540 }] }); // delta +40 < 80
		fireEvent.touchEnd(sheet);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("an upward swipe does NOT fire onClose", () => {
		const onClose = mock(() => {});
		render(<BottomSheet open={true} onClose={onClose}><span>x</span></BottomSheet>);
		const sheet = sheetEl(document);
		fireEvent.touchStart(sheet, { touches: [{ clientY: 500 }] });
		fireEvent.touchMove(sheet, { touches: [{ clientY: 400 }] }); // delta -100 (upward)
		fireEvent.touchEnd(sheet);
		expect(onClose).not.toHaveBeenCalled();
	});
});
