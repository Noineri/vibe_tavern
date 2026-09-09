import type { GenerationFormat } from "@vibe-tavern/domain";

/**
 * LS-10 live-preview builder: turns a manual GenerationFormat into the
 * HIGHLIGHTED SEGMENTS of an assembled example prompt — the newbie-teaching
 * view the owner designed («нубик учится на глазах, не читая документацию»).
 *
 * The segment assembly MIRRORS the backend serialization seam's semantics
 * (services/api completion-prompt.ts): the minimal (LS-2) template renders
 * `prefix + content` lines joined with "\n" plus the bare continuation
 * prefix; the extended (ST-instruct) template renders each message as
 * `[prefix, content + suffix].filter(Boolean).join(wrap ? "\n" : "")` with a
 * missing suffix defaulting to "\n" under wrap, messages CONCATENATING, and
 * the trailing assistant line IS the continuation point (suffix dropped, no
 * trailer). Keep the two in sync — the preview's job is honesty.
 */

export type PreviewSegmentKind = "seq" | "content" | "suffix";

export interface PreviewSegment {
	text: string;
	kind: PreviewSegmentKind;
}

/** Demo message contents (i18n-supplied by the caller — this builder is pure). */
export interface PreviewDemoContent {
	system: string;
	user: string;
	assistant: string;
}

/** Same extension test as the seam's `hasExtensions` — decides minimal vs
 *  ST-instruct rendering. */
function hasExtensions(fmt: GenerationFormat): boolean {
	return (
		fmt.wrap !== undefined ||
		fmt.inputSuffix !== undefined ||
		fmt.outputSuffix !== undefined ||
		fmt.systemSuffix !== undefined ||
		fmt.firstOutputSequence !== undefined ||
		fmt.lastOutputSequence !== undefined ||
		fmt.systemSequencePrefix !== undefined ||
		fmt.systemSequenceSuffix !== undefined
	);
}

/** One message per the seam's renderMessage: `[prefix, content + suffix]`
 *  joined with "\n" under wrap, a missing suffix defaulting to "\n". */
function pushMessage(
	segments: PreviewSegment[],
	prefix: string,
	content: string,
	suffix: string | undefined,
	wrap: boolean,
): void {
	if (prefix) segments.push({ text: prefix, kind: "seq" });
	const effectiveSuffix = suffix ?? (wrap ? "\n" : "");
	if (wrap && prefix && (content || effectiveSuffix)) segments.push({ text: "\n", kind: "suffix" });
	if (content) segments.push({ text: content, kind: "content" });
	if (effectiveSuffix) segments.push({ text: effectiveSuffix, kind: "suffix" });
}

/** Build the full preview for the three demo messages (system → user →
 *  assistant), the assistant rendered as the continuation point (bare
 *  trimmed prefix — the model writes from there). Empty segments filtered. */
export function buildFormatPreviewSegments(
	fmt: GenerationFormat,
	demo: PreviewDemoContent,
): PreviewSegment[] {
	const segments: PreviewSegment[] = [];
	const wrap = fmt.wrap === true;
	const extended = hasExtensions(fmt);

	if (extended) {
		// ST-instruct path: messages CONCATENATE (suffixes carry the newlines);
		// ST system_sequence_prefix/suffix wrap the whole system line.
		if (fmt.systemSequencePrefix) segments.push({ text: fmt.systemSequencePrefix, kind: "seq" });
		pushMessage(segments, fmt.systemSequence ?? "", demo.system, fmt.systemSuffix, wrap);
		if (fmt.systemSequenceSuffix) segments.push({ text: fmt.systemSequenceSuffix, kind: "seq" });
		pushMessage(segments, fmt.inputSequence ?? "", demo.user, fmt.inputSuffix, wrap);
		// Trailing assistant = the continuation point: trimmed prefix, no
		// suffix, no trailer (the seam drops both — see the module doc).
		const trailer = ((fmt.lastOutputSequence || fmt.outputSequence) ?? "").trimEnd();
		if (trailer) segments.push({ text: trailer, kind: "seq" });
	} else {
		// Minimal (LS-2) path: role-prefixed lines joined with "\n", the bare
		// trimmed assistant prefix ends the string.
		const lines: PreviewSegment[][] = [
			[
				...(fmt.systemSequence ? [{ text: fmt.systemSequence, kind: "seq" as const }] : []),
				...(demo.system ? [{ text: demo.system, kind: "content" as const }] : []),
			],
			[
				...(fmt.inputSequence ? [{ text: fmt.inputSequence, kind: "seq" as const }] : []),
				...(demo.user ? [{ text: demo.user, kind: "content" as const }] : []),
			],
		];
		let first = true;
		for (const line of lines) {
			if (!first) segments.push({ text: "\n", kind: "suffix" });
			first = false;
			segments.push(...line);
		}
		// Mirror the seam BYTE-FOR-BYTE: the minimal path pushes the trailer line
		// (empty when the sequence is absent) BEFORE joining — so the join adds
		// exactly ONE separator before it (the empty trailer leaves the trailing
		// separator; the empty prefix segment itself is filtered out below).
		if (lines.some((line) => line.length > 0)) segments.push({ text: "\n", kind: "suffix" });
		const trailer = (fmt.outputSequence ?? "").trimEnd();
		if (trailer) segments.push({ text: trailer, kind: "seq" });
	}

	return segments.filter((segment) => segment.text.length > 0);
}
