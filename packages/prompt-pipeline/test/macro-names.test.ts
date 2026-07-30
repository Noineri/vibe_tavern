import { describe, expect, it } from "bun:test";
import { extractMacroNames } from "../src/macro-registry.ts";

/**
 * `extractMacroNames` — the pure lens over the canonical tokenizer used by the
 * Co-Author apply path (B5) to detect macros outside the safe reusable subset.
 * These cases pin the contract the apply check relies on: only named "macro"
 * tokens are returned (comments stripped, control-flow excluded), names dedupe,
 * and parameterized / legacy forms reduce to their resolver name.
 */
describe("extractMacroNames", () => {
	it("returns [] for plain text with no macros", () => {
		expect(extractMacroNames("just prose, nothing here")).toEqual([]);
	});

	it("extracts simple macro names in order of first appearance", () => {
		expect(extractMacroNames("{{user}} meets {{char}}")).toEqual(["user", "char"]);
	});

	it("reduces a parameterized macro (:: args) to its name", () => {
		expect(extractMacroNames("{{random::a::b}} and {{getvar::x}}")).toEqual(["random", "getvar"]);
	});

	it("dedupes repeated macros", () => {
		expect(extractMacroNames("{{user}} {{user}} {{user}}")).toEqual(["user"]);
	});

	it("skips comments and control-flow tokens (not resolvable macros)", () => {
		// {{// note}} is stripped by the tokenizer; {{if::cond}}, {{else}}, {{/if}}
		// are control tokens, not "macro" tokens → none extracted.
		expect(extractMacroNames("{{// a comment}}{{if::x}}prose{{else}}y{{/if}}")).toEqual([]);
	});

	it("reduces legacy markers to their resolver name (<BOT>/<CHAR> → char)", () => {
		expect(extractMacroNames("<USER> and <BOT>")).toEqual(["user", "char"]);
	});

	it("does not throw on nested macros (tokenizer depth-scans)", () => {
		expect(() => extractMacroNames("{{roll::{{char}}}}")).not.toThrow();
	});
});
