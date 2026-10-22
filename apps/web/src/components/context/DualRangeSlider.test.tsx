/**
 * DualRangeSlider — controlled from/to invariants at the shared Slider seam.
 *
 * Base UI owns geometric pointer routing; happy-dom drives the real nested
 * range inputs instead. The public callback continues to expose two arguments.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");

let DualRangeSlider: typeof import("./DualRangeSlider.js").DualRangeSlider;

beforeAll(async () => {
	({ DualRangeSlider } = await import("./DualRangeSlider.js"));
});

function setup(props: { from: number; to: number; min?: number; max?: number; disabled?: boolean }) {
	const onChange = mock();
	const { container } = render(
		<DualRangeSlider
			min={props.min ?? 1}
			max={props.max ?? 10}
			from={props.from}
			to={props.to}
			disabled={props.disabled}
			onChange={onChange}
		/>,
	);
	const start = container.querySelector<HTMLInputElement>("[data-testid=\"range-start-input\"]");
	const end = container.querySelector<HTMLInputElement>("[data-testid=\"range-end-input\"]");
	if (!start || !end) throw new Error("Missing nested range inputs");
	return { container, onChange, start, end };
}

describe("DualRangeSlider — shared range invariants", () => {
	it("renders one default-md shared root with two real nested range inputs", () => {
		const { container, start, end } = setup({ from: 3, to: 7 });
		const roots = container.querySelectorAll<HTMLElement>("[data-slider-root]");
		const thumbs = container.querySelectorAll<HTMLElement>("[data-slider-thumb]");

		expect(roots).toHaveLength(1);
		expect(roots[0]!.classList.contains("h-[18px]")).toBe(true);
		expect(thumbs).toHaveLength(2);
		expect(start.type).toBe("range");
		expect(end.type).toBe("range");
		expect(roots[0]!.querySelectorAll('input[type="range"]')).toHaveLength(2);
	});

	it("dragging `from` above `to` clamps to `to` (from never exceeds to)", () => {
		const { onChange, start } = setup({ from: 3, to: 7 });
		fireEvent.change(start, { target: { value: "8" } });
		expect(onChange).toHaveBeenCalledWith(7, 7);
	});

	it("dragging `to` below `from` clamps to `from` (to never goes below from)", () => {
		const { onChange, end } = setup({ from: 3, to: 7 });
		fireEvent.change(end, { target: { value: "2" } });
		expect(onChange).toHaveBeenCalledWith(3, 3);
	});

	it("forwards in-bounds changes live through the two-argument callback", () => {
		const { onChange, start, end } = setup({ from: 3, to: 7 });
		fireEvent.change(start, { target: { value: "5" } });
		expect(onChange).toHaveBeenLastCalledWith(5, 7);
		fireEvent.change(end, { target: { value: "9" } });
		expect(onChange).toHaveBeenLastCalledWith(3, 9);
	});

	it("does not emit for an unchanged value", () => {
		const { onChange, start } = setup({ from: 3, to: 7 });
		fireEvent.change(start, { target: { value: "3" } });
		expect(onChange).not.toHaveBeenCalled();
	});

	it("clamps out-of-range changes to [min, max]", () => {
		const { onChange, start, end } = setup({ from: 3, to: 7, min: 1, max: 10 });
		fireEvent.change(start, { target: { value: "0" } });
		expect(onChange).toHaveBeenLastCalledWith(1, 7);
		fireEvent.change(end, { target: { value: "20" } });
		expect(onChange).toHaveBeenLastCalledWith(3, 10);
	});

	it("normalizes reversed and non-finite controlled values before rendering", () => {
		const reversed = setup({ from: 8, to: 3 });
		expect(reversed.start.value).toBe("3");
		expect(reversed.end.value).toBe("8");

		const nonFinite = setup({ from: Number.NaN, to: Number.POSITIVE_INFINITY });
		expect(nonFinite.start.value).toBe("1");
		expect(nonFinite.end.value).toBe("1");
	});

	it("min === max renders two thumbs at the sole legal value", () => {
		const { start, end } = setup({ from: 1, to: 1, min: 1, max: 1 });
		expect(start.value).toBe("1");
		expect(end.value).toBe("1");
	});

	it("keeps disabled nested inputs inert", () => {
		const { onChange, start, end } = setup({ from: 3, to: 7, disabled: true });
		expect(start.disabled).toBe(true);
		expect(end.disabled).toBe(true);
		fireEvent.change(start, { target: { value: "5" } });
		fireEvent.change(end, { target: { value: "9" } });
		expect(onChange).not.toHaveBeenCalled();
	});
});
