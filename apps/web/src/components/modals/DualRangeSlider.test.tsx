/**
 * DualRangeSlider — from/to invariant (characterization).
 *
 * The slider exposes two overlapping range inputs (`dual-range-l` = lower/from,
 * `dual-range-u` = upper/to). The invariant the extraction must preserve:
 * dragging `from` up never crosses `to`, dragging `to` down never crosses
 * `from`, and both clamp to [min,max]. Pinned because the clamp/handle math
 * moves verbatim to components/context/DualRangeSlider.tsx (step 3) and a
 * sign-flip or swapped safeFrom/safeTo would silently break selection.
 *
 * Plain <input type="range"> (no Radix), so happy-dom's 0x0 layout is fine —
 * unlike the Radix-Popover DropdownSelect keyboard test, which is skipped here.
 */
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DualRangeSlider } from "./ContextMemoryModal.js";

function setup(props: { from: number; to: number; min?: number; max?: number }) {
	const onChange = vi.fn();
	const { container } = render(
		<DualRangeSlider
			min={props.min ?? 1}
			max={props.max ?? 10}
			from={props.from}
			to={props.to}
			onChange={onChange}
		/>,
	);
	const lower = container.querySelector(".dual-range-l") as HTMLInputElement;
	const upper = container.querySelector(".dual-range-u") as HTMLInputElement;
	return { onChange, lower, upper };
}

describe("DualRangeSlider — from/to invariant", () => {
	it("dragging `from` above `to` clamps to `to` (from never exceeds to)", () => {
		// from=3, to=7; drag from → 8: onChange reports (7, 7), not (8, 7).
		const { onChange, lower } = setup({ from: 3, to: 7 });
		fireEvent.change(lower, { target: { value: "8" } });
		expect(onChange).toHaveBeenCalledWith(7, 7);
	});

	it("dragging `to` below `from` clamps to `from` (to never goes below from)", () => {
		// from=3, to=7; drag to → 2: onChange reports (3, 3), not (3, 2).
		const { onChange, upper } = setup({ from: 3, to: 7 });
		fireEvent.change(upper, { target: { value: "2" } });
		expect(onChange).toHaveBeenCalledWith(3, 3);
	});

	it("dragging `from`/`to` within bounds passes the value through unchanged", () => {
		const { onChange, lower, upper } = setup({ from: 3, to: 7 });
		fireEvent.change(lower, { target: { value: "5" } });
		expect(onChange).toHaveBeenLastCalledWith(5, 7);
		fireEvent.change(upper, { target: { value: "9" } });
		expect(onChange).toHaveBeenLastCalledWith(3, 9);
	});

	it("clamps out-of-range values to [min, max]", () => {
		// from below min → clamps to min(1); to above max → clamps to max(10).
		const { onChange, lower, upper } = setup({ from: 3, to: 7, min: 1, max: 10 });
		fireEvent.change(lower, { target: { value: "0" } });
		expect(onChange).toHaveBeenLastCalledWith(1, 7);
		fireEvent.change(upper, { target: { value: "20" } });
		expect(onChange).toHaveBeenLastCalledWith(3, 10);
	});

	it("min === max (degenerate single-message range) renders without throwing and pins both thumbs", () => {
		// Guards the trackPct divide-by-zero (max > min ? … : 0). Value is already
		// at the only legal bound, so React does not fire onChange for a no-op
		// change — assert the render + bound value instead.
		const { lower, upper } = setup({ from: 1, to: 1, min: 1, max: 1 });
		expect(lower.value).toBe("1");
		expect(upper.value).toBe("1");
	});
});
