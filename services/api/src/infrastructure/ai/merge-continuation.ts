/**
 * Stitching seam for the fallback continuation path.
 *
 * When a backend rejects the trailing-assistant prefill, the retry goes out
 * as a user-role continuation instruction and the model re-emits part of the
 * original text before continuing. This module trims that repeated overlap
 * (longest suffix-of-original ∩ prefix-of-generated) and concatenates the
 * remainder. It replaces `ensurePrefillInResponse` on the fallback path
 * only; the prefill path keeps its existing echo seam.
 *
 * Matching is whitespace-tolerant: runs of whitespace compare equal after
 * collapsing `\s+` to a single space. Both coordinate systems stay
 * recoverable via an index map from each normalized character back to its
 * source offset, so the output keeps the ORIGINAL's characters (its
 * whitespace) and `overlapLength` is measured in ORIGINAL characters.
 */

export interface MergeContinuationResult {
	content: string;
	overlapLength: number;
}

interface NormalizedText {
	norm: string;
	indexMap: number[];
}

function normalizeWithMap(text: string): NormalizedText {
	let norm = "";
	const indexMap: number[] = [];
	let i = 0;
	while (i < text.length) {
		const char = text[i] as string;
		if (/\s/.test(char)) {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j] as string)) j++;
			norm += " ";
			indexMap.push(i);
			i = j;
		} else {
			norm += char;
			indexMap.push(i);
			i++;
		}
	}
	return { norm, indexMap };
}

function computePrefixFunction(pattern: string): number[] {
	const pi = new Array<number>(pattern.length).fill(0);
	for (let i = 1; i < pattern.length; i++) {
		let j = pi[i - 1] as number;
		while (j > 0 && pattern[i] !== pattern[j]) j = pi[j - 1] as number;
		if (pattern[i] === pattern[j]) j++;
		pi[i] = j;
	}
	return pi;
}

/**
 * Longest k such that the length-k suffix of `normOriginal` equals the
 * length-k prefix of `normGenerated`. Linear time via the KMP automaton:
 * the pattern is the generated prefix (capped at the original length) run
 * over the original text; the automaton state after the final character is
 * the longest pattern prefix ending exactly at the end of the text.
 */
function longestNormalizedOverlap(normOriginal: string, normGenerated: string): number {
	const maxOverlap = Math.min(normOriginal.length, normGenerated.length);
	if (maxOverlap === 0) return 0;
	const pattern = normGenerated.slice(0, maxOverlap);
	const pi = computePrefixFunction(pattern);
	let matched = 0;
	for (let i = 0; i < normOriginal.length; i++) {
		while (matched > 0 && normOriginal[i] !== pattern[matched]) {
			matched = pi[matched - 1] as number;
		}
		if (normOriginal[i] === pattern[matched]) matched++;
	}
	return matched;
}

/**
 * Stitches a fallback continuation onto the original text, dropping the
 * longest whitespace-tolerant overlap. `overlapLength` is measured in
 * ORIGINAL characters (`original.length - suffixStart`).
 */
export function mergeContinuation(original: string, generated: string): MergeContinuationResult {
	if (!generated) return { content: original, overlapLength: 0 };
	if (!original) return { content: generated, overlapLength: 0 };

	const normOriginal = normalizeWithMap(original);
	const normGenerated = normalizeWithMap(generated);
	const overlapNorm = longestNormalizedOverlap(normOriginal.norm, normGenerated.norm);
	if (overlapNorm === 0) {
		return { content: original + generated.trimStart(), overlapLength: 0 };
	}

	const suffixStart = normOriginal.indexMap[
		normOriginal.norm.length - overlapNorm
	] as number;
	const remainderStart =
		overlapNorm >= normGenerated.norm.length
			? generated.length
			: (normGenerated.indexMap[overlapNorm] as number);
	return {
		content: original + generated.slice(remainderStart).trimStart(),
		overlapLength: original.length - suffixStart,
	};
}
