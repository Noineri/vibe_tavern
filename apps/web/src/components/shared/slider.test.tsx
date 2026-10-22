import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

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
	return <Slider appearance="field" value={value} min={0} max={10} step={2} label="Temperature" aria-label="Temperature" numberTestId="field-number" onValueChange={(next) => { setValue(next); onValueChange(next); }} onValueCommitted={onValueCommitted} />;
}

function ControlledRangeField({ onValueChange = () => {} }: { onValueChange?: (value: [number, number]) => void }) {
	const [value, setValue] = useState<[number, number]>([2, 6]);
	return <Slider appearance="field" value={value} min={0} max={10} step={1} label="Range" getAriaLabel={(index) => index === 0 ? "From" : "To"} onValueChange={(next) => { setValue(next); onValueChange(next); }} />;
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
		expect(container.querySelector("[data-slider-field-label-above]")?.textContent).toBe("Temperature");
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		fireEvent.doubleClick(field);
		expect(input(container, "temperature-number").type).toBe("number");
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
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		expect(onValueCommitted).toHaveBeenLastCalledWith(10);
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

	it("snaps an inline draft and commits exactly once on blur", () => {
		const onValueChange = mock();
		const onValueCommitted = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} onValueCommitted={onValueCommitted} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		fireEvent.doubleClick(field);
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "9" } });
		fireEvent.blur(editor);
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		expect(onValueCommitted).toHaveBeenLastCalledWith(10);
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
		expect(bubble.classList.contains("data-[dragging]:block")).toBe(true);
		expect(bubble.classList.contains("has-[input:focus-visible]:block")).toBe(true);
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

	it("moves labels above and back inside without losing help on observer-driven width changes", () => {
		const callbacks: (() => void)[] = [];
		class ResizeObserverMock implements ResizeObserver {
			constructor(callback: ResizeObserverCallback) { callbacks.push(() => callback([], this)); }
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() { return []; }
		}
		globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
		const { container } = render(<Slider appearance="field" value={4} min={0} max={10} step={1} label="Temperature" help={<button type="button">?</button>} aria-label="Temperature" onValueChange={() => {}} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		let width = 300;
		Object.defineProperty(field, "clientWidth", { configurable: true, get: () => width });
		const label = container.querySelector<HTMLElement>("[data-slider-field-measure-label]");
		const value = container.querySelector<HTMLElement>("[data-slider-field-measure-value]");
		if (!label || !value) throw new Error("Missing field measurements");
		Object.defineProperty(label, "scrollWidth", { configurable: true, value: 120 });
		Object.defineProperty(value, "scrollWidth", { configurable: true, value: 30 });
		act(() => callbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label]")?.textContent).toBe("Temperature?");
		width = 100;
		act(() => callbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label-above]")?.textContent).toBe("Temperature?");
		width = 300;
		act(() => callbacks.forEach((callback) => callback()));
		expect(container.querySelector("[data-slider-field-label]")?.textContent).toBe("Temperature?");
	});

	it("avoids NaN geometry and an accent edge at the scalar minimum, and formats tuples as a whole value", () => {
		const { container } = render(<Slider appearance="field" value={0} min={0} max={10} step={1} aria-label="Minimum" onValueChange={() => {}} />);
		const fill = container.querySelector<HTMLElement>("[data-slider-field-fill]");
		if (!fill) throw new Error("Missing field fill");
		expect(fill.style.width).toBe("0%");
		expect(fill.classList.contains("border-r-2")).toBe(false);
		const degenerate = render(<Slider appearance="field" value={[1, 1]} min={1} max={1} step={1} getAriaLabel={(index) => String(index)} onValueChange={() => {}} />);
		expect(degenerate.container.innerHTML.includes("NaN%")).toBe(false);
		const tuple = render(<Slider appearance="field" value={[1, 10]} min={1} max={10} step={1} getAriaLabel={(index) => String(index)} formatValue={(value) => `${value[0]} – ${value[1]} · 10 messages`} onValueChange={() => {}} />);
		expect(tuple.container.querySelector("[data-slider-field-value]")?.textContent).toBe("1 – 10 · 10 messages");
	});
});
