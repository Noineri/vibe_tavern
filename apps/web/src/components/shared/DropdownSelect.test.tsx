/**
 * DropdownSelect keyboard-nav characterization test.
 *
 * Pins the contract that the cmdk + Radix Popover rewrite restored: arrow keys
 * move the active (data-selected) item while the search input keeps focus, in
 * both searchable and non-searchable modes. The previous Radix Select + nested
 * <input> implementation could not do this (blurring the input to hand off to
 * Radix's focus-roving items sent focus to <body>, so ArrowUp/Down were no-ops).
 *
 * STATUS: skipped under bun:test + happy-dom. Radix Popover.Content is mounted
 * via a Popper that positions through getBoundingClientRect; in happy-dom every
 * element reports a 0x0 box, so the content never anchors and never mounts, so
 * the [cmdk-list] / [cmdk-item] selectors below never resolve. This is the SAME
 * limitation already accepted for Radix RovingFocusGroup arrow-navigation (the
 * Toggle/ToggleChips/SegmentedControl migration) — keyboard behavior that rides
 * on real layout cannot be asserted in a 0x0 DOM. The tests are kept (not
 * deleted) as living documentation of the contract and are covered instead by
 * manual browser verification (open dropdown, ArrowUp/Down moves the highlighted
 * row, input keeps focus in searchable mode). To exercise them against a real
 * DOM, run the file under a jsdom/playwright runner with non-zero layout.
 */
import { describe, it, expect } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import { DropdownSelect } from "./DropdownSelect.js";

useDomEnv();

const threeOptions = [
	{ id: "a", label: "Apple" },
	{ id: "b", label: "Banana" },
	{ id: "c", label: "Cherry" },
];

/** Open the dropdown and return the command input (searchable) or the command
 *  root (non-searchable) — whichever element drives keyboard nav. */
async function openDropdown(container: HTMLElement) {
	const trigger = container.querySelector("button")!;
	fireEvent.click(trigger);
	// Radix Popover.Content mounts after open; wait for the list.
	await waitFor(() => {
		expect(container.ownerDocument.querySelector("[cmdk-list]")).toBeTruthy();
	});
	const doc = container.ownerDocument;
	const input = doc.querySelector("[cmdk-input]") as HTMLInputElement | null;
	const command = doc.querySelector("[cmdk-root]") as HTMLElement;
	return { input, command, doc };
}

function activeItemLabel(doc: Document): string | null {
	const el = doc.querySelector("[cmdk-item][data-selected='true'] [cmdk-item-text], [cmdk-item][aria-selected='true']");
	// Fall back to textContent of the data-selected item itself.
	const sel = doc.querySelector("[cmdk-item][data-selected='true']") as HTMLElement | null;
	return sel?.textContent ?? null;
}

describe.skip("DropdownSelect keyboard navigation (manual — see header)", () => {
	it("searchable: ArrowDown moves the active item while input keeps focus", async () => {
		const { container } = render(
			<DropdownSelect value="" options={threeOptions} onChange={() => {}} />,
		);
		const { input, doc } = await openDropdown(container);

		// cmdk auto-activates the first item on open.
		await waitFor(() => expect(activeItemLabel(doc)).toContain("Apple"));

		if (!input) throw new Error("Command.Input not rendered");
		// ArrowDown must move active to the second item, NOT be a no-op.
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await waitFor(() => expect(activeItemLabel(doc)).toContain("Banana"));

		// Input must still hold focus so typing ↔ arrow ↔ typing works.
		expect(doc.activeElement).toBe(input);
	});

	it("non-searchable: ArrowDown/Up navigate from the Command root", async () => {
		const { container } = render(
			<DropdownSelect value="" options={threeOptions} searchable={false} onChange={() => {}} />,
		);
		const { command, doc } = await openDropdown(container);

		await waitFor(() => expect(activeItemLabel(doc)).toContain("Apple"));

		fireEvent.keyDown(command, { key: "ArrowDown" });
		await waitFor(() => expect(activeItemLabel(doc)).toContain("Banana"));

		fireEvent.keyDown(command, { key: "ArrowUp" });
		await waitFor(() => expect(activeItemLabel(doc)).toContain("Apple"));
	});
});
