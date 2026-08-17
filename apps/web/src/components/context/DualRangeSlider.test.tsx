/**
 * DualRangeSlider — from/to invariant + wrapper-driven pointer interaction.
 *
 * The slider exposes two overlapping range inputs (`dual-range-l` = lower/from,
 * `dual-range-u` = upper/to). The invariant: dragging `from` up never crosses
 * `to`, dragging `to` down never crosses `from`, and both clamp to [min,max].
 * Pinned because a sign-flip or swapped safeFrom/safeTo would silently break
 * selection.
 *
 * The pointer suite pins the Firefox fix: dragging must be driven by the
 * WRAPPER, never by per-thumb hit-testing. Making each thumb its own hit target
 * needs `::-webkit-slider-thumb{pointer-events:auto}` under a
 * `pointer-events:none` host — Firefox ignores that on `::-moz-range-thumb`, so
 * the whole control went dead there. These tests dispatch on the wrapper and
 * never touch an input, which is exactly what a browser without thumb
 * hit-testing does.
 *
 * Plain <input type="range"> (no Radix), so happy-dom's 0x0 layout is fine for
 * the invariant suite — unlike the Radix-Popover DropdownSelect keyboard test,
 * which is skipped. The pointer suite stubs the wrapper's box, since happy-dom
 * has no layout of its own.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");

let DualRangeSlider: typeof import("./DualRangeSlider.js").DualRangeSlider;

beforeAll(async () => {
	({ DualRangeSlider } = await import("./DualRangeSlider.js"));
});

function setup(props: { from: number; to: number; min?: number; max?: number }) {
	const onChange = mock();
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
		const { onChange, lower } = setup({ from: 3, to: 7 });
		fireEvent.change(lower, { target: { value: "8" } });
		expect(onChange).toHaveBeenCalledWith(7, 7);
	});

	it("dragging `to` below `from` clamps to `from` (to never goes below from)", () => {
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
		const { onChange, lower, upper } = setup({ from: 3, to: 7, min: 1, max: 10 });
		fireEvent.change(lower, { target: { value: "0" } });
		expect(onChange).toHaveBeenLastCalledWith(1, 7);
		fireEvent.change(upper, { target: { value: "20" } });
		expect(onChange).toHaveBeenLastCalledWith(3, 10);
	});

	it("min === max (degenerate single-message range) renders without throwing and pins both thumbs", () => {
		// Guards the ratio divide-by-zero (max > min ? … : 0). Value is already
		// at the only legal bound, so React does not fire onChange for a no-op
		// change — assert the render + bound value instead.
		const { lower, upper } = setup({ from: 1, to: 1, min: 1, max: 1 });
		expect(lower.value).toBe("1");
		expect(upper.value).toBe("1");
	});
});

/**
 * 216px box − 16px thumb = 200px of travel across min..max = 1..101, i.e. one
 * message every 2px. Thumb centre for value v sits at `8 + (v - 1) * 2`, so
 * clientX 88 → 41 and clientX 148 → 71.
 */
const TRACK_WIDTH = 216;

function setupPointer(props: { from: number; to: number; disabled?: boolean }) {
	const onChange = mock();
	const { container } = render(
		<DualRangeSlider
			min={1}
			max={101}
			from={props.from}
			to={props.to}
			disabled={props.disabled}
			onChange={onChange}
		/>,
	);
	const track = container.querySelector(".dual-range-l")?.parentElement;
	if (!track) throw new Error("wrapper not found");
	// happy-dom has no layout engine, so the wrapper measures 0x0 and every
	// pointer position would clamp to `min`. Stub the box the component reads.
	track.getBoundingClientRect = () => new DOMRect(0, 0, TRACK_WIDTH, 20);
	return { onChange, track };
}

describe("DualRangeSlider — wrapper-driven pointer interaction", () => {
	it("pointerdown near the lower thumb drags `from`, not the topmost input", () => {
		// `dual-range-u` is the z-3 input covering the whole track. If the wrapper
		// did not pick the handle itself, this press would move `to`.
		const { onChange, track } = setupPointer({ from: 21, to: 81 });
		fireEvent.pointerDown(track, { clientX: 88, button: 0, pointerId: 1 });
		expect(onChange).toHaveBeenCalledWith(41, 81);
	});

	it("pointerdown near the upper thumb drags `to`", () => {
		const { onChange, track } = setupPointer({ from: 21, to: 81 });
		fireEvent.pointerDown(track, { clientX: 148, button: 0, pointerId: 1 });
		expect(onChange).toHaveBeenCalledWith(21, 71);
	});

	it("ignores the pointer while disabled", () => {
		// The old shape got this from the inputs' `disabled` attribute; a
		// wrapper-driven press has to re-check it or the range stays draggable
		// mid-generation.
		const { onChange, track } = setupPointer({ from: 21, to: 81, disabled: true });
		fireEvent.pointerDown(track, { clientX: 88, button: 0, pointerId: 1 });
		fireEvent.pointerMove(track, { clientX: 148, pointerId: 1 });
		expect(onChange).not.toHaveBeenCalled();
	});
});
