/**
 * @module samplers/st-textgen
 *
 * SillyTavern `TextGen Settings/*.json` → VT sampler-set payload
 * (LOCAL_SUPPORT_PLAN LS-5g). TextGen files are ooba-style sampler presets —
 * snake_case spellings, values VT stores camelCase on the provider profile.
 * The parser maps ONLY the fields VT's sampler panel renders; everything else
 * (temperature_last, epsilon_cutoff, sampler_priority, …) is VT-irrelevant
 * and ignored. Four fields are SKIPPED WITH AN EXPLICIT NOTE (they carry
 * values the user would otherwise silently lose):
 * - `sampler_order` — ooba sampler-order permutation; VT has no such field.
 * - `banned_tokens` — KoboldCPP-native (B3) raw string; VT's bannedStrings
 *   chip list is phrase-based and the ooba string's split semantics differ.
 * - `grammar_string` / `json_schema` — constrained-generation fields with no
 *   VT sampler-set surface.
 *
 * Also carries the SHAPE sniff for point import: one file picker accepts both
 * VT-native set JSON and ST TextGen files (LS-5g), so detection must be
 * key-spelling based, not folder based.
 */

import type { ModelSettingsOverlay } from "@vibe-tavern/domain";

// ─── Shape sniff ────────────────────────────────────────────────────────────

/** ST TextGen marker keys (snake_case ooba spellings VT never writes). VT-native
 *  set JSON uses the camelCase overlay keys, so the two shapes are disjoint. */
const ST_TEXTGEN_MARKERS = [
	"temp",
	"top_p",
	"top_k",
	"rep_pen",
	"sampler_priority",
	"mirostat_mode",
] as const;

/**
 * True when the parsed JSON object has ST TextGen shape (at least one marker
 * key). False for VT-native set JSON (camelCase keys) — the point-import
 * sniff routes on this BEFORE trying the VT overlay schema.
 */
export function isStTextgenShape(parsed: unknown): boolean {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return ST_TEXTGEN_MARKERS.some((key) => key in obj);
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/** Skipped-with-note fields (see module doc) — surfaced to the user, never silent. */
export const ST_TEXTGEN_SKIPPED_FIELDS = [
	"sampler_order",
	"banned_tokens",
	"grammar_string",
	"json_schema",
] as const;

export interface StTextgenParseResult {
	/** Mapped VT payload — a partial sampler overlay (absent = don't touch on apply). */
	payload: Partial<ModelSettingsOverlay>;
	/** Import notes for skipped-but-value-carrying fields. */
	notes: string[];
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string");
	}
	if (typeof value === "string") {
		// ST stores `dry_sequence_breakers` as a JSON-encoded string
		// ('["\\n", ":"]'). Decode it; on failure keep the raw string as a
		// single chip (lenient — ooba also accepted comma-separated input).
		try {
			const decoded: unknown = JSON.parse(value);
			if (Array.isArray(decoded)) {
				return decoded.filter((v): v is string => typeof v === "string");
			}
		} catch {
			// Not JSON-encoded — fall through to the single-chip fallback.
		}
		return value.length > 0 ? [value] : [];
	}
	return undefined;
}

/**
 * Map an ST TextGen Settings JSON object onto a VT sampler-set payload.
 * Returns null when the object has no ST TextGen shape (the caller then tries
 * the VT-native path). Field map (LOCAL_SUPPORT_PLAN LS-5g):
 *
 * | ST (ooba)            | VT                          |
 * |----------------------|-----------------------------|
 * | temp                 | temperature                 |
 * | top_p / top_k / min_p| topP / topK / minP          |
 * | top_a                | topA                        |
 * | typical_p            | typicalP                    |
 * | tfs                  | tfsZ                        |
 * | rep_pen              | repetitionPenalty           |
 * | rep_pen_range        | repeatLastN                 |
 * | freq_pen             | frequencyPenalty            |
 * | presence_pen         | presencePenalty             |
 * | dynatemp=true + min_temp/max_temp + dynatemp_exponent | dynatempRange (= max−min) / dynatempExponent |
 * | smoothing_factor     | smoothingFactor             |
 * | dry_multiplier/base/allowed_length/penalty_last_n     | dry*                        |
 * | dry_sequence_breakers (JSON-in-string)                | drySequenceBreakers (string[]) |
 * | mirostat_mode/tau/eta| mirostat / mirostatTau / mirostatEta |
 */
export function parseStTextgen(parsed: unknown): StTextgenParseResult | null {
	if (!isStTextgenShape(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const payload: Partial<ModelSettingsOverlay> = {};
	const notes: string[] = [];

	const temp = num(obj.temp);
	if (temp !== undefined) payload.temperature = temp;
	const topP = num(obj.top_p);
	if (topP !== undefined) payload.topP = topP;
	const topK = num(obj.top_k);
	if (topK !== undefined) payload.topK = topK;
	const topA = num(obj.top_a);
	if (topA !== undefined) payload.topA = topA;
	const minP = num(obj.min_p);
	if (minP !== undefined) payload.minP = minP;
	const typicalP = num(obj.typical_p);
	if (typicalP !== undefined) payload.typicalP = typicalP;
	const tfs = num(obj.tfs);
	if (tfs !== undefined) payload.tfsZ = tfs;
	const repPen = num(obj.rep_pen);
	if (repPen !== undefined) payload.repetitionPenalty = repPen;
	const repPenRange = num(obj.rep_pen_range);
	if (repPenRange !== undefined) payload.repeatLastN = repPenRange;
	const freqPen = num(obj.freq_pen);
	if (freqPen !== undefined) payload.frequencyPenalty = freqPen;
	const presencePen = num(obj.presence_pen);
	if (presencePen !== undefined) payload.presencePenalty = presencePen;

	// DynaTemp: ST's ooba trio is the flag + a min/max temperature band +
	// the exponent. VT's llama-server surface stores range + exponent (B2);
	// the range is the band width. Only mapped when the flag is ON — a
	// disabled dynatemp maps to "absent" (the clipboard semantic: don't touch).
	if (obj.dynatemp === true) {
		const minTemp = num(obj.min_temp);
		const maxTemp = num(obj.max_temp);
		if (minTemp !== undefined && maxTemp !== undefined) {
			payload.dynatempRange = maxTemp - minTemp;
		}
		const exponent = num(obj.dynatemp_exponent);
		if (exponent !== undefined) payload.dynatempExponent = exponent;
	}

	const smoothing = num(obj.smoothing_factor);
	if (smoothing !== undefined) payload.smoothingFactor = smoothing;

	const dryMultiplier = num(obj.dry_multiplier);
	if (dryMultiplier !== undefined) payload.dryMultiplier = dryMultiplier;
	const dryBase = num(obj.dry_base);
	if (dryBase !== undefined) payload.dryBase = dryBase;
	const dryAllowedLength = num(obj.dry_allowed_length);
	if (dryAllowedLength !== undefined) payload.dryAllowedLength = dryAllowedLength;
	const dryPenaltyLastN = num(obj.dry_penalty_last_n);
	if (dryPenaltyLastN !== undefined) payload.dryPenaltyLastN = dryPenaltyLastN;
	const dryBreakers = strArray(obj.dry_sequence_breakers);
	if (dryBreakers !== undefined) payload.drySequenceBreakers = dryBreakers;

	const mirostat = num(obj.mirostat_mode);
	if (mirostat !== undefined) payload.mirostat = mirostat;
	const mirostatTau = num(obj.mirostat_tau);
	if (mirostatTau !== undefined) payload.mirostatTau = mirostatTau;
	const mirostatEta = num(obj.mirostat_eta);
	if (mirostatEta !== undefined) payload.mirostatEta = mirostatEta;

	for (const field of ST_TEXTGEN_SKIPPED_FIELDS) {
		if (obj[field] !== undefined && obj[field] !== "" && obj[field] !== null) {
			notes.push(`${field} has no sampler-set mapping in VT — skipped`);
		}
	}

	return { payload, notes };
}
