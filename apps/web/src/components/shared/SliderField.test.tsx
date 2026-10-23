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
	help,
}: {
	initialValue?: number;
	onChange?: (value: number) => void;
	onCommit?: (value: number) => void;
	disabled?: boolean;
	ariaLabel?: string;
	help?: React.ReactNode;
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
			help={help}
			rangeTestId="volume-range"
			numberTestId="volume-number"
		/>
	);
}

function range(view: ReturnType<typeof render>) {
	return view.getByTestId("volume-range") as HTMLInputElement;
}

function field(view: ReturnType<typeof render>) {
	const element = view.container.querySelector<HTMLElement>("[data-slider-field]");
	if (!element) throw new Error("Missing slider field");
	return element;
}

/** The field's value text; absent while the inline editor replaces it. */
function valueText(view: ReturnType<typeof render>) {
	return view.container.querySelector("[data-slider-field-value]")?.textContent;
}

/** Seam: the number box beside the slider is now the field's inline editor, opened by double-click. */
function openEditor(view: ReturnType<typeof render>) {
	fireEvent.doubleClick(field(view));
	return view.getByTestId("volume-number") as HTMLInputElement;
}

function withGeometry(element: HTMLElement) {
	Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, width: 100 }) });
}

describe("SliderField", () => {
	it("renders its label inside the field and assigns the range test id to the actual range input", () => {
		const view = render(<ControlledSliderField />);

		expect(range(view).type).toBe("range");
		expect(view.container.querySelector("label")).toBeNull();
		expect(view.container.querySelector("[data-slider-field-shell]")?.textContent).toContain("Volume");
		expect(view.container.querySelector("[data-slider-field-label]")?.textContent).toBe("Volume");
		expect(valueText(view)).toBe("4");
	});

	it("puts the number test id on the inline editor's real input, which exists only while typing", () => {
		const view = render(<ControlledSliderField />);

		expect(view.queryByTestId("volume-number")).toBeNull();
		const editor = openEditor(view);
		expect(editor.tagName).toBe("INPUT");
		expect(editor.value).toBe("4");
		expect(valueText(view)).toBeUndefined();
	});

	it("uses the explicit accessible name or defaults it to the label", () => {
		const defaultLabel = render(<ControlledSliderField />);
		expect(range(defaultLabel).getAttribute("aria-label")).toBe("Volume");
		defaultLabel.unmount();

		const explicitLabel = render(<ControlledSliderField ariaLabel="Playback volume" />);
		expect(range(explicitLabel).getAttribute("aria-label")).toBe("Playback volume");
	});

	it("keeps the controlled range and the displayed value synchronized", () => {
		const onChange = mock();
		const view = render(<ControlledSliderField onChange={onChange} />);

		fireEvent.change(range(view), { target: { value: "6" } });
		expect(onChange).toHaveBeenLastCalledWith(6);
		expect(range(view).value).toBe("6");
		expect(valueText(view)).toBe("6");
	});

	it("commits once through the slider's nested input completion boundary", () => {
		const onCommit = mock();
		const view = render(<ControlledSliderField onCommit={onCommit} />);

		fireEvent.change(range(view), { target: { value: "6" } });
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(6);
	});

	it("scrubs per tick through onChange and commits once on release", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		withGeometry(field(view));

		fireEvent.pointerDown(field(view), { pointerId: 1, pointerType: "mouse", clientX: 30, button: 0 });
		expect(onChange).toHaveBeenLastCalledWith(3);
		fireEvent.pointerMove(field(view), { pointerId: 1, pointerType: "mouse", clientX: 70 });
		expect(onChange).toHaveBeenLastCalledWith(7);
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.pointerUp(field(view), { pointerId: 1, pointerType: "mouse", clientX: 70 });
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(7);
		expect(valueText(view)).toBe("7");
	});

	it("keeps a typed value between steps exactly instead of snapping it to the step grid", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		const editor = openEditor(view);

		fireEvent.change(editor, { target: { value: "7.5" } });
		fireEvent.keyDown(editor, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith(7.5);
		expect(onCommit).toHaveBeenLastCalledWith(7.5);
		expect(valueText(view)).toBe("7.5");
	});

	it("opens the inline editor from the keyboard", () => {
		const view = render(<ControlledSliderField />);

		fireEvent.keyDown(range(view), { key: "Enter" });
		expect(view.getByTestId("volume-number")).toBeTruthy();
	});

	it("clamps an inline edit on blur, synchronizes it, and commits the entered value once", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		const editor = openEditor(view);

		fireEvent.change(editor, { target: { value: "12" } });
		fireEvent.blur(editor);
		expect(onChange).toHaveBeenLastCalledWith(10);
		expect(view.queryByTestId("volume-number")).toBeNull();
		expect(valueText(view)).toBe("10");
		expect(range(view).value).toBe("10");
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(10);
	});

	it("commits an inline edit on Enter exactly once", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		const editor = openEditor(view);

		fireEvent.change(editor, { target: { value: "8" } });
		fireEvent.keyDown(editor, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith(8);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenLastCalledWith(8);
		expect(valueText(view)).toBe("8");
	});

	it("cancels an inline edit on Escape without changing or committing anything", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField onChange={onChange} onCommit={onCommit} />);
		const editor = openEditor(view);

		fireEvent.change(editor, { target: { value: "9" } });
		fireEvent.keyDown(editor, { key: "Escape" });
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		expect(view.queryByTestId("volume-number")).toBeNull();
		expect(valueText(view)).toBe("4");
	});

	it("applies an inline edit through onChange even when the surface has no onCommit", () => {
		const onChange = mock();
		const view = render(<ControlledSliderField onChange={onChange} />);
		const editor = openEditor(view);

		fireEvent.change(editor, { target: { value: "5" } });
		fireEvent.blur(editor);
		expect(onChange).toHaveBeenLastCalledWith(5);
		expect(valueText(view)).toBe("5");
	});

	it("renders the help node inside the field and pressing it never scrubs the value", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(
			<ControlledSliderField
				onChange={onChange}
				onCommit={onCommit}
				help={<button type="button" data-testid="volume-help">?</button>}
			/>,
		);
		withGeometry(field(view));

		const help = view.getByTestId("volume-help");
		expect(view.container.querySelector("[data-slider-field-label]")?.contains(help)).toBe(true);
		fireEvent.pointerDown(help, { pointerId: 1, pointerType: "mouse", clientX: 90, button: 0 });
		fireEvent.pointerUp(help, { pointerId: 1, pointerType: "mouse", clientX: 90 });
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		expect(valueText(view)).toBe("4");
	});

	it("disables the range and the inline editor and ignores their interactions", () => {
		const onChange = mock();
		const onCommit = mock();
		const view = render(<ControlledSliderField disabled onChange={onChange} onCommit={onCommit} />);
		withGeometry(field(view));

		expect(range(view).disabled).toBe(true);
		fireEvent.change(range(view), { target: { value: "6" } });
		fireEvent.pointerDown(field(view), { pointerId: 1, pointerType: "mouse", clientX: 90, button: 0 });
		fireEvent.pointerUp(field(view), { pointerId: 1, pointerType: "mouse", clientX: 90 });
		fireEvent.pointerUp(range(view));
		fireEvent.keyDown(range(view), { key: "Enter" });
		fireEvent.doubleClick(field(view));
		expect(view.queryByTestId("volume-number")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		expect(range(view).value).toBe("4");
	});
});
