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

	it("uses the approved size, orientation, and coarse-pointer hit-area classes", () => {
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
			</div>,
		);
		const roots = container.querySelectorAll<HTMLElement>("[data-slider-root]");

		expect(roots).toHaveLength(4);
		expect(roots[0].classList.contains("h-11")).toBe(true);
		expect(roots[1].classList.contains("h-11")).toBe(true);
		expect(roots[2].classList.contains("h-11")).toBe(true);
		expect(roots[0].querySelector("[data-slider-thumb]")!.classList.contains("h-[14px]")).toBe(true);
		expect(roots[1].querySelector("[data-slider-thumb]")!.classList.contains("h-3")).toBe(true);
		expect(roots[2].querySelector("[data-slider-thumb]")!.classList.contains("h-2.5")).toBe(true);
		expect(roots[3].getAttribute("data-orientation")).toBe("vertical");
		expect(roots[3].classList.contains("w-11")).toBe(true);
	});
});
