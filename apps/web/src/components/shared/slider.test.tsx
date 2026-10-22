import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { inputCls } from "../../lib/field-tokens.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let Slider: typeof import("./slider.js").Slider;
const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(async () => {
	({ render, fireEvent, act } = await import("@testing-library/react"));
	({ Slider } = await import("./slider.js"));
});

afterAll(() => {
	globalThis.ResizeObserver = originalResizeObserver;
});

beforeEach(() => {
	globalThis.ResizeObserver = originalResizeObserver;
});

function ControlledSlider({
	initialValue = 4,
	onValueChange = () => {},
	onValueCommitted,
	disabled,
}: {
	initialValue?: number;
	onValueChange?: (value: number) => void;
	onValueCommitted?: (value: number) => void;
	disabled?: boolean;
}) {
	const [value, setValue] = useState(initialValue);
	return (
		<Slider
			value={value}
			min={0}
			max={10}
			step={2}
			aria-label="Volume"
			inputTestId="volume-input"
			disabled={disabled}
			onValueChange={(nextValue) => {
				setValue(nextValue);
				onValueChange(nextValue);
			}}
			onValueCommitted={onValueCommitted}
		/>
	);
}

function ControlledRange({
	onValueChange = () => {},
}: {
	onValueChange?: (value: [number, number]) => void;
}) {
	const [value, setValue] = useState<[number, number]>([20, 60]);
	return (
		<Slider
			value={value}
			min={0}
			max={100}
			step={10}
			getAriaLabel={(index) => (index === 0 ? "From" : "To")}
			inputTestId={["from-input", "to-input"]}
			onValueChange={(nextValue) => {
				setValue(nextValue);
				onValueChange(nextValue);
			}}
		/>
	);
}

function ControlledField({
	initialValue = 4,
	onValueChange = () => {},
	onValueCommitted = () => {},
}: {
	initialValue?: number;
	onValueChange?: (value: number) => void;
	onValueCommitted?: (value: number) => void;
}) {
	const [value, setValue] = useState(initialValue);
	return (
		<Slider
			appearance="field"
			value={value}
			min={0}
			max={10}
			step={2}
			label="Temperature"
			aria-label="Temperature"
			numberTestId="field-number"
			onValueChange={(next) => {
				setValue(next);
				onValueChange(next);
			}}
			onValueCommitted={onValueCommitted}
		/>
	);
}

function ControlledRangeField({
	initial = [2, 6],
	onValueChange = () => {},
	onValueCommitted,
}: {
	initial?: [number, number];
	onValueChange?: (value: [number, number]) => void;
	onValueCommitted?: (value: [number, number]) => void;
}) {
	const [value, setValue] = useState<[number, number]>(initial);
	return (
		<Slider
			appearance="field"
			value={value}
			min={0}
			max={10}
			step={1}
			label="Range"
			getAriaLabel={(index) => index === 0 ? "From" : "To"}
			onValueChange={(next) => {
				setValue(next);
				onValueChange(next);
			}}
			onValueCommitted={onValueCommitted}
		/>
	);
}

function input(container: HTMLElement, testId: string): HTMLInputElement {
	const element = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
	if (!element) throw new Error(`Missing slider input ${testId}`);
	return element;
}

describe("Slider", () => {
	it("renders a controlled scalar value and forwards changes from its nested range input", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledSlider onValueChange={onValueChange} />);
		const rangeInput = input(container, "volume-input");

		expect(rangeInput.type).toBe("range");
		expect(rangeInput.value).toBe("4");
		fireEvent.change(rangeInput, { target: { value: "6" } });
		expect(rangeInput.value).toBe("6");
		expect(onValueChange).toHaveBeenLastCalledWith(6);
	});

	it("renders two labelled nested inputs and keeps thumbs from crossing", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledRange onValueChange={onValueChange} />);
		const from = input(container, "from-input");
		const to = input(container, "to-input");

		expect(from.type).toBe("range");
		expect(to.type).toBe("range");
		expect(from.getAttribute("aria-label")).toBe("From");
		expect(to.getAttribute("aria-label")).toBe("To");
		expect(from.value).toBe("20");
		expect(to.value).toBe("60");
		fireEvent.change(from, { target: { value: "90" } });
		expect(onValueChange).toHaveBeenLastCalledWith([60, 60]);
		expect(from.value).toBe("60");
		expect(to.value).toBe("60");
	});

	it("exposes min/max/step constraints and preserves Base UI keyboard stepping", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(
			<ControlledSlider onValueChange={onValueChange} onValueCommitted={onValueCommitted} />,
		);
		const rangeInput = input(container, "volume-input");

		expect(rangeInput.min).toBe("0");
		expect(rangeInput.max).toBe("10");
		expect(rangeInput.step).toBe("2");
		fireEvent.keyDown(rangeInput, { key: "ArrowRight" });
		expect(onValueChange).toHaveBeenLastCalledWith(6);
		fireEvent.keyDown(rangeInput, { key: "PageDown" });
		expect(onValueChange).toHaveBeenLastCalledWith(0);
		fireEvent.keyDown(rangeInput, { key: "End" });
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		fireEvent.keyDown(rangeInput, { key: "Home" });
		expect(onValueChange).toHaveBeenLastCalledWith(0);
		expect(onValueCommitted).toHaveBeenCalledTimes(4);
	});

	it("snaps an off-grid controlled value to the next step through Base UI keyboard interaction", () => {
		const onValueChange = mock();
		const { container } = render(
			<ControlledSlider initialValue={5} onValueChange={onValueChange} />,
		);
		const rangeInput = input(container, "volume-input");

		expect(rangeInput.value).toBe("5");
		fireEvent.keyDown(rangeInput, { key: "ArrowRight" });
		expect(onValueChange).toHaveBeenLastCalledWith(8);
		expect(rangeInput.value).toBe("8");
	});

	it("commits once for a drivable nested input interaction", () => {
		const onValueCommitted = mock();
		const { container } = render(<ControlledSlider onValueCommitted={onValueCommitted} />);
		const rangeInput = input(container, "volume-input");

		fireEvent.change(rangeInput, { target: { value: "6" } });
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenLastCalledWith(6);
	});

	it("ignores nested input and keyboard interaction when disabled", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledSlider disabled onValueChange={onValueChange} />);
		const rangeInput = input(container, "volume-input");

		expect(rangeInput.disabled).toBe(true);
		fireEvent.change(rangeInput, { target: { value: "6" } });
		fireEvent.keyDown(rangeInput, { key: "ArrowRight" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(rangeInput.value).toBe("4");
	});

	it("uses compact fine-pointer geometry, static track dimensions, and orientation-specific coarse hit areas", () => {
		const { container } = render(
			<div>
				<Slider value={1} min={0} max={2} step={1} aria-label="Medium" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Small" size="sm" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Extra small" size="xs" onValueChange={() => {}} />
				<Slider
					value={1}
					min={0}
					max={2}
					step={1}
					aria-label="Vertical"
					orientation="vertical"
					onValueChange={() => {}}
				/>
				<Slider
					value={1}
					min={0}
					max={2}
					step={1}
					aria-label="Vertical small"
					size="sm"
					orientation="vertical"
					onValueChange={() => {}}
				/>
				<Slider
					value={1}
					min={0}
					max={2}
					step={1}
					aria-label="Vertical extra small"
					size="xs"
					orientation="vertical"
					onValueChange={() => {}}
				/>
			</div>,
		);
		const roots = container.querySelectorAll<HTMLElement>("[data-slider-root]");
		const tracks = container.querySelectorAll<HTMLElement>("[data-slider-track]");
		const thumbs = container.querySelectorAll<HTMLElement>("[data-slider-thumb]");

		expect(roots).toHaveLength(6);
		expect(tracks).toHaveLength(6);
		expect(thumbs).toHaveLength(6);

		const horizontalRootClasses = ["h-[18px]", "h-[14px]", "h-3"];
		const verticalRootClasses = ["w-[18px]", "w-[14px]", "w-3"];
		const thumbClasses = ["h-[18px]", "h-[14px]", "h-3"];
		const horizontalTrackClasses = ["h-[6px]", "h-1", "h-[3px]"];
		const verticalTrackClasses = ["w-[6px]", "w-1", "w-[3px]"];

		for (let index = 0; index < 3; index += 1) {
			expect(roots[index]!.classList.contains(horizontalRootClasses[index]!)).toBe(true);
			expect(roots[index]!.classList.contains("h-11")).toBe(false);
			expect(roots[index]!.classList.contains("[@media(pointer:coarse)]:h-11")).toBe(true);
			expect(thumbs[index]!.classList.contains(thumbClasses[index]!)).toBe(true);
			expect(tracks[index]!.classList.contains(horizontalTrackClasses[index]!)).toBe(true);
		}

		for (let index = 0; index < 3; index += 1) {
			const sliderIndex = index + 3;
			expect(roots[sliderIndex]!.getAttribute("data-orientation")).toBe("vertical");
			expect(roots[sliderIndex]!.classList.contains(verticalRootClasses[index]!)).toBe(true);
			expect(roots[sliderIndex]!.classList.contains("w-11")).toBe(false);
			expect(roots[sliderIndex]!.classList.contains("[@media(pointer:coarse)]:w-11")).toBe(true);
			expect(thumbs[sliderIndex]!.classList.contains(thumbClasses[index]!)).toBe(true);
			expect(tracks[sliderIndex]!.classList.contains(verticalTrackClasses[index]!)).toBe(true);
		}
	});

	it("uses a translucent token-derived soft halo on the focused rail thumb", () => {
		const { container } = render(
			<Slider value={1} min={0} max={2} step={1} aria-label="Focus" onValueChange={() => {}} />,
		);
		const thumb = container.querySelector<HTMLElement>("[data-slider-thumb]");

		if (!thumb) throw new Error("Missing slider thumb");
		expect(thumb.querySelector('input[type="range"]')).not.toBeNull();
		expect(thumb.classList.contains("has-[input:focus-visible]:shadow-[0_0_0_6px_color-mix(in_oklch,var(--accent)_18%,transparent)]")).toBe(true);
		expect(thumb.classList.contains("border-[3px]")).toBe(true);
		expect(thumb.className.includes("ring-4")).toBe(false);
	});

	it("renders the requested field appearance contract", () => {
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={2}
				label="Temperature"
				aria-label="Temperature"
				numberTestId="temperature-number"
				onValueChange={() => {}}
			/>,
		);

		expect(container.querySelector("[data-slider-field]")).not.toBeNull();
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		expect(field.classList.contains("peer-has-[input:focus-visible]:border-accent")).toBe(true);
		fireEvent.doubleClick(field);
		// Seam change: the inline editor is the shared NumberInput (text field with a decimal keypad), never a raw type="number" input.
		const editor = input(container, "temperature-number");
		expect(editor.type).toBe("text");
		expect(editor.getAttribute("inputmode")).toBe("decimal");
	});

	it("sets a field value from the pointer and supports exact ten-step fractional Shift keyboard steps", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100 }) });

		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 80, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 80 });
		expect(onValueChange).toHaveBeenLastCalledWith(8);
		const rangeInput = container.querySelector<HTMLInputElement>('input[type="range"]');
		if (!rangeInput) throw new Error("Missing field range input");
		const fractional = render(<Slider appearance="field" value={0.2} min={0} max={5} step={0.1} aria-label="Fractional" onValueChange={onValueChange} />);
		const fractionalInput = fractional.container.querySelector<HTMLInputElement>('input[type="range"]');
		if (!fractionalInput) throw new Error("Missing fractional field input");
		fireEvent.keyDown(fractionalInput, { key: "ArrowRight", shiftKey: true });
		expect(onValueChange).toHaveBeenLastCalledWith(1.2);
		fireEvent.keyDown(rangeInput, { key: "Enter" });
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "9" } });
		fireEvent.keyDown(editor, { key: "Enter" });
		// Behavior change: a typed value is kept exactly (step 2 here); only stepping snaps.
		expect(onValueChange).toHaveBeenLastCalledWith(9);
		expect(onValueCommitted).toHaveBeenLastCalledWith(9);
	});

	it("cancels a field inline edit without changing the controlled value", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		fireEvent.doubleClick(field);
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "10" } });
		fireEvent.keyDown(editor, { key: "Escape" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
		expect(container.querySelector("[data-slider-field-value]")?.textContent).toBe("4");
	});

	it("keeps an inline draft exactly and commits exactly once on blur", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		fireEvent.doubleClick(field);
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "9" } });
		fireEvent.blur(editor);
		// Behavior change: was snapped to the step grid (10), now the typed 9 is kept.
		expect(onValueChange).toHaveBeenLastCalledWith(9);
		expect(onValueCommitted).toHaveBeenLastCalledWith(9);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
	});

	it("chooses the nearest range edge and drags the selected window without changing its width", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledRangeField onValueChange={onValueChange} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field range");
		Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100 }) });
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 90, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 90 });
		expect(onValueChange).toHaveBeenLastCalledWith([2, 9]);
		fireEvent.pointerDown(field, { pointerId: 2, pointerType: "mouse", clientX: 50, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 2, pointerType: "mouse", clientX: 70 });
		fireEvent.pointerUp(field, { pointerId: 2, pointerType: "mouse", clientX: 70 });
		expect(onValueChange).toHaveBeenLastCalledWith([3, 10]);
	});

	it("anchors a formatted rail bubble inside its thumb with drag/focus-visible visibility selectors", () => {
		const { container } = render(<Slider value={4} min={0} max={10} step={1} aria-label="Seek" formatValue={(value) => `at ${value}`} onValueChange={() => {}} />);
		const rangeInput = container.querySelector<HTMLInputElement>('input[type="range"]');
		if (!rangeInput) throw new Error("Missing rail input");
		const bubble = container.querySelector<HTMLOutputElement>("[data-slider-bubble]");
		if (!bubble) throw new Error("Missing rail bubble");
		expect(bubble.parentElement?.getAttribute("data-slider-thumb")).toBe("true");
		expect(bubble.parentElement?.classList.contains("group/thumb")).toBe(true);
		expect(bubble.classList.contains("group-data-[dragging]/thumb:block")).toBe(true);
		expect(bubble.classList.contains("group-has-[input:focus-visible]/thumb:block")).toBe(true);
		expect(bubble.classList.contains("data-[dragging]:block")).toBe(false);
		expect(bubble.classList.contains("has-[input:focus-visible]:block")).toBe(false);
		expect(bubble.textContent).toBe("at 4");
		const withoutFormatter = render(<Slider value={4} min={0} max={10} step={1} aria-label="No bubble" onValueChange={() => {}} />);
		expect(withoutFormatter.container.querySelector("[data-slider-bubble]")).toBeNull();
	});

	it("keeps a vertical touch swipe value-neutral, locks horizontal scrub after four pixels, taps, and cleans cancellation", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100 }) });

		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "touch", clientX: 40, clientY: 10, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "touch", clientX: 43, clientY: 30 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "touch", clientX: 43, clientY: 30 });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
		expect(field.classList.contains("touch-pan-y")).toBe(true);

		fireEvent.pointerDown(field, { pointerId: 2, pointerType: "touch", clientX: 40, clientY: 10, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 2, pointerType: "touch", clientX: 80, clientY: 11 });
		fireEvent.pointerUp(field, { pointerId: 2, pointerType: "touch", clientX: 80, clientY: 11 });
		expect(onValueChange).toHaveBeenLastCalledWith(8);
		expect(onValueCommitted).toHaveBeenLastCalledWith(8);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);

		fireEvent.pointerDown(field, { pointerId: 3, pointerType: "touch", clientX: 61, clientY: 10, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 3, pointerType: "touch", clientX: 61, clientY: 10 });
		expect(onValueChange).toHaveBeenLastCalledWith(6);
		expect(onValueCommitted).toHaveBeenCalledTimes(2);

		fireEvent.pointerDown(field, { pointerId: 4, pointerType: "touch", clientX: 20, clientY: 10, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 4, pointerType: "touch", clientX: 80, clientY: 10 });
		fireEvent.pointerCancel(field, { pointerId: 4, pointerType: "touch" });
		expect(onValueCommitted).toHaveBeenCalledTimes(2);
	});

	it("moves labels above and back inside while measured help stays interactive and does not scrub", () => {
		const resizeCallbacks: (() => void)[] = [];
		class ResizeObserverMock implements ResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallbacks.push(() => callback([], this));
			}
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() { return []; }
		}
		globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
		const onHelp = mock();
		const onValueChange = mock();
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={1}
				label="Temperature"
				help={<button type="button" onClick={onHelp}>?</button>}
				aria-label="Temperature"
				onValueChange={onValueChange}
			/>,
		);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 300 }) });
		let width = 300;
		Object.defineProperty(field, "clientWidth", { configurable: true, get: () => width });
		function setMeasuredWidths() {
			const label = container.querySelector<HTMLElement>("[data-slider-field-label-content]");
			const value = container.querySelector<HTMLElement>("[data-slider-field-measure-value]");
			if (!label || !value) throw new Error("Missing field measurements");
			// This is the complete rendered label width, including the help trigger.
			Object.defineProperty(label, "scrollWidth", { configurable: true, value: 150 });
			Object.defineProperty(value, "scrollWidth", { configurable: true, value: 30 });
		}
		setMeasuredWidths();
		act(() => resizeCallbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label]")?.textContent).toBe("Temperature?");
		const help = container.querySelector<HTMLElement>("[data-slider-field-help]");
		if (!help) throw new Error("Missing field help");
		expect(help.classList.contains("pointer-events-auto")).toBe(true);
		fireEvent.pointerDown(help, { pointerId: 1, pointerType: "mouse", clientX: 250, button: 0 });
		fireEvent.click(help.querySelector("button")!);
		expect(onHelp).toHaveBeenCalledTimes(1);
		expect(onValueChange).not.toHaveBeenCalled();
		setMeasuredWidths();
		width = 100;
		expect(container.querySelector<HTMLElement>("[data-slider-field-label-content]")?.scrollWidth).toBe(150);
		expect(container.querySelector<HTMLElement>("[data-slider-field-measure-value]")?.scrollWidth).toBe(30);
		expect(field.clientWidth).toBe(100);
		expect(resizeCallbacks.length).toBeGreaterThan(0);
		act(() => resizeCallbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label-above]")?.textContent).toBe("Temperature?");
		const abovePlacement = container.querySelector<HTMLElement>("[data-slider-field-label-above]");
		if (!abovePlacement) throw new Error("Missing above field label placement");
		expect(abovePlacement.classList.contains("block")).toBe(true);
		expect(abovePlacement.classList.contains("mb-1.5")).toBe(true);
		expect(abovePlacement.classList.contains("inline-flex")).toBe(false);
		expect(abovePlacement.querySelector("[data-slider-field-label-content]")?.classList.contains("inline-flex")).toBe(true);
		setMeasuredWidths();
		width = 300;
		act(() => resizeCallbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label]")?.textContent).toBe("Temperature?");
	});

	it("makes the complete disabled field shell inert and uniformly dim", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={1}
				label="Temperature"
				help={<button type="button">?</button>}
				aria-label="Temperature"
				disabled
				onValueChange={onValueChange}
				onValueCommitted={onValueCommitted}
			/>,
		);
		const shell = container.querySelector<HTMLElement>("[data-slider-field-shell]");
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		const rangeInput = container.querySelector<HTMLInputElement>('input[type="range"]');
		if (!shell || !field || !rangeInput) throw new Error("Missing disabled field parts");
		expect(shell.classList.contains("opacity-40")).toBe(true);
		expect(shell.classList.contains("pointer-events-none")).toBe(true);
		expect(field.classList.contains("opacity-40")).toBe(false);
		expect(field.classList.contains("pointer-events-none")).toBe(false);
		expect(shell.querySelector("[data-slider-field-label]")).not.toBeNull();
		expect(shell.querySelector("[data-slider-field-help]")).not.toBeNull();
		expect(rangeInput.disabled).toBe(true);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 80, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 80 });
		fireEvent.keyDown(rangeInput, { key: "ArrowRight" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
	});

	it("keeps degenerate tuple bounds exact and inert, avoids NaN geometry and formats tuples as a whole value", () => {
		const { container } = render(<Slider appearance="field" value={0} min={0} max={10} step={1} aria-label="Minimum" onValueChange={() => {}} />);
		const fill = container.querySelector<HTMLElement>("[data-slider-field-fill]");
		if (!fill) throw new Error("Missing field fill");
		expect(fill.style.width).toBe("0%");
		expect(fill.classList.contains("border-r-2")).toBe(false);
		const onDegenerateChange = mock();
		const onDegenerateCommit = mock();
		const degenerate = render(
			<Slider
				appearance="field"
				value={[1, 1]}
				min={1}
				max={1}
				step={1}
				inputTestId={["degenerate-from", "degenerate-to"]}
				getAriaLabel={(index) => String(index)}
				onValueChange={onDegenerateChange}
				onValueCommitted={onDegenerateCommit}
			/>,
		);
		const visibleGeometry = degenerate.container.querySelectorAll<HTMLElement>(
			"[data-slider-field-fill], [data-slider-field-handle]",
		);
		for (const element of visibleGeometry) {
			expect(element.getAttribute("style")?.includes("NaN")).toBe(false);
		}
		const degenerateFrom = input(degenerate.container, "degenerate-from");
		const degenerateTo = input(degenerate.container, "degenerate-to");
		expect([degenerateFrom.min, degenerateFrom.max, degenerateFrom.value]).toEqual(["1", "1", "1"]);
		expect([degenerateTo.min, degenerateTo.max, degenerateTo.value]).toEqual(["1", "1", "1"]);
		fireEvent.keyDown(degenerateFrom, { key: "ArrowRight" });
		const degenerateField = degenerate.container.querySelector<HTMLElement>("[data-slider-field]");
		if (!degenerateField) throw new Error("Missing degenerate field");
		Object.defineProperty(degenerateField, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100 }) });
		fireEvent.pointerDown(degenerateField, { pointerId: 9, pointerType: "mouse", clientX: 80, button: 0 });
		fireEvent.pointerUp(degenerateField, { pointerId: 9, pointerType: "mouse", clientX: 80 });
		expect(onDegenerateChange).not.toHaveBeenCalled();
		expect(onDegenerateCommit).not.toHaveBeenCalled();
		const tuple = render(<Slider appearance="field" value={[1, 10]} min={1} max={10} step={1} getAriaLabel={(index) => String(index)} formatValue={(value) => `${value[0]} – ${value[1]} · 10 messages`} onValueChange={() => {}} />);
		expect(tuple.container.querySelector("[data-slider-field-value]")?.textContent).toBe("1 – 10 · 10 messages");
	});
});

function fieldOf(container: HTMLElement): HTMLElement {
	const field = container.querySelector<HTMLElement>("[data-slider-field]");
	if (!field) throw new Error("Missing field slider");
	return field;
}

function withWidth(field: HTMLElement, width = 100) {
	Object.defineProperty(field, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width }) });
}

function thumbInput(container: HTMLElement, index = 0): HTMLInputElement {
	const element = container.querySelectorAll<HTMLInputElement>('input[type="range"]')[index];
	if (!element) throw new Error(`Missing thumb input ${index}`);
	return element;
}

function openEditor(container: HTMLElement): HTMLInputElement {
	fireEvent.doubleClick(fieldOf(container));
	return input(container, "field-number");
}

describe("Slider field inline editor", () => {
  it("emits no change or commit when an untouched editor blurs", () => {
    const onValueChange = mock();
    const onValueCommitted = mock();
    const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
    fireEvent.blur(openEditor(container));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommitted).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slider-field-editor]")).toBeNull();
    expect(container.querySelector("[data-slider-field-value]")?.textContent).toBe("4");
  });

  it("emits no change or commit when an empty editor reverts on blur", () => {
    const onValueChange = mock();
    const onValueCommitted = mock();
    const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
    const editor = openEditor(container);
    fireEvent.change(editor, { target: { value: "" } });
    fireEvent.blur(editor);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommitted).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slider-field-editor]")).toBeNull();
    expect(container.querySelector("[data-slider-field-value]")?.textContent).toBe("4");
  });

  it("emits no change or commit when Enter submits the value the editor opened with", () => {
    const onValueChange = mock();
    const onValueCommitted = mock();
    const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
    const editor = openEditor(container);
    fireEvent.change(editor, { target: { value: "4.0" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onValueCommitted).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slider-field-editor]")).toBeNull();
    expect(document.activeElement).toBe(thumbInput(container));
  });

	it("commits Enter exactly once with the typed value clamped to the bounds and never snapped to the step", () => {
		// Behavior change: "9" was 10 and "3" was 4 (snapped to step 2); typed values are now kept as typed.
		const cases: [string, number][] = [["9", 9], ["99", 10], ["-5", 0], ["3", 3]];
		for (const [typed, expected] of cases) {
			const onValueChange = mock();
			const onValueCommitted = mock();
			const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
			const editor = openEditor(container);
			fireEvent.change(editor, { target: { value: typed } });
			fireEvent.keyDown(editor, { key: "Enter" });
			expect(onValueChange).toHaveBeenCalledTimes(1);
			expect(onValueChange).toHaveBeenLastCalledWith(expected);
			expect(onValueCommitted).toHaveBeenCalledTimes(1);
			expect(onValueCommitted).toHaveBeenLastCalledWith(expected);
			expect(container.querySelector('[data-testid="field-number"]')).toBeNull();
		}
	});

	it("keeps a typed fractional value exactly, with no float noise and no grid snapping", () => {
		// Behavior change: 0.72 at step 0.05 was snapped to 0.7; typed values are now clamped only.
		// The second case has its grid anchored off zero (0.25 + n * 0.1), where snapping used to turn 1 into 1.05 and 1.2 into 1.15.
		const cases: { min: number; max: number; step: number; typed: string; expected: number }[] = [
			{ min: 0, max: 1, step: 0.05, typed: "0.72", expected: 0.72 },
			{ min: 0.25, max: 4, step: 0.1, typed: "1", expected: 1 },
			{ min: 0.25, max: 4, step: 0.1, typed: "1.2", expected: 1.2 },
			{ min: 0.25, max: 4, step: 0.1, typed: "9", expected: 4 },
			{ min: 0.25, max: 4, step: 0.1, typed: "0.1", expected: 0.25 },
		];
		for (const { min, max, step, typed, expected } of cases) {
			const onValueChange = mock();
			const onValueCommitted = mock();
			const { container } = render(
				<Slider
					appearance="field"
					value={max / 2}
					min={min}
					max={max}
					step={step}
					aria-label="Fraction"
					numberTestId="fraction-number"
					onValueChange={onValueChange}
					onValueCommitted={onValueCommitted}
				/>,
			);
			fireEvent.doubleClick(fieldOf(container));
			const editor = input(container, "fraction-number");
			fireEvent.change(editor, { target: { value: typed } });
			fireEvent.keyDown(editor, { key: "Enter" });
			expect(onValueChange).toHaveBeenCalledTimes(1);
			expect(onValueChange).toHaveBeenLastCalledWith(expected);
			expect(onValueCommitted).toHaveBeenLastCalledWith(expected);
		}
	});

	it("emits no change and no commit when Escape cancels, and discards the draft", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const editor = openEditor(container);
		fireEvent.change(editor, { target: { value: "8" } });
		fireEvent.keyDown(editor, { key: "Escape" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="field-number"]')).toBeNull();
		expect(container.querySelector("[data-slider-field-value]")?.textContent).toBe("4");
	});

	it("commits a blur without Enter exactly once", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const editor = openEditor(container);
		fireEvent.change(editor, { target: { value: "7" } });
		fireEvent.blur(editor);
		// Behavior change: was snapped to the step grid (8), now the typed 7 is kept.
		expect(onValueChange).toHaveBeenCalledTimes(1);
		expect(onValueChange).toHaveBeenLastCalledWith(7);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenLastCalledWith(7);
	});

	it("cannot commit twice when Enter and a stale blur land before React re-renders", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const editor = openEditor(container);
		fireEvent.change(editor, { target: { value: "9" } });
		act(() => {
			fireEvent.keyDown(editor, { key: "Enter" });
			fireEvent.blur(editor);
			fireEvent.blur(editor);
		});
		expect(onValueChange).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		// Behavior change: was snapped to the step grid (10), now the typed 9 is kept.
		expect(onValueCommitted).toHaveBeenLastCalledWith(9);
	});

	it("cannot commit after Escape even if the unmounting input still blurs", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const editor = openEditor(container);
		fireEvent.change(editor, { target: { value: "9" } });
		act(() => {
			fireEvent.keyDown(editor, { key: "Escape" });
			fireEvent.blur(editor);
		});
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
	});

	it("returns keyboard focus to the field's thumb input after Enter, Escape and a blur commit", () => {
		const finishers: ((editor: HTMLInputElement) => void)[] = [
			(editor) => { fireEvent.keyDown(editor, { key: "Enter" }); },
			(editor) => { fireEvent.keyDown(editor, { key: "Escape" }); },
			(editor) => { fireEvent.blur(editor); },
		];
		for (const finish of finishers) {
			const { container } = render(<ControlledField />);
			const editor = openEditor(container);
			expect(document.activeElement).toBe(editor);
			finish(editor);
			expect(container.querySelector('[data-testid="field-number"]')).toBeNull();
			expect(document.activeElement).toBe(thumbInput(container));
		}
	});

	it("keeps arrow-key stepping alive on the thumb right after the editor closes", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} />);
		const editor = openEditor(container);
		fireEvent.keyDown(editor, { key: "Escape" });
		fireEvent.keyDown(document.activeElement ?? container, { key: "ArrowRight" });
		expect(onValueChange).toHaveBeenLastCalledWith(6);
	});

	it("does not pull focus back when the blur is moving focus to another control", () => {
		const onValueCommitted = mock();
		const { container } = render(
			<div>
				<ControlledField onValueCommitted={onValueCommitted} />
				<input data-testid="elsewhere" />
			</div>,
		);
		openEditor(container);
		const editor = input(container, "field-number");
		const elsewhere = input(container, "elsewhere");
		fireEvent.blur(editor, { relatedTarget: elsewhere });
		// Behavior change: was one untouched commit -> now none; basis: P4, parity with NumberInput's unchanged-value guard.
		expect(onValueCommitted).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(thumbInput(container));
		act(() => elsewhere.focus());
		expect(document.activeElement).toBe(elsewhere);
	});

	it("keeps the editor unopenable while disabled, and closes it if the field becomes disabled", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const props = {
			appearance: "field" as const,
			value: 4,
			min: 0,
			max: 10,
			step: 2,
			label: "Temperature",
			"aria-label": "Temperature",
			numberTestId: "field-number",
			onValueChange,
			onValueCommitted,
		};
		const disabledRender = render(<Slider {...props} disabled />);
		fireEvent.doubleClick(fieldOf(disabledRender.container));
		fireEvent.keyDown(thumbInput(disabledRender.container), { key: "Enter" });
		expect(disabledRender.container.querySelector('[data-testid="field-number"]')).toBeNull();

		const live = render(<Slider {...props} />);
		const editor = openEditor(live.container);
		fireEvent.change(editor, { target: { value: "8" } });
		live.rerender(<Slider {...props} disabled />);
		expect(live.container.querySelector('[data-testid="field-number"]')).toBeNull();
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
	});
});

describe("Slider field contract", () => {
  it("replaces the field value color without applying valueClassName to any other element", () => {
    const { container } = render(
      <Slider appearance="field" value={4} min={0} max={10} step={1} label="Bias" aria-label="Bias" valueClassName="text-danger" onValueChange={() => {}} />,
    );
    const value = container.querySelector<HTMLElement>("[data-slider-field-value]");
    expect(value?.classList.contains("text-danger")).toBe(true);
    expect(value?.classList.contains("text-t1")).toBe(false);
    expect(Array.from(container.querySelectorAll(".text-danger"))).toEqual([value!]);
  });

  it("keeps the exact default field value class string without valueClassName", () => {
    const { container } = render(<ControlledField />);
    expect(container.querySelector("[data-slider-field-value]")?.className).toBe(
      "pointer-events-none absolute right-[13px] top-0 z-[1] flex h-full items-center font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums text-t1",
    );
  });

	it("is the canon field box with the accent border on keyboard focus", () => {
		const { container } = render(<ControlledField />);
		const field = fieldOf(container);
		for (const token of inputCls.split(" ")) expect(field.classList.contains(token)).toBe(true);
		for (const token of ["h-11", "sm:h-[38px]", "bg-s2", "border-border", "rounded-[6px]"]) {
			expect(field.classList.contains(token)).toBe(true);
		}
		expect(field.classList.contains("peer-has-[input:focus-visible]:border-accent")).toBe(true);
		expect(field.classList.contains("cursor-ew-resize")).toBe(true);
		const control = container.querySelector("[data-slider-field-input-control]");
		expect(control?.classList.contains("peer")).toBe(true);
		expect(control?.nextElementSibling).toBe(field);
	});

	it("fills up to the value with an accent edge, and drops the edge at the minimum", () => {
		const mid = render(<ControlledField initialValue={4} />);
		const fill = mid.container.querySelector<HTMLElement>("[data-slider-field-fill]");
		if (!fill) throw new Error("Missing fill");
		expect(fill.style.width).toBe("40%");
		// Translucent in every theme: --accent-hover is opaque in some themes and would bury the label and value.
		expect(fill.classList.contains("bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]")).toBe(true);
		expect(fill.classList.contains("bg-accent-hover")).toBe(false);
		expect(fill.classList.contains("z-0")).toBe(true);
		expect(fill.classList.contains("border-r-2")).toBe(true);
		expect(fill.classList.contains("border-accent")).toBe(true);
		const full = render(<ControlledField initialValue={10} />);
		expect(full.container.querySelector<HTMLElement>("[data-slider-field-fill]")?.style.width).toBe("100%");
		const zero = render(<ControlledField initialValue={0} />);
		const zeroFill = zero.container.querySelector<HTMLElement>("[data-slider-field-fill]");
		expect(zeroFill?.style.width).toBe("0%");
		expect(zeroFill?.classList.contains("border-r-2")).toBe(false);
	});

	it("paints the label, help and value above the translucent fill and fills the two-value window with the same color", () => {
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={1}
				label="Temperature"
				help={<button type="button">?</button>}
				aria-label="Temperature"
				onValueChange={() => {}}
			/>,
		);
		// The field is its own stacking context; the label sits in the shell above it, the value above the fill inside it.
		expect(fieldOf(container).classList.contains("isolate")).toBe(true);
		expect(container.querySelector("[data-slider-field-label]")?.classList.contains("z-[1]")).toBe(true);
		expect(container.querySelector("[data-slider-field-value]")?.classList.contains("z-[1]")).toBe(true);
		expect(container.querySelector("[data-slider-field-fill]")?.classList.contains("z-0")).toBe(true);
		const pair = render(<ControlledRangeField />);
		const windowFill = pair.container.querySelector<HTMLElement>("[data-slider-field-fill]");
		expect(windowFill?.classList.contains("bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]")).toBe(true);
		expect(windowFill?.classList.contains("bg-accent-hover")).toBe(false);
		for (const handle of pair.container.querySelectorAll("[data-slider-field-handle]")) {
			expect(handle.classList.contains("z-[1]")).toBe(true);
		}
	});

	it("shows the value on the right as formatValue text or with the step's decimals", () => {
		const decimal = render(<Slider appearance="field" value={0.3} min={0} max={1} step={0.05} aria-label="Decimal" onValueChange={() => {}} />);
		const valueNode = decimal.container.querySelector<HTMLElement>("[data-slider-field-value]");
		expect(valueNode?.textContent).toBe("0.30");
		expect(valueNode?.classList.contains("right-[13px]")).toBe(true);
		expect(valueNode?.classList.contains("tabular-nums")).toBe(true);
		const integer = render(<Slider appearance="field" value={7} min={0} max={10} step={1} aria-label="Integer" onValueChange={() => {}} />);
		expect(integer.container.querySelector("[data-slider-field-value]")?.textContent).toBe("7");
		const formatted = render(
			<Slider appearance="field" value={30} min={0} max={100} step={1} aria-label="Formatted" formatValue={(value) => `${value} %`} onValueChange={() => {}} />,
		);
		expect(formatted.container.querySelector("[data-slider-field-value]")?.textContent).toBe("30 %");
		const pair = render(<ControlledRangeField />);
		expect(pair.container.querySelector("[data-slider-field-value]")?.textContent).toBe("2 – 6");
	});

	it("shows a typed value faithfully: the step's decimals or the value's own, capped at 4, without float noise", () => {
		const cases: { value: number; step: number; expected: string }[] = [
			{ value: 1.23, step: 0.1, expected: "1.23" },
			{ value: 0.7, step: 0.05, expected: "0.70" },
			{ value: 0.7000000000000001, step: 0.05, expected: "0.70" },
			{ value: 1.23456, step: 0.1, expected: "1.2346" },
			{ value: 1.5, step: 1, expected: "1.5" },
			{ value: 7, step: 1, expected: "7" },
			{ value: 0.3, step: 0.001, expected: "0.300" },
		];
		for (const { value, step, expected } of cases) {
			const view = render(<Slider appearance="field" value={value} min={0} max={10} step={step} aria-label="Faithful" onValueChange={() => {}} />);
			expect(view.container.querySelector("[data-slider-field-value]")?.textContent).toBe(expected);
			view.unmount();
		}
		const pair = render(<Slider appearance="field" value={[1.25, 6]} min={0} max={10} step={0.5} getAriaLabel={() => "Edge"} onValueChange={() => {}} />);
		expect(pair.container.querySelector("[data-slider-field-value]")?.textContent).toBe("1.25 – 6.0");
	});

	it("places an unclipped label on the left, vertically centered, and keeps its help beside it", () => {
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={1}
				label="A deliberately long parameter label"
				help={<button type="button">?</button>}
				aria-label="Label"
				onValueChange={() => {}}
			/>,
		);
		const placement = container.querySelector<HTMLElement>("[data-slider-field-label]");
		const content = container.querySelector<HTMLElement>("[data-slider-field-label-content]");
		if (!placement || !content) throw new Error("Missing field label");
		for (const token of ["absolute", "left-[13px]", "flex", "items-center", "h-11", "sm:h-[38px]", "pointer-events-none"]) {
			expect(placement.classList.contains(token)).toBe(true);
		}
		for (const token of ["truncate", "overflow-hidden", "text-ellipsis", "whitespace-nowrap"]) {
			expect(content.classList.contains(token) || placement.classList.contains(token)).toBe(false);
		}
		expect(content.classList.contains("w-max")).toBe(true);
		expect(content.querySelector("[data-slider-field-help]")?.classList.contains("pointer-events-auto")).toBe(true);
		expect(content.textContent).toBe("A deliberately long parameter label?");
	});

	it("drags a single value after the press, commits once on release, and leaves focus on the thumb", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = fieldOf(container);
		withWidth(field);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 20, button: 0 });
		expect(onValueChange).toHaveBeenLastCalledWith(2);
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 60 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 130 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 130 });
		expect(onValueChange.mock.calls.map((call) => call[0])).toEqual([2, 6, 10]);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenLastCalledWith(10);
		expect(document.activeElement).toBe(thumbInput(container));
	});

	it("snaps a pointer value to the step grid without float noise", () => {
		const onValueChange = mock();
		const { container } = render(
			<Slider appearance="field" value={0.2} min={0} max={1} step={0.05} aria-label="Fraction" onValueChange={onValueChange} />,
		);
		const field = fieldOf(container);
		withWidth(field);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 70, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 70 });
		expect(onValueChange).toHaveBeenLastCalledWith(0.7);
	});

	it("steps with the arrows, Home and End on the thumb, and commits each key", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const thumb = thumbInput(container);
		fireEvent.keyDown(thumb, { key: "ArrowRight" });
		expect(onValueChange).toHaveBeenLastCalledWith(6);
		fireEvent.keyDown(thumb, { key: "ArrowLeft" });
		expect(onValueChange).toHaveBeenLastCalledWith(4);
		fireEvent.keyDown(thumb, { key: "ArrowRight", shiftKey: true });
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		fireEvent.keyDown(thumb, { key: "Home" });
		expect(onValueChange).toHaveBeenLastCalledWith(0);
		fireEvent.keyDown(thumb, { key: "End" });
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		expect(onValueCommitted).toHaveBeenCalledTimes(5);
	});

	it("opens the editor on Enter from the thumb and on double-click, but not for two values", () => {
		const first = render(<ControlledField />);
		fireEvent.keyDown(thumbInput(first.container), { key: "Enter" });
		expect(first.container.querySelector('[data-testid="field-number"]')).not.toBeNull();
		const second = render(<ControlledField />);
		fireEvent.doubleClick(fieldOf(second.container));
		expect(second.container.querySelector('[data-testid="field-number"]')).not.toBeNull();
		const pair = render(<ControlledRangeField />);
		fireEvent.doubleClick(fieldOf(pair.container));
		fireEvent.keyDown(thumbInput(pair.container), { key: "Enter" });
		expect(pair.container.querySelectorAll('input[type="text"]')).toHaveLength(0);
	});

	it("never lets the dragged edge cross the other one and commits the pair once", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledRangeField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = fieldOf(container);
		withWidth(field);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 30, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 90 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: 90 });
		expect(onValueChange).toHaveBeenLastCalledWith([6, 6]);
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenLastCalledWith([6, 6]);
		for (const call of onValueChange.mock.calls) expect(call[0][0]).toBeLessThanOrEqual(call[0][1]);
	});

	it("lets a collapsed pair open to either side from the pointer side", () => {
		const onValueChange = mock();
		const right = render(<ControlledRangeField initial={[5, 5]} onValueChange={onValueChange} />);
		const rightField = fieldOf(right.container);
		withWidth(rightField);
		fireEvent.pointerDown(rightField, { pointerId: 1, pointerType: "mouse", clientX: 80, button: 0 });
		fireEvent.pointerUp(rightField, { pointerId: 1, pointerType: "mouse", clientX: 80 });
		expect(onValueChange).toHaveBeenLastCalledWith([5, 8]);
		const left = render(<ControlledRangeField initial={[5, 5]} onValueChange={onValueChange} />);
		const leftField = fieldOf(left.container);
		withWidth(leftField);
		fireEvent.pointerDown(leftField, { pointerId: 2, pointerType: "mouse", clientX: 20, button: 0 });
		fireEvent.pointerUp(leftField, { pointerId: 2, pointerType: "mouse", clientX: 20 });
		expect(onValueChange).toHaveBeenLastCalledWith([2, 5]);
	});

	it("keeps the window width at both bounds and commits the moved window once", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledRangeField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = fieldOf(container);
		withWidth(field);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "mouse", clientX: 40, button: 0 });
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: 100 });
		expect(onValueChange).toHaveBeenLastCalledWith([6, 10]);
		fireEvent.pointerMove(field, { pointerId: 1, pointerType: "mouse", clientX: -50 });
		expect(onValueChange).toHaveBeenLastCalledWith([0, 4]);
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "mouse", clientX: -50 });
		expect(onValueCommitted).toHaveBeenCalledTimes(1);
		expect(onValueCommitted).toHaveBeenLastCalledWith([0, 4]);
		for (const call of onValueChange.mock.calls) expect(call[0][1] - call[0][0]).toBe(4);
	});

	it("draws the two-value window between two 3 px edge handles and none for one value", () => {
		const pair = render(<ControlledRangeField />);
		const handles = pair.container.querySelectorAll<HTMLElement>("[data-slider-field-handle]");
		expect(handles).toHaveLength(2);
		for (const handle of handles) expect(handle.classList.contains("w-[3px]")).toBe(true);
		expect([handles[0]!.style.left, handles[1]!.style.left]).toEqual(["20%", "60%"]);
		const fill = pair.container.querySelector<HTMLElement>("[data-slider-field-fill]");
		expect([fill?.style.left, fill?.style.width]).toEqual(["20%", "40%"]);
		const single = render(<ControlledField />);
		expect(single.container.querySelectorAll("[data-slider-field-handle]")).toHaveLength(0);
	});

	it("keeps a disabled field inert for the pointer, the keyboard and both editor entries", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(
			<Slider
				appearance="field"
				value={4}
				min={0}
				max={10}
				step={1}
				aria-label="Disabled"
				numberTestId="field-number"
				disabled
				onValueChange={onValueChange}
				onValueCommitted={onValueCommitted}
			/>,
		);
		const field = fieldOf(container);
		withWidth(field);
		fireEvent.pointerDown(field, { pointerId: 1, pointerType: "touch", clientX: 70, button: 0 });
		fireEvent.pointerUp(field, { pointerId: 1, pointerType: "touch", clientX: 70 });
		fireEvent.keyDown(thumbInput(container), { key: "Home" });
		fireEvent.doubleClick(field);
		fireEvent.keyDown(thumbInput(container), { key: "Enter" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(onValueCommitted).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="field-number"]')).toBeNull();
		expect(container.querySelector("[data-slider-field-shell]")?.classList.contains("opacity-40")).toBe(true);
	});
});

describe("Slider rail contract", () => {
  it("ignores valueClassName entirely for the rail appearance", () => {
    const props = { value: 4, min: 0, max: 10, step: 1, "aria-label": "Bias", formatValue: (value: number) => String(value), onValueChange: () => {} };
    const view = render(<Slider {...props} />);
    const before = view.container.innerHTML;
    view.rerender(<Slider {...props} valueClassName="text-danger" />);
    expect(view.container.innerHTML).toBe(before);
    expect(view.container.querySelector(".text-danger")).toBeNull();
  });

	it("is the default appearance and keeps one orientation-specific gradient on the indicator", () => {
		const { container } = render(
			<div>
				<Slider value={1} min={0} max={2} step={1} aria-label="Horizontal" onValueChange={() => {}} />
				<Slider appearance="rail" value={1} min={0} max={2} step={1} aria-label="Explicit" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Vertical" orientation="vertical" onValueChange={() => {}} />
			</div>,
		);
		expect(container.querySelector("[data-slider-field]")).toBeNull();
		const indicators = container.querySelectorAll<HTMLElement>("[data-slider-indicator]");
		expect(indicators).toHaveLength(3);
		const toRight = "bg-[linear-gradient(to_right,var(--accent-mid),var(--accent))]";
		const toTop = "bg-[linear-gradient(to_top,var(--accent-mid),var(--accent))]";
		for (const index of [0, 1]) {
			expect(indicators[index]!.classList.contains(toRight)).toBe(true);
			expect(indicators[index]!.classList.contains(toTop)).toBe(false);
		}
		expect(indicators[2]!.classList.contains(toTop)).toBe(true);
		expect(indicators[2]!.classList.contains(toRight)).toBe(false);
	});

	it("sizes the knob ring per density and dims a disabled rail to 40 percent", () => {
		const { container } = render(
			<div>
				<Slider value={1} min={0} max={2} step={1} aria-label="Medium" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Small" size="sm" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Extra small" size="xs" onValueChange={() => {}} />
				<Slider value={1} min={0} max={2} step={1} aria-label="Off" disabled onValueChange={() => {}} />
			</div>,
		);
		const thumbs = container.querySelectorAll<HTMLElement>("[data-slider-thumb]");
		expect(thumbs[0]!.classList.contains("border-[3px]")).toBe(true);
		expect(thumbs[1]!.classList.contains("border-2")).toBe(true);
		expect(thumbs[2]!.classList.contains("border-2")).toBe(true);
		const roots = container.querySelectorAll<HTMLElement>("[data-slider-root]");
		const disabledRoot = roots[3]!;
		expect(disabledRoot.hasAttribute("data-disabled")).toBe(true);
		expect(disabledRoot.classList.contains("data-[disabled]:opacity-40")).toBe(true);
		expect(disabledRoot.classList.contains("data-[disabled]:pointer-events-none")).toBe(true);
	});

	it("tints the knob near-white with an accent ring and scales it only while dragging", () => {
		const { container } = render(<Slider value={1} min={0} max={2} step={1} aria-label="Knob" onValueChange={() => {}} />);
		const thumb = container.querySelector<HTMLElement>("[data-slider-thumb]");
		if (!thumb) throw new Error("Missing rail thumb");
		expect(thumb.classList.contains("bg-[color-mix(in_oklch,white_88%,var(--accent))]")).toBe(true);
		expect(thumb.classList.contains("border-accent")).toBe(true);
		expect(thumb.classList.contains("hover:shadow-[0_0_0_6px_color-mix(in_oklch,var(--accent)_18%,transparent)]")).toBe(true);
		expect(thumb.classList.contains("data-[dragging]:scale-[1.1]")).toBe(true);
		expect(thumb.classList.contains("hover:scale-[1.1]")).toBe(false);
	});
});
