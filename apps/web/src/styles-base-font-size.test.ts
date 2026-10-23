import { describe, expect, it } from "bun:test";

// Pins font audit step 2b: text without a size class follows the UI font
// size setting through the base body rule. The root (html) keeps the
// browser default so rem utilities do not move.

function baseLayer(css: string): string {
	const start = css.indexOf("@layer base");
	if (start < 0) throw new Error("@layer base not found in styles.css");
	const open = css.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, i);
		}
	}
	throw new Error("@layer base block never closes in styles.css");
}

function rulesIn(base: string): Array<{ selectors: string[]; body: string }> {
	return [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
		selectors: m[1].split(",").map((s) => s.trim()),
		body: m[2],
	}));
}

describe("styles.css base font size (font audit step 2b)", () => {
	it("sets font-size: var(--ui-fs) on body inside @layer base", async () => {
		const css = await Bun.file(`${import.meta.dir}/styles.css`).text();
		const rules = rulesIn(baseLayer(css));
		const bodyRule = rules.find(
			(r) => r.selectors.length === 1 && r.selectors[0] === "body",
		);
		if (!bodyRule) throw new Error("no standalone body rule in @layer base");
		expect(bodyRule.body.replace(/\s+/g, "")).toContain(
			"font-size:var(--ui-fs);",
		);
	});

	it("sets no font-size on html (the root stays at the browser default so rem utilities do not move)", async () => {
		const css = await Bun.file(`${import.meta.dir}/styles.css`).text();
		const rules = rulesIn(baseLayer(css));
		for (const rule of rules) {
			if (rule.selectors.includes("html")) {
				expect(rule.body.replace(/\s+/g, "")).not.toContain("font-size");
			}
		}
	});
});
