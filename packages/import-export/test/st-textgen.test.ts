/**
 * ST TextGen Settings parser tests (LOCAL_SUPPORT_PLAN LS-5g).
 *
 * Fixtures embed the REAL shapes from the owner's live SillyTavern install
 * (`N:/SillyTavern/data/default-user/TextGen Settings/` — READ ONLY): Divine
 * Intellect (the classic prose preset), Mirostat (mirostat trio active), Big O
 * (tfs + typical), Deterministic (zeroed temps). Field spellings are the ooba
 * snake_case set the storage map pinned (temp/top_p/top_k/min_p/typical_p/tfs/
 * rep_pen ×2, dynatemp trio, smoothing_factor, dry_* and mirostat_*).
 */
import { describe, expect, test } from "bun:test";
import { isStTextgenShape, parseStTextgen } from "../src/samplers/st-textgen.js";

/** Divine Intellect.json — verbatim relevant slice from the owner's install. */
const DIVINE_INTELLECT = {
	temp: 1.31,
	temperature_last: true,
	top_p: 0.14,
	top_k: 49,
	top_a: 0.52,
	tfs: 1,
	epsilon_cutoff: 1.49,
	eta_cutoff: 10.42,
	typical_p: 1,
	min_p: 0,
	rep_pen: 1.17,
	rep_pen_range: 0,
	rep_pen_decay: 0,
	rep_pen_slope: 1,
	freq_pen: 0,
	presence_pen: 0,
	dynatemp: false,
	min_temp: 0,
	max_temp: 2,
	dynatemp_exponent: 1,
	smoothing_factor: 0,
	dry_allowed_length: 2,
	dry_multiplier: 0,
	dry_base: 1.75,
	dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
	dry_penalty_last_n: 0,
	mirostat_mode: 0,
	mirostat_tau: 5,
	mirostat_eta: 0.1,
	grammar_string: "",
	json_schema: {},
	banned_tokens: "",
	sampler_priority: ["temperature", "dynamic_temperature", "quadratic_sampling"],
	sampler_order: [6, 0, 1, 3, 4, 2, 5],
};

/** Mirostat.json — mirostat trio active (mode 2, tau 8). */
const MIROSTAT = { ...DIVINE_INTELLECT, temp: 1, mirostat_mode: 2, mirostat_tau: 8 };

/** Big O.json — tfs + typical active. */
const BIG_O = { ...DIVINE_INTELLECT, temp: 0.87, top_p: 0.99, top_k: 85, typical_p: 0.68, tfs: 0.68, rep_pen: 1.01 };

describe("isStTextgenShape (point-import sniff, LS-5g)", () => {
	test("recognizes ST TextGen files by marker keys", () => {
		expect(isStTextgenShape(DIVINE_INTELLECT)).toBe(true);
		expect(isStTextgenShape({ temp: 1 })).toBe(true);
		expect(isStTextgenShape({ mirostat_mode: 2 })).toBe(true);
	});

	test("rejects VT-native set JSON (camelCase overlay keys — disjoint shapes)", () => {
		expect(isStTextgenShape({ temperature: 1.2, topP: 0.9, drySequenceBreakers: ["\n"] })).toBe(false);
		expect(isStTextgenShape({})).toBe(false);
		expect(isStTextgenShape(null)).toBe(false);
		expect(isStTextgenShape([1, 2])).toBe(false);
		expect(isStTextgenShape("temp")).toBe(false);
	});
});

describe("parseStTextgen (ST → VT sampler-set payload, LS-5g)", () => {
	test("Divine Intellect maps every supported sampler field", () => {
		const parsed = parseStTextgen(DIVINE_INTELLECT);
		expect(parsed).not.toBeNull();
		const payload = parsed!.payload;

		expect(payload.temperature).toBe(1.31);
		expect(payload.topP).toBe(0.14);
		expect(payload.topK).toBe(49);
		expect(payload.topA).toBe(0.52);
		expect(payload.minP).toBe(0);
		expect(payload.typicalP).toBe(1);
		expect(payload.tfsZ).toBe(1);
		expect(payload.repetitionPenalty).toBe(1.17);
		expect(payload.repeatLastN).toBe(0);
		expect(payload.frequencyPenalty).toBe(0);
		expect(payload.presencePenalty).toBe(0);
		expect(payload.smoothingFactor).toBe(0);
		expect(payload.dryMultiplier).toBe(0);
		expect(payload.dryBase).toBe(1.75);
		expect(payload.dryAllowedLength).toBe(2);
		expect(payload.dryPenaltyLastN).toBe(0);
		// dry_sequence_breakers is a JSON-in-string in ST — decoded to chips.
		expect(payload.drySequenceBreakers).toEqual(["\n", ":", '"', "*"]);
		expect(payload.mirostat).toBe(0);
		expect(payload.mirostatTau).toBe(5);
		expect(payload.mirostatEta).toBe(0.1);
		// dynatemp flag OFF → nothing mapped (absent = don't touch on apply).
		expect(payload.dynatempRange).toBeUndefined();
		expect(payload.dynatempExponent).toBeUndefined();
		// The mapped payload is EXACTLY the supported-field map — no extra keys
		// ride through (would fail the set-payload schema downstream).
		expect(payload).toEqual({
			temperature: 1.31,
			topP: 0.14,
			topK: 49,
			topA: 0.52,
			minP: 0,
			typicalP: 1,
			tfsZ: 1,
			repetitionPenalty: 1.17,
			repeatLastN: 0,
			frequencyPenalty: 0,
			presencePenalty: 0,
			smoothingFactor: 0,
			dryMultiplier: 0,
			dryBase: 1.75,
			dryAllowedLength: 2,
			dryPenaltyLastN: 0,
			drySequenceBreakers: ["\n", ":", '"', "*"],
			mirostat: 0,
			mirostatTau: 5,
			mirostatEta: 0.1,
		});
	});

	test("skipped-but-value-carrying fields produce notes (sampler_order, json_schema); empty fields stay silent", () => {
		const parsed = parseStTextgen(DIVINE_INTELLECT)!;
		// sampler_order + json_schema carry values (array / {}), banned_tokens
		// and grammar_string are empty ("") in Divine Intellect — silent.
		expect(parsed.notes).toContain("sampler_order has no sampler-set mapping in VT — skipped");
		expect(parsed.notes).toContain("json_schema has no sampler-set mapping in VT — skipped");
		expect(parsed.notes.some((n) => n.startsWith("banned_tokens"))).toBe(false);
		expect(parsed.notes.some((n) => n.startsWith("grammar_string"))).toBe(false);
	});

	test("Mirostat.json maps the active mirostat trio", () => {
		const parsed = parseStTextgen(MIROSTAT)!;
		expect(parsed.payload.mirostat).toBe(2);
		expect(parsed.payload.mirostatTau).toBe(8);
		expect(parsed.payload.mirostatEta).toBe(0.1);
	});

	test("Big O.json maps tfs + typical", () => {
		const parsed = parseStTextgen(BIG_O)!;
		expect(parsed.payload.tfsZ).toBe(0.68);
		expect(parsed.payload.typicalP).toBe(0.68);
		expect(parsed.payload.topK).toBe(85);
		expect(parsed.payload.repetitionPenalty).toBe(1.01);
	});

	test("enabled dynatemp maps the band width (max−min) + exponent", () => {
		const parsed = parseStTextgen({ ...DIVINE_INTELLECT, dynatemp: true, min_temp: 0.6, max_temp: 2.1, dynatemp_exponent: 0.9 })!;
		expect(parsed.payload.dynatempRange).toBeCloseTo(1.5);
		expect(parsed.payload.dynatempExponent).toBe(0.9);
	});

	test("dry_sequence_breakers as a real array or comma string still decodes", () => {
		const asArray = parseStTextgen({ ...DIVINE_INTELLECT, dry_sequence_breakers: ["a", "b"] })!;
		expect(asArray.payload.drySequenceBreakers).toEqual(["a", "b"]);
		// Not JSON — kept as a single chip (lenient, ooba accepted raw strings).
		const raw = parseStTextgen({ ...DIVINE_INTELLECT, dry_sequence_breakers: "\\n" })!;
		expect(raw.payload.drySequenceBreakers).toEqual(["\\n"]);
	});

	test("VT-native payloads are not parsed as ST (returns null → caller tries the VT path)", () => {
		expect(parseStTextgen({ temperature: 1.2, topP: 0.9 })).toBeNull();
	});
});
