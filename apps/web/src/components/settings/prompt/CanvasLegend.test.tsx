/**
 * CanvasLegend — render characterization (APC-3c).
 *
 * Pins the legend's collapsible contract: collapsed by default (toggle button
 * only, no category rows), expands on click to show all five categories with
 * their registry icon + label. The icon set comes from the SAME
 * SLOT_CATEGORY_ICON registry the cards use, so this also guards that every
 * category resolves to a renderable glyph (no `undefined` icon).
 *
 * useT mocked at the module boundary (safe spread + override pattern).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { render, fireEvent } = await import("@testing-library/react");
let CanvasLegend: typeof import("./CanvasLegend.js").CanvasLegend;

beforeAll(async () => {
	({ CanvasLegend } = await import("./CanvasLegend.js"));
});

describe("CanvasLegend — collapsible render contract", () => {
	it("collapsed by default: toggle button present, no category rows", () => {
		const { getByText, container } = render(<CanvasLegend />);
		expect(getByText("cc_legend_toggle")).toBeTruthy();
		// no category labels rendered while collapsed
		expect(container.textContent).not.toContain("cc_legend_standard");
	});

	it("expanding reveals all five categories, each with an icon", () => {
		const { getByText, container } = render(<CanvasLegend />);
		fireEvent.click(getByText("cc_legend_toggle"));
		// every category's label + description key renders
		for (const cat of ["standard", "character", "persona", "anchor", "custom"] as const) {
			expect(container.textContent).toContain(`cc_legend_${cat}`);
			expect(container.textContent).toContain(`cc_legend_${cat}_desc`);
		}
		// five category icons (one svg per category) render — guards that every
		// SLOT_CATEGORY_ICON entry resolves to a real glyph, not undefined
		expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(5);
	});

	it("toggling twice collapses again", () => {
		const { getByText, container } = render(<CanvasLegend />);
		fireEvent.click(getByText("cc_legend_toggle"));
		expect(container.textContent).toContain("cc_legend_standard");
		fireEvent.click(getByText("cc_legend_toggle"));
		expect(container.textContent).not.toContain("cc_legend_standard");
	});
});
