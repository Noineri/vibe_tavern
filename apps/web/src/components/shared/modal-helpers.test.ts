import { describe, expect, it } from "bun:test";
import { modalPanelCls } from "./modal-helpers.js";

// SS-6B: modalPanelCls is the single source of the canon modal panel chrome.
// Every desktop Modal caller composes it via cn(modalPanelCls, <sizes>);
// this pins the token contract so a quiet edit cannot reintroduce the
// glass-theme see-through (bg-surface) or drop the pseudo-clipping.
describe("modalPanelCls — canon glass-safe panel chrome (SS-6B single source)", () => {
	const tokens = modalPanelCls.split(/\s+/);

	it("carries the canon shape: rounded-xl, border-border2, canon shadow, overflow-hidden", () => {
		for (const token of [
			"rounded-xl",
			"border",
			"border-border2",
			"shadow-[0_24px_60px_rgba(0,0,0,.5)]",
			"overflow-hidden",
		]) {
			expect(tokens).toContain(token);
		}
	});

	it("is glass-safe: glass-blur-under fill, never a bg-surface fill", () => {
		expect(tokens).toContain("glass-blur-under");
		expect(tokens.some((token) => token.startsWith("bg-"))).toBe(false);
	});

	it("carries no layout extras: flex, sizes, and mobile branches stay caller-owned", () => {
		for (const token of ["flex", "flex-col", "w-full", "h-full"]) {
			expect(tokens).not.toContain(token);
		}
	});
});
