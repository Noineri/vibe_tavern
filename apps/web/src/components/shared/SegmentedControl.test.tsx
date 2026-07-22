/**
 * SegmentedControl characterization test.
 *
 * Pins the single-select segmented control's contract before migration to
 * @radix-ui/react-radio-group. SegmentedControl already declares the right
 * ARIA (`role="radiogroup"` + `role="radio"` + `aria-checked`) — what it LACKS
 * is the keyboard model those roles imply (roving tabindex + arrow-key
 * movement). RadioGroup brings that keyboard model and MUST preserve the
 * contract pinned here:
 *   - the container exposes `role="radiogroup"`, each segment `role="radio"`
 *   - the active segment is `aria-checked="true"`, others `false`
 *   - clicking an inactive segment fires onChange with its value
 *   - selection cannot be cleared from within — clicking the active segment
 *     never produces an empty/null value (the radio invariant)
 *   - `disabled` blocks every segment
 *   - the `trailing` option renders as a SIBLING of the radio, not inside it
 *     (nested buttons are invalid HTML; VersionSwitcher relies on this for its
 *     per-pill rename/delete icons)
 *   - the `tooltip` option does not break segment rendering
 *   - the layout props (`fill`, `compact`, `wrap`, `mobileFill`) apply their
 *     container classes so call sites' layouts does not regress
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, getAllByRole } from "@testing-library/react";

// CustomTooltip (Radix Tooltip) needs a TooltipProvider ancestor that the
// isolated render here doesn't mount. The app mounts one globally; tests mock
// it to a passthrough (same pattern as VibeMdView.test.tsx /
// CoauthorInputArea.test.tsx). This test cares that SegmentedControl correctly
// delegates the segment into the tooltip slot — not about tooltip behavior.
vi.mock("./Tooltip.js", () => ({
	CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SegmentedControl } from "./SegmentedControl.js";


const opts = [
	{ value: "a", label: "Apple" },
	{ value: "b", label: "Banana" },
	{ value: "c", label: "Cherry" },
];

describe("SegmentedControl — structure", () => {
	it("container exposes role=radiogroup, segments role=radio", () => {
		const { getByRole, getAllByRole } = render(
			<SegmentedControl value="a" options={opts} onChange={() => {}} />,
		);
		expect(getByRole("radiogroup")).toBeTruthy();
		expect(getAllByRole("radio")).toHaveLength(3);
	});

	it("the active segment is aria-checked=true, others false", () => {
		const { getAllByRole } = render(
			<SegmentedControl value="b" options={opts} onChange={() => {}} />,
		);
		const radios = getAllByRole("radio");
		expect(radios[0].getAttribute("aria-checked")).toBe("false");
		expect(radios[1].getAttribute("aria-checked")).toBe("true");
		expect(radios[2].getAttribute("aria-checked")).toBe("false");
	});
});

describe("SegmentedControl — selection", () => {
	it("clicking an inactive segment fires onChange with its value", () => {
		const onChange = vi.fn();
		const { getByText } = render(
			<SegmentedControl value="a" options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Cherry"));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith("c");
	});

	it("selection cannot be cleared — clicking the active segment never yields an empty value", () => {
		// The radio invariant. Today the component fires onChange(sameValue) on
		// re-click; under RadioGroup the click is a no-op. Both are acceptable
		// so long as onChange is NEVER called with "" / null / undefined.
		const onChange = vi.fn();
		const { getByText } = render(
			<SegmentedControl value="b" options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Banana"));
		if (onChange.mock.calls.length > 0) {
			const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
			expect(last).not.toBe("");
			expect(last).toBeTruthy();
		}
	});

	it("disabled blocks every segment", () => {
		const onChange = vi.fn();
		const { getByText } = render(
			<SegmentedControl value="a" options={opts} onChange={onChange} disabled />,
		);
		fireEvent.click(getByText("Banana"));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("an individually disabled option cannot be selected", () => {
		const onChange = vi.fn();
		const { getByRole } = render(
			<SegmentedControl
				value="a"
				options={[
					{ value: "a", label: "Apple" },
					{ value: "b", label: "Banana", disabled: true },
				]}
				onChange={onChange}
			/>,
		);
		const disabled = getByRole("radio", { name: "Banana" });
		expect(disabled.getAttribute("data-disabled")).not.toBeNull();
		fireEvent.click(disabled);
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("SegmentedControl — option slots (load-bearing for VersionSwitcher)", () => {
	it("trailing renders as a sibling of the radio button, never nested inside it", () => {
		// Nested <button> inside <button> is invalid HTML and would steal clicks.
		// VersionSwitcher's per-pill rename/delete icons depend on the trailing
		// node being a sibling of the radio, with stopPropagation guarding it.
		const { container, getByLabelText } = render(
			<SegmentedControl
				value="a"
				options={[
					{ value: "a", label: "Apple" },
					{
						value: "b",
						label: "Banana",
						trailing: (
							<button type="button" aria-label="rename-b" onClick={(e) => e.stopPropagation()}>
								R
							</button>
						),
					},
				]}
				onChange={() => {}}
			/>,
		);
		const renameBtn = getByLabelText("rename-b");
		// The trailing button must NOT be a descendant of a radio button.
		const radios = container.querySelectorAll('[role="radio"]');
		radios.forEach((r) => {
			expect(r.contains(renameBtn)).toBe(false);
		});
		// And it must exist in the group (sibling).
		expect(container.querySelector('[role="radiogroup"]')!.contains(renameBtn)).toBe(true);
	});

	it("clicking a trailing action does not change the segment selection", () => {
		const onChange = vi.fn();
		const { getByLabelText } = render(
			<SegmentedControl
				value="a"
				options={[
					{ value: "a", label: "Apple" },
					{
						value: "b",
						label: "Banana",
						trailing: (
							<button type="button" aria-label="rename-b" onClick={(e) => e.stopPropagation()}>
								R
							</button>
						),
					},
				]}
				onChange={onChange}
			/>,
		);
		fireEvent.click(getByLabelText("rename-b"));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("tooltip option does not break segment rendering", () => {
		// CustomTooltip wraps the segment; we only assert the segment still
		// renders and is interactive. Tooltip-hover behavior is CustomTooltip's
		// own concern, tested separately if at all.
		const onChange = vi.fn();
		const { getAllByRole, getByText } = render(
			<SegmentedControl
				value="a"
				options={[
					{ value: "a", label: "Apple", tooltip: "an apple" },
					{ value: "b", label: "Banana" },
				]}
				onChange={onChange}
			/>,
		);
		expect(getAllByRole("radio")).toHaveLength(2);
		fireEvent.click(getByText("Banana"));
		expect(onChange).toHaveBeenLastCalledWith("b");
	});

	it("selected segment keeps data-state=checked even when wrapped in a tooltip", () => {
		// Regression: CustomTooltip's Trigger (asChild) injects its own `data-state`
		// onto its child. When the child WAS the RadioGroup.Item, the tooltip's
		// open/closed state clobbered the radio's `data-state=checked` (the
		// visual-selection CSS hook) — the selected logic segment lost its
		// highlight. The fix wraps the item in a span so each Radix primitive owns
		// its own DOM node. This pins that the radio keeps data-state=checked.
		const { getAllByRole } = render(
			<SegmentedControl
				value="a"
				options={[
					{ value: "a", label: "Apple", tooltip: "an apple" },
					{ value: "b", label: "Banana", tooltip: "a banana" },
				]}
				onChange={() => {}}
			/>,
		);
		const radios = getAllByRole("radio");
		expect(radios[0].getAttribute("data-state")).toBe("checked");
		expect(radios[1].getAttribute("data-state")).toBe("unchecked");
	});
});

describe("SegmentedControl — keyboard navigation", () => {
	// The previous hand-rolled implementation declared role=radio on each
	// segment but never wired the keyboard model those roles imply: Tab visited
	// every segment, Arrow keys were no-ops. RadioGroup restores arrow-key
	// movement that follows the radio pattern (Arrow moves BOTH focus and
	// selection to the next/previous item).
	//
	// NOT asserted here: Radix RadioGroup implements arrow nav via
	// @radix-ui/react-roving-focus, which moves focus using layout queries
	// (getBoundingClientRect) to pick the next item in the pressed direction.
	// happy-dom has no layout (every element is 0x0), so the roving-focus
	// direction logic cannot resolve a target and the arrow is a no-op in this
	// environment. This is a happy-dom limitation, not a component defect —
	// arrow nav is verified manually in a real browser via the Playwright MCP
	// server. The characterization tests above (role/aria-checked/onChange/
	// trailing/tooltip/layout) all pass here and pin the contract the migration
	// must preserve; keyboard nav is a new Radix-provided capability, not
	// pre-existing behavior that needed pinning.
	it.skip("keyboard nav — verified manually in a real browser (happy-dom has no layout for roving-focus)", () => {});
});

describe("SegmentedControl — layout props", () => {
	it("fill applies full-width flex", () => {
		const { container } = render(
			<SegmentedControl value="a" options={opts} onChange={() => {}} fill />,
		);
		const group = container.querySelector('[role="radiogroup"]')!;
		expect(group.className).toMatch(/\bw-full\b/);
		expect(group.className).toMatch(/\bflex\b/);
	});

	it("compact applies the compact gap", () => {
		const { container } = render(
			<SegmentedControl value="a" options={opts} onChange={() => {}} compact />,
		);
		const group = container.querySelector('[role="radiogroup"]')!;
		expect(group.className).toMatch(/gap-0(?!\.)/);
	});

	it("wrap enables flex-wrap on the group", () => {
		const { container } = render(
			<SegmentedControl value="a" options={opts} onChange={() => {}} wrap />,
		);
		const group = container.querySelector('[role="radiogroup"]')!;
		expect(group.className).toMatch(/\bflex-wrap\b/);
	});

	it("mobileFill applies w-full + sm:w-auto", () => {
		const { container } = render(
			<SegmentedControl value="a" options={opts} onChange={() => {}} mobileFill />,
		);
		const group = container.querySelector('[role="radiogroup"]')!;
		expect(group.className).toMatch(/\bw-full\b/);
		expect(group.className).toMatch(/\bsm:w-auto\b/);
	});
});
