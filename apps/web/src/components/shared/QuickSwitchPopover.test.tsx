/**
 * QuickSwitchPopover — desktop popover scroll-boundary pin (CNR-8e).
 *
 * This surface had no suite of its own; this file pins the desktop popover's
 * list scroll wiring (the mobile half is a separate BottomSheet list that is
 * out of this migration's scope). Boundary: the item list scrolls internally
 * on the shared thin ScrollArea lane under a cap on its root, while the title
 * header and footer row stay fixed (CNR-8e).
 */
import { describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// RTL loads AFTER the DOM registration (dom-env contract).
const { render, fireEvent, act, waitFor, within } = await import("@testing-library/react");
const { QuickSwitchPopover } = await import("./QuickSwitchPopover.js");
const { popoverMaxHeight } = await import("./popover-constants.js");

const items = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
	{ value: "c", label: "Cory" },
];

function renderPopoverOpen(props: Record<string, unknown> = {}) {
	const view = render(
		<QuickSwitchPopover
			trigger={<button type="button" data-testid="qsw-trigger">Switch</button>}
			title="Pick one"
			items={items}
			value="a"
			onSelect={mock()}
			{...props}
		/>,
	);
	const btn = view.getByTestId("qsw-trigger");
	act(() => {
		fireEvent.pointerDown(btn);
		fireEvent.click(btn);
	});
	return view;
}

describe("QuickSwitchPopover — desktop popover list scroll boundary", () => {
	it("the item list is the only internal scroller, capped at the singleLine row budget", async () => {
		renderPopoverOpen();
		const popper = await waitFor(() => {
			const el = document.body.querySelector("[data-radix-popper-content-wrapper]");
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		// Rows render inside the popover; the selected row carries data-active.
		const alphaBtn = within(popper).getByText("Alpha").closest("button")!;
		const betaBtn = within(popper).getByText("Beta").closest("button")!;
		expect(alphaBtn.getAttribute("data-active")).toBe("true");
		expect(betaBtn.getAttribute("data-active")).toBe("false");
		// CNR-8e: the list scrolls on the shared thin ScrollArea lane (variant
		// marker + vertical track on the root; the 3/5px geometry itself lives in
		// styles.css, pinned by scroll-area.test.tsx); the ~6-row cap sits on the
		// ScrollArea root. The header and footer sit outside it.
		const scroller = betaBtn.closest("[data-scroll-area]") as HTMLElement | null;
		if (!scroller) throw new Error("ScrollArea root not rendered");
		expect(scroller.getAttribute("data-scroll-area")).toBe("thin");
		expect(scroller.querySelector("[data-scroll-viewport]")?.classList.contains("scrollbar-hide")).toBe(true);
		expect(scroller.style.maxHeight).toBe(`${popoverMaxHeight("singleLine")}px`);
		// Rows ride the scroll content; their px-4 padding scrolls with them.
		expect(scroller.querySelector("[data-scroll-content]")?.contains(betaBtn)).toBe(true);
		// Base UI mounts a scrollbar lazily (only once overflow is observed);
		// happy-dom has no layout, so fake the measurement the same way
		// scroll-area.test.tsx does, then pin the lane orientation.
		const viewport = scroller.querySelector<HTMLElement>("[data-scroll-viewport]")!;
		Object.defineProperties(viewport, {
			clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
			clientWidth: { value: 200 }, scrollWidth: { value: 200 },
		});
		await act(async () => {
			viewport.scrollTop = 200;
			fireEvent.scroll(viewport);
		});
		await waitFor(() => expect(scroller.querySelector("[data-scroll-thumb]")).not.toBeNull());
		expect(scroller.querySelector("[data-scroll-track]")?.getAttribute("data-orientation")).toBe("vertical");
	});

	it("empty items render the empty text without the list scroller", async () => {
		renderPopoverOpen({ items: [], emptyText: "Nothing here" });
		const popper = await waitFor(() => {
			const el = document.body.querySelector("[data-radix-popper-content-wrapper]");
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		expect(within(popper).getByText("Nothing here")).toBeTruthy();
		expect(within(popper).queryByText("Beta")).toBeNull();
	});
});
