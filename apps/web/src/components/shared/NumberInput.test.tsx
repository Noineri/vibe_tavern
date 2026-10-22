import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let act: typeof import("@testing-library/react").act;
let NumberInput: typeof import("./NumberInput.js").NumberInput;

beforeAll(async () => {
	({ render, fireEvent, act } = await import("@testing-library/react"));
	({ NumberInput } = await import("./NumberInput.js"));
});

function textbox(container: HTMLElement): HTMLInputElement {
	const element = container.querySelector<HTMLInputElement>("input");
	if (!element) throw new Error("Missing number input");
	return element;
}

describe("NumberInput", () => {
	it("renders a decimal text field with stepper buttons unless the controls are hidden", () => {
		const withControls = render(<NumberInput value={3} onChange={() => {}} />);
		const field = textbox(withControls.container);
		expect(field.type).toBe("text");
		expect(field.getAttribute("inputmode")).toBe("decimal");
		expect(field.value).toBe("3");
		expect(withControls.container.querySelectorAll("button")).toHaveLength(2);
		const bare = render(<NumberInput value={3} hideControls onChange={() => {}} />);
		expect(bare.container.querySelectorAll("button")).toHaveLength(0);
	});

	it("clamps a typed value on blur and reports it once", () => {
		const onChange = mock();
		const { container } = render(<NumberInput value={3} min={0} max={10} onChange={onChange} />);
		const field = textbox(container);
		fireEvent.change(field, { target: { value: "99" } });
		fireEvent.blur(field);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(10);
		expect(field.value).toBe("10");
	});

	it("reports nothing for an unchanged or unparsable draft and restores the shown value", () => {
		const onChange = mock();
		const { container } = render(<NumberInput value={3} min={0} max={10} onChange={onChange} />);
		const field = textbox(container);
		fireEvent.change(field, { target: { value: "3" } });
		fireEvent.blur(field);
		fireEvent.change(field, { target: { value: "abc" } });
		fireEvent.blur(field);
		expect(onChange).not.toHaveBeenCalled();
		expect(field.value).toBe("3");
	});

	it("commits on Enter by blurring the focused input", () => {
		const onChange = mock();
		const onBlur = mock();
		const { container } = render(<NumberInput value={3} min={0} max={10} onChange={onChange} onBlur={onBlur} />);
		const field = textbox(container);
		act(() => field.focus());
		fireEvent.change(field, { target: { value: "7" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(7);
		expect(onBlur).toHaveBeenCalledTimes(1);
	});

	it("steps with the arrow keys within the bounds", () => {
		const onChange = mock();
		const { container } = render(<NumberInput value={9} min={0} max={10} step={2} onChange={onChange} />);
		const field = textbox(container);
		fireEvent.keyDown(field, { key: "ArrowUp" });
		expect(onChange).toHaveBeenLastCalledWith(10);
		fireEvent.keyDown(field, { key: "ArrowDown" });
		expect(onChange).toHaveBeenLastCalledWith(8);
	});

	it("leaves the draft alone on Escape and adds no test id unless asked", () => {
		const onChange = mock();
		const { container } = render(<NumberInput value={3} onChange={onChange} />);
		const field = textbox(container);
		fireEvent.change(field, { target: { value: "8" } });
		fireEvent.keyDown(field, { key: "Escape" });
		expect(field.value).toBe("8");
		expect(onChange).not.toHaveBeenCalled();
		expect(field.hasAttribute("data-testid")).toBe(false);
	});

	it("puts an optional test id on the real input, not on the wrapper", () => {
		const { container } = render(<NumberInput value={3} inputTestId="amount" onChange={() => {}} />);
		const tagged = container.querySelector('[data-testid="amount"]');
		expect(tagged).toBe(textbox(container));
	});

	it("focuses and selects its text on mount only when asked to", () => {
		const plain = render(<NumberInput value={42} onChange={() => {}} />);
		expect(document.activeElement).not.toBe(textbox(plain.container));
		const focused = render(<NumberInput value={42} autoFocus onChange={() => {}} />);
		const field = textbox(focused.container);
		expect(document.activeElement).toBe(field);
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe(2);
	});

	it("reports Escape to an optional handler without committing the draft", () => {
		const onChange = mock();
		const onEscape = mock();
		const { container } = render(<NumberInput value={3} onChange={onChange} onEscape={onEscape} />);
		const field = textbox(container);
		fireEvent.change(field, { target: { value: "8" } });
		fireEvent.keyDown(field, { key: "a" });
		expect(onEscape).not.toHaveBeenCalled();
		fireEvent.keyDown(field, { key: "Escape" });
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("hands the blur event to onBlur so callers can see where focus is going", () => {
		const onBlur = mock();
		const { container } = render(
			<div>
				<NumberInput value={3} onChange={() => {}} onBlur={onBlur} />
				<button type="button">next</button>
			</div>,
		);
		const next = container.querySelector<HTMLButtonElement>("button:not([tabindex])");
		if (!next) throw new Error("Missing next control");
		fireEvent.blur(textbox(container), { relatedTarget: next });
		expect(onBlur).toHaveBeenCalledTimes(1);
		expect(onBlur.mock.calls[0]![0].relatedTarget).toBe(next);
	});
});
