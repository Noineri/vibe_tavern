import { describe, expect, it } from "bun:test";
import {
	DROPPED_ST_MACROS,
	findDroppedStMacroWarnings,
} from "../src/dropped-st-macro-warnings.js";
import { getMacroCatalog } from "../src/macro-catalog.js";

/**
 * Step 8 of reports/st-macro-parity.md: importing a card or preset that uses
 * an ST macro VT deliberately does NOT support produces the import warning
 * «macro X is not supported in VT — use Y» (Y from the report's Verdict).
 * Supported macros — everything registered in the one macro registry, which
 * includes every name steps 3–7 added — are never warned.
 */

describe("findDroppedStMacroWarnings", () => {
	it("warns for the report's card example: {{lastSwipeId}} → scripts", () => {
		expect(findDroppedStMacroWarnings(["Mood swing: {{lastSwipeId}}"])).toEqual([
			"Macro {{lastSwipeId}} is not supported in VT — use scripts instead.",
		]);
	});

	it("warns for the report's preset example: {{wiBefore}} → preset layers and the generation format", () => {
		expect(findDroppedStMacroWarnings(["{{wiBefore}} world info"])).toEqual([
			"Macro {{wiBefore}} is not supported in VT — use preset layers and the generation format instead.",
		]);
	});

	it("never warns for supported macros, including every step 3–7 name", () => {
		const supportedOnly =
			"{{user}} and {{char}}; {{original}}; {{random::a::b}} {{roll 1d20}} {{pick::x::y}} {{trim}}; " +
			"{{setvar::x::1}}{{getvar::x}} {{setglobalvar::y::2}}{{getglobalvar::y}}; " +
			"{{lastMessage}} {{mesExamples}} {{mesExamplesRaw}}; " +
			"{{charPrompt}} {{charInstruction}} {{systemPrompt}} {{defaultSystemPrompt}} " +
			"{{authorsNote}} {{defaultAuthorsNote}} {{notChar}} {{reverse}} " +
			"{{datetimeformat::%H:%M}} {{idleDuration}} {{idle_duration}} {{timeDiff::60}} {{time::UTC+3}}; " +
			"{{outlet::memory}}";
		expect(findDroppedStMacroWarnings([supportedOnly])).toEqual([]);
	});

	it("does not warn for macros that are unknown but not on the dropped list (card-author placeholders stay literal)", () => {
		expect(findDroppedStMacroWarnings(["{{student}} greets {{mother}}"])).toEqual([]);
	});

	it("warns once per distinct macro across all scanned texts, preserving first-seen order", () => {
		expect(
			findDroppedStMacroWarnings([
				"{{lastSwipeId}} here",
				"{{lastSwipeId}} again",
				"{{hasExtension::expressions}} too",
			]),
		).toEqual([
			"Macro {{lastSwipeId}} is not supported in VT — use scripts instead.",
			"Macro {{hasExtension}} is not supported in VT — use scripts instead.",
		]);
	});

	it("matches macro names case-insensitively but echoes the written form", () => {
		expect(findDroppedStMacroWarnings(["{{LastSwipeId}}"])).toEqual([
			"Macro {{LastSwipeId}} is not supported in VT — use scripts instead.",
		]);
	});

	it("covers the expressions-extension macros with the scripts replacement", () => {
		const warnings = findDroppedStMacroWarnings([
			"{{defaultExpression}} {{lastExpression}} {{availableExpressions}}",
		]);
		expect(warnings).toHaveLength(3);
		for (const warning of warnings) {
			expect(warning).toContain("use scripts instead.");
		}
	});

	it("keeps the dropped map disjoint from the one registry (supported macros are structurally never warned)", () => {
		// The runtime check consults the registry catalog, so a dropped name that
		// later becomes registered silently stops warning. This pin makes the
		// CURRENT disjointness a loud failure instead of a silent list drift.
		const registered = new Set<string>();
		for (const entry of getMacroCatalog()) {
			registered.add(entry.name.toLowerCase());
			for (const alias of entry.aliases) registered.add(alias.toLowerCase());
		}
		for (const name of Object.keys(DROPPED_ST_MACROS)) {
			expect(registered.has(name)).toBe(false);
		}
	});
});
