/**
 * DualRangeSlider — controlled from/to invariants at the shared Slider seam.
 *
 * Nested range inputs pin endpoint invariants; field pointer events pin window
 * routing. The public callback continues to expose two arguments.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");

let DualRangeSlider: typeof import("./DualRangeSlider.js").DualRangeSlider;

beforeAll(async () => {
	({ DualRangeSlider } = await import("./DualRangeSlider.js"));
});

function setup(props: { from: number; to: number; min?: number; max?: number; disabled?: boolean; label?: string; formatValue?: (from: number, to: number) => string }) {
	const onChange = mock();
	const { container } = render(
		<DualRangeSlider
			min={props.min ?? 1}
			max={props.max ?? 10}
			from={props.from}
			to={props.to}
			disabled={props.disabled}
			label={props.label}
			formatValue={props.formatValue}
			onChange={onChange}
		/>,
	);
	const start = container.querySelector<HTMLInputElement>("[data-testid=\"range-start-input\"]");
	const end = container.querySelector<HTMLInputElement>("[data-testid=\"range-end-input\"]");
	if (!start || !end) throw new Error("Missing nested range inputs");
	return { container, onChange, start, end };
}

function fieldWithRect(container: HTMLElement): HTMLElement {
	const field = container.querySelector<HTMLElement>("[data-slider-field]");
	if (!field) throw new Error("Missing range field");
	Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 90 }) });
	return field;
}

describe("DualRangeSlider — shared range invariants", () => {
	it("renders one field shell with two real nested range inputs, edge handles and an inside label", () => {
		const { container, start, end } = setup({ from: 3, to: 7, label: "Messages" });
		const roots = container.querySelectorAll<HTMLElement>("[data-slider-root]");
		const shells = container.querySelectorAll<HTMLElement>("[data-slider-field-shell]");

		expect(roots).toHaveLength(1);
		// Seam change: rail footprint/thumbs -> a field shell and two 3 px edge handles (SL-11 D1).
		expect(shells).toHaveLength(1);
		expect(shells[0]!.querySelectorAll("[data-slider-field-handle]")).toHaveLength(2);
		expect(shells[0]!.querySelector("[data-slider-field-label]")?.textContent).toBe("Messages");
		expect(container.querySelector("[data-slider-track], [data-slider-thumb]")).toBeNull();
		expect(start.type).toBe("range");
		expect(end.type).toBe("range");
		expect(roots[0]!.querySelectorAll('input[type="range"]')).toHaveLength(2);
		expect(shells[0]!.contains(start) && shells[0]!.contains(end)).toBe(true);
	});

	it("shows the two-argument formatter result or the default endpoint text", () => {
		const formatValue = mock((from: number, to: number) => `${from} through ${to}`);
		const formatted = setup({ from: 3, to: 7, formatValue });
		expect(formatValue).toHaveBeenCalledWith(3, 7);
		expect(formatted.container.querySelector("[data-slider-field-value]")?.textContent).toBe("3 through 7");
		const plain = setup({ from: 3, to: 7 });
		expect(plain.container.querySelector("[data-slider-field-value]")?.textContent).toBe("3 – 7");
	});

	it("drags the whole window two steps and clamps at max without changing its width", () => {
		const { container, onChange } = setup({ from: 3, to: 7 });
		const field = fieldWithRect(container);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 40, button: 0 });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		expect(onChange).toHaveBeenLastCalledWith(5, 9);
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 200 });
		expect(onChange).toHaveBeenLastCalledWith(6, 10);
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 200 });
		for (const [from, to] of onChange.mock.calls) {
			expect(to - from).toBe(4);
			expect(to).toBeLessThanOrEqual(10);
		}
	});

	it("ignores a pointer press and drag while disabled for generation", () => {
		const { container, onChange } = setup({ from: 3, to: 7, disabled: true });
		const field = fieldWithRect(container);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 40, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		expect(onChange).not.toHaveBeenCalled();
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
		const { container, onChange, start, end } = setup({ from: 1, to: 1, min: 1, max: 1 });
		expect(start.value).toBe("1");
		expect(end.value).toBe("1");
		fireEvent.keyDown(start, { key: "ArrowRight" });
		const field = fieldWithRect(container);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 40, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 80 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 80 });
		expect(onChange).not.toHaveBeenCalled();
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
