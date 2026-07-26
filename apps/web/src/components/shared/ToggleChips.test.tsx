/**
 * ToggleChips characterization test.
 *
 * Pins the multi-select chip-group contract before migration to
 * @radix-ui/react-toggle-group (`type="multiple"`). The migration adds
 * `aria-pressed`, a group role, and roving tabindex (today every chip is its
 * own Tab stop); it must NOT change the contract pinned here:
 *   - one chip renders per option, showing the option's label
 *   - clicking an inactive chip adds it (onChange includes the new value)
 *   - clicking an active chip removes it (onChange excludes the value)
 *   - multiple chips can be selected at once (it is multi-select, not single)
 *   - `disabled` blocks every chip
 *
 * Sole consumer today: LoreEntryEditor character-filter picker.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

let ToggleChips: typeof import("./ToggleChips.js").ToggleChips;

beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ ToggleChips } = await import("./ToggleChips.js"));
});


const opts = [
	{ value: "a", label: "Apple" },
	{ value: "b", label: "Banana" },
	{ value: "c", label: "Cherry" },
];

describe("ToggleChips", () => {
	it("renders one button per option with its label", () => {
		const { getAllByRole } = render(
			<ToggleChips selected={[]} options={opts} onChange={() => {}} />,
		);
		const chips = getAllByRole("button");
		expect(chips).toHaveLength(3);
		expect(chips.map((c) => c.textContent)).toEqual(["Apple", "Banana", "Cherry"]);
	});

	it("clicking an inactive chip adds it to the selection", () => {
		const onChange = mock();
		const { getByText } = render(
			<ToggleChips selected={[]} options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Banana"));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(["b"]);
	});

	it("clicking an active chip removes it from the selection", () => {
		const onChange = mock();
		const { getByText } = render(
			<ToggleChips selected={["a", "b"]} options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Apple"));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenLastCalledWith(["b"]);
	});

	it("is multi-select: selecting a third chip keeps the existing two", () => {
		const onChange = mock();
		const { getByText } = render(
			<ToggleChips selected={["a", "b"]} options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Cherry"));
		expect(onChange).toHaveBeenLastCalledWith(["a", "b", "c"]);
	});

	it("disabled blocks every chip", () => {
		const onChange = mock();
		const { getByText } = render(
			<ToggleChips selected={[]} options={opts} onChange={onChange} disabled />,
		);
		fireEvent.click(getByText("Apple"));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("preserves order independence: removing the first chip keeps the rest", () => {
		const onChange = mock();
		const { getByText } = render(
			<ToggleChips selected={["a", "b", "c"]} options={opts} onChange={onChange} />,
		);
		fireEvent.click(getByText("Apple"));
		expect(onChange).toHaveBeenLastCalledWith(["b", "c"]);
	});
});
