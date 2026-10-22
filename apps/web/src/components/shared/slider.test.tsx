import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let Slider: typeof import("./slider.js").Slider;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ Slider } = await import("./slider.js"));
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

	it("uses the approved soft accent halo on the focused rail thumb", () => {
		const { container } = render(
			<Slider value={1} min={0} max={2} step={1} aria-label="Focus" onValueChange={() => {}} />,
		);
		const thumb = container.querySelector<HTMLElement>("[data-slider-thumb]");

		if (!thumb) throw new Error("Missing slider thumb");
		expect(thumb.querySelector('input[type="range"]')).not.toBeNull();
		expect(thumb.classList.contains("has-[input:focus-visible]:shadow-[0_0_0_6px_var(--accent-hover)]")).toBe(true);
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

	it("sets a field value from the pointer and supports the approved keyboard and inline edit commits", () => {
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
		fireEvent.keyDown(rangeInput, { key: "ArrowRight", shiftKey: true });
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		fireEvent.keyDown(rangeInput, { key: "Enter" });
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "9" } });
		fireEvent.keyDown(editor, { key: "Enter" });
		expect(onValueChange).toHaveBeenLastCalledWith(10);
		expect(onValueCommitted).toHaveBeenLastCalledWith(10);
	});

	it("cancels a field inline edit without changing the controlled value", () => {
		const onValueChange = mock();
		const { container } = render(<ControlledField onValueChange={onValueChange} />);
		const field = container.querySelector<HTMLElement>("[data-slider-field]");
		if (!field) throw new Error("Missing field slider");
		fireEvent.doubleClick(field);
		const editor = input(container, "field-number");
		fireEvent.change(editor, { target: { value: "10" } });
		fireEvent.keyDown(editor, { key: "Escape" });
		expect(onValueChange).not.toHaveBeenCalled();
		expect(container.querySelector("[data-slider-field-value]")?.textContent).toBe("4");
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

	it("shows a rail value bubble only while a formatted thumb is focused", () => {
		const { container } = render(<Slider value={4} min={0} max={10} step={1} aria-label="Seek" formatValue={(value) => `at ${value}`} onValueChange={() => {}} />);
		const rangeInput = container.querySelector<HTMLInputElement>('input[type="range"]');
		if (!rangeInput) throw new Error("Missing rail input");
		expect(container.querySelector("[data-slider-bubble]")).toBeNull();
		fireEvent.focus(rangeInput);
		expect(container.querySelector("[data-slider-bubble]")?.textContent).toBe("at 4");
		fireEvent.blur(rangeInput);
		expect(container.querySelector("[data-slider-bubble]")).toBeNull();
	});
});
