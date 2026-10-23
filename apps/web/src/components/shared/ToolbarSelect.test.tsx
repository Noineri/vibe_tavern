/**
 * ToolbarSelect overlay-portal characterization.
 *
 * AP-27 follow-up 2 (owner-reported, «Настройки помощника» screenshot): the
 * desktop list rendered through a bare `<Select.Portal>` (into
 * `document.body`, z-220) and opened BEHIND any open Modal (overlay z-500 /
 * z-501). DropdownSelect already solved this by resolving the topmost
 * overlay's portal node once per open session (modal-helpers) and portaling
 * there; ToolbarSelect must do the same.
 *
 * No mocks: Radix Select.Content mounts under happy-dom (the older
 * "does not mount" notes predate the current happy-dom), so the tests open
 * the real list and assert where its `[role="listbox"]` lands — a direct
 * descendant of `document.body` outside any overlay (today's behavior), a
 * descendant of the modal's overlay anchor inside an open Modal.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let cleanup: typeof import("@testing-library/react").cleanup;
let ToolbarSelect: typeof import("./ToolbarSelect.js").ToolbarSelect;
let Modal: typeof import("./Modal.js").Modal;

beforeAll(async () => {
	({ render, fireEvent, waitFor, cleanup } = await import("@testing-library/react"));
	({ ToolbarSelect } = await import("./ToolbarSelect.js"));
	({ Modal } = await import("./Modal.js"));
});

// RTL cleanup unmounts the trees (including body-level portals), so each
// test opens against a pristine document — no innerHTML surgery (R6).
afterEach(() => {
	cleanup();
});

const twoItems = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
];

function trigger(testId: string) {
	return (
		<button type="button" data-testid={testId}>
			Pick
		</button>
	);
}

async function openSelect(testId: string): Promise<HTMLElement> {
	fireEvent.click(document.body.querySelector(`[data-testid="${testId}"]`)!);
	let listbox: HTMLElement | null = null;
	await waitFor(() => {
		listbox = document.body.querySelector('[role="listbox"]') as HTMLElement | null;
		expect(listbox).toBeTruthy();
	});
	return listbox!;
}

describe("ToolbarSelect portal target", () => {
	it("outside any overlay the list opens at the document body, as today", async () => {
		render(
			<ToolbarSelect
				trigger={trigger("ts-trigger-outside")}
				title="Models"
				items={twoItems}
				value={null}
				onSelect={() => {}}
			/>,
		);
		const listbox = await openSelect("ts-trigger-outside");
		expect(document.body.contains(listbox)).toBe(true);
		expect(document.body.querySelector("[data-overlay-portal]")).toBeNull();
	});

	it("inside an open Modal the list opens inside the modal's overlay anchor", async () => {
		render(
			<Modal open onClose={() => {}}>
				<ToolbarSelect
					trigger={trigger("ts-trigger-inside")}
					title="Models"
					items={twoItems}
					value={null}
					onSelect={() => {}}
				/>
			</Modal>,
		);
		await waitFor(() => expect(document.body.querySelector("#modal-portal")).toBeTruthy());
		const listbox = await openSelect("ts-trigger-inside");
		const anchor = document.body.querySelector("#modal-portal")!;
		expect(anchor.getAttribute("data-overlay-portal")).toBe("modal");
		expect(anchor.contains(listbox)).toBe(true);
	});
});
