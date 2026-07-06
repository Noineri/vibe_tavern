/**
 * ActionSheet characterization test.
 *
 * Pins the behavioral contract of the action-list layer built on BottomSheet
 * BEFORE the migration of BottomSheet to vaul. ActionSheet itself is NOT
 * rewritten — it stays a list renderer that passes its rows + Cancel button to
 * BottomSheet as children — but these tests guard the row/trailing/Cancel
 * contract that the shared BottomSheet swap must not disturb:
 *   - renders one row per item, labelled by item.label, under the title
 *   - tapping a row fires onClose FIRST, then item.action (close-before-action
 *     so any modal the action opens is not stacked on top of the sheet)
 *   - the Cancel button fires onClose without firing any item action
 *   - each trailing sub-action renders with aria-label=sub.label and fires
 *     onClose then sub.action (independent of the parent row's action)
 *   - tapping the parent row fires the parent action, NOT a trailing action
 *
 * What is deliberately NOT pinned: the row's tag/className specifics (a row is
 * a <button> today) and any BottomSheet chrome detail (covered by
 * BottomSheet.test.tsx). The "danger" styling is checked loosely (the class
 * name must carry the word) so a palette token rename does not break the test —
 * what matters is that a danger row is marked distinctly from a normal one.
 *
 * useT is mocked at the module boundary (returning keys verbatim) so the Cancel
 * button reads "cancel". The `...real` spread is kept (AGENTS.md mock.module
 * gotcha) so the process-global mock does not leak undefined exports into other
 * test files that import LocaleProvider etc.
 */
import { describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";

const i18nReal = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
	...i18nReal,
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

import { ActionSheet, type ActionSheetItem } from "./ActionSheet.js";

useDomEnv();

function item(overrides: Partial<ActionSheetItem> & { label: string }): ActionSheetItem {
	return {
		icon: <span data-testid="ico">★</span>,
		action: () => {},
		...overrides,
	};
}

/** Find the first <button> whose accessible text contains `label`. Rows and the
 *  Cancel button are all <button>s, so this is how callers (and users) reach
 *  them. */
function buttonByLabel(doc: Document, label: string): HTMLButtonElement {
	const btn = [...doc.querySelectorAll<HTMLButtonElement>("button")]
		.find((b) => (b.textContent ?? "").includes(label));
	if (!btn) throw new Error(`no <button> containing "${label}"`);
	return btn;
}

describe("ActionSheet", () => {
	it("open=false renders nothing", () => {
		render(<ActionSheet open={false} title="t" items={[item({ label: "Hidden" })]} onClose={() => {}} />);
		expect(document.body.textContent).not.toContain("Hidden");
	});

	it("renders one row per item, labelled by item.label, under the title", () => {
		render(
			<ActionSheet open={true} title="My Title"
				items={[item({ label: "Alpha" }), item({ label: "Beta" })]}
				onClose={() => {}} />,
		);
		expect(document.body.textContent).toContain("My Title");
		expect(document.body.textContent).toContain("Alpha");
		expect(document.body.textContent).toContain("Beta");
		expect(buttonByLabel(document, "Alpha")).toBeTruthy();
		expect(buttonByLabel(document, "Beta")).toBeTruthy();
	});

	it("tapping a row fires onClose THEN item.action (in that order)", () => {
		// close-before-action is load-bearing: callers open a modal from the
		// action and must not have it stacked on top of the still-open sheet.
		const calls: string[] = [];
		render(
			<ActionSheet open={true} title="t"
				items={[item({ label: "Run me", action: () => calls.push("action") })]}
				onClose={() => calls.push("close")} />,
		);
		fireEvent.click(buttonByLabel(document, "Run me"));
		expect(calls).toEqual(["close", "action"]);
	});

	it("the Cancel button fires onClose but no item action", () => {
		const calls: string[] = [];
		render(
			<ActionSheet open={true} title="t"
				items={[item({ label: "X", action: () => calls.push("action") })]}
				onClose={() => calls.push("close")} />,
		);
		fireEvent.click(buttonByLabel(document, "cancel"));
		expect(calls).toEqual(["close"]);
	});

	it("trailing sub-actions render with aria-label and fire onClose then sub.action", () => {
		const calls: string[] = [];
		render(
			<ActionSheet open={true} title="t"
				items={[item({
					label: "Parent",
					action: () => calls.push("parent"),
					trailing: [
						{ icon: <span>✎</span>, label: "Rename", action: () => calls.push("rename") },
					],
				})]}
				onClose={() => calls.push("close")} />,
		);
		const rename = document.querySelector<HTMLElement>('[aria-label="Rename"]');
		if (!rename) throw new Error("trailing Rename button (aria-label) not rendered");
		fireEvent.click(rename);
		expect(calls).toEqual(["close", "rename"]);
	});

	it("tapping the parent row fires the parent action, NOT a trailing action", () => {
		const calls: string[] = [];
		render(
			<ActionSheet open={true} title="t"
				items={[item({
					label: "Parent",
					action: () => calls.push("parent"),
					trailing: [
						{ icon: <span>✎</span>, label: "Rename", action: () => calls.push("rename") },
					],
				})]}
				onClose={() => calls.push("close")} />,
		);
		fireEvent.click(buttonByLabel(document, "Parent"));
		expect(calls).toEqual(["close", "parent"]);
	});

	it("renders a danger item distinctly from a normal one", () => {
		render(
			<ActionSheet open={true} title="t"
				items={[
					item({ label: "Safe" }),
					item({ label: "Nuke", danger: true }),
				]}
				onClose={() => {}} />,
		);
		const safe = buttonByLabel(document, "Safe");
		const danger = buttonByLabel(document, "Nuke");
		expect(safe.className).not.toContain("danger");
		expect(danger.className).toContain("danger");
	});
});
