/**
 * Toggle characterization test.
 *
 * Pins the behavioral contract of the on/off toggle BEFORE the migration to a
 * wrapped @radix-ui/react-switch. The migration changes the underlying role
 * from `checkbox` to `switch` (the WAI-ARIA-correct role for a two-state
 * on/off affordance) and adds keyboard support (Space/Enter), but must NOT
 * change the contract tested here:
 *   - clicking the toggle reflects `checked` and fires `onChange(true/false)`
 *   - `disabled` blocks the change
 *   - `id` associates the control with a `<label htmlFor>` (used by every
 *     call site that wraps Toggle in a text label, e.g. ContextMemoryModal)
 *   - `className` applies to the control's container (call sites pass sizing
 *     overrides like `!inline-flex` and `text-[18px]`)
 *
 * What is deliberately NOT pinned: the DOM tag (`label`+`input` today,
 * `button` under Radix Switch) and the exact role (`checkbox` today,
 * `switch` after). Those are the things the migration intentionally changes;
 * pinning them would make the test fight the migration. The selector is
 * resolved at runtime via a small helper so the behavioral assertions below
 * stay valid across both implementations.
 */
import { describe, it, expect, vi } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";
import { Toggle } from "./Toggle.js";

useDomEnv();

/** Resolves the interactive control — `input[type=checkbox]` today,
 *  `button[role=switch]` after the Radix migration. */
function control(container: HTMLElement): HTMLElement {
	const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
	if (input) return input;
	const sw = container.querySelector<HTMLElement>('[role="switch"]');
	if (sw) return sw;
	throw new Error("Toggle rendered neither an input[type=checkbox] nor a [role=switch]");
}

/** Whether the control is currently in the checked/pressed state. */
function isChecked(container: HTMLElement): boolean {
	const input = container.querySelector<HTMLInputElement>("input[type=checkbox]");
	if (input) return input.checked;
	const sw = container.querySelector<HTMLElement>('[role="switch"]');
	if (sw) return sw.getAttribute("aria-checked") === "true";
	return false;
}

describe("Toggle", () => {
	it("reflects checked={false} / checked={true} on the control", () => {
		const { container: c1 } = render(<Toggle checked={false} onChange={() => {}} />);
		expect(isChecked(c1)).toBe(false);
		const { container: c2 } = render(<Toggle checked={true} onChange={() => {}} />);
		expect(isChecked(c2)).toBe(true);
	});

	it("clicking an unchecked toggle fires onChange(true)", () => {
		const onChange = vi.fn();
		const { container } = render(<Toggle checked={false} onChange={onChange} />);
		fireEvent.click(control(container));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it("clicking a checked toggle fires onChange(false)", () => {
		const onChange = vi.fn();
		const { container } = render(<Toggle checked={true} onChange={onChange} />);
		fireEvent.click(control(container));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(false);
	});

	it("disabled blocks onChange", () => {
		const onChange = vi.fn();
		const { container } = render(<Toggle checked={false} onChange={onChange} disabled />);
		fireEvent.click(control(container));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("id associates the control with a sibling <label htmlFor>", () => {
		// Every Toggle call site that wraps it in a text label relies on this —
		// clicking the text label must toggle the control.
		const onChange = vi.fn();
		const { container } = render(
			<div>
				<label htmlFor="my-toggle">Enable feature</label>
				<Toggle id="my-toggle" checked={false} onChange={onChange} />
			</div>,
		);
		const label = container.querySelector<HTMLLabelElement>("label[for='my-toggle']")!;
		fireEvent.click(label);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it("className applies to the toggle's container", () => {
		const { container } = render(
			<Toggle checked={false} onChange={() => {}} className="my-override" />,
		);
		// The override lands on the outermost element regardless of whether the
		// implementation is a <label> (today) or a Radix Switch.Root (tomorrow).
		expect((container.firstChild as HTMLElement).classList.contains("my-override")).toBe(true);
	});
});
