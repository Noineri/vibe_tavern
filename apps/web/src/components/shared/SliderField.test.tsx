import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let SliderField: typeof import("./SliderField.js").SliderField;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ SliderField } = await import("./SliderField.js"));
});

function ControlledSliderField({
	initialValue = 4,
	onChange = () => {},
	onCommit,
	disabled,
	ariaLabel,
}: {
	initialValue?: number;
	onChange?: (value: number) => void;
	onCommit?: (value: number) => void;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	const [value, setValue] = useState(initialValue);

	return (
		<SliderField
			label="Volume"
			value={value}
			min={0}
			max={10}
			step={1}
			onChange={(nextValue) => {
				setValue(nextValue);
				onChange(nextValue);
			}}
			onCommit={onCommit}
			disabled={disabled}
			ariaLabel={ariaLabel}
			rangeTestId="volume-range"
			numberTestId="volume-number"
		/>
	);
}

function inputs(view: ReturnType<typeof render>) {
	const range = view.getByTestId("volume-range") as HTMLInputElement;
	const numberWrapper = view.getByTestId("volume-number");
	const number = numberWrapper.querySelector("input");
	if (!number) throw new Error("Missing number input");
	return { range, numberWrapper, number };
}

describe("SliderField", () => {
	it("renders its label and assigns the range test id to the actual range input", () => {
		const view = render(<ControlledSliderField />);
		const { range, numberWrapper } = inputs(view);

		expect(view.getByText("Volume")).toBeTruthy();
		expect(range.type).toBe("range");
		expect(numberWrapper.getAttribute("data-testid")).toBe("volume-number");
	});

	it("uses the explicit accessible name or defaults it to the label", () => {
		const defaultLabel = render(<ControlledSliderField />);
		expect(inputs(defaultLabel).range.getAttribute("aria-label")).toBe("Volume");
		defaultLabel.unmount();

		const explicitLabel = render(<ControlledSliderField ariaLabel="Playback volume" />);
		expect(inputs(explicitLabel).range.getAttribute("aria-label")).toBe("Playback volume");
	});

	it("keeps controlled range and number values synchronized", () => {
		const onChange = mock();
		const view = render(<ControlledSliderField onChange={onChange} />);
		const { range, number } = inputs(view);

		fireEvent.change(range, { target: { value: "6" } });
		expect(onChange).toHaveBeenLastCalledWith(6);
		expect(range.value).toBe("6");
		expect(number.value).toBe("6");
	});

	it("commits once through the slider's nested input completion boundary", () => {
		const onCommit = mock();
		const view = render(<ControlledSliderField onCommit={onCommit} />);
		const { range } = inputs(view);

		fireEvent.change(range, { target: { value: "6" } });
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(6);
	});

	it("clamps a number edit on blur, synchronizes it, and commits the entered value", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		const { range, number } = inputs(view);

		fireEvent.change(number, { target: { value: "12" } });
		fireEvent.blur(number);
		expect(onChange).toHaveBeenLastCalledWith(10);
		expect(number.value).toBe("10");
		expect(range.value).toBe("10");
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(10);
	});

	it("disables both inputs and ignores their interactions", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField disabled onChange={onChange} onCommit={onCommit} />);
		const { range, number } = inputs(view);

		expect(range.disabled).toBe(true);
		expect(number.disabled).toBe(true);
		fireEvent.change(range, { target: { value: "6" } });
		fireEvent.pointerUp(range);
		fireEvent.change(number, { target: { value: "7" } });
		fireEvent.blur(number);
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		expect(range.value).toBe("4");
	});
});
