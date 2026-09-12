/**
 * LS-10 preview builder — the live preview's honesty contract: the segments
 * mirror the backend serialization seam byte-for-byte (minimal LS-2 shape vs
 * the extended ST-instruct shape), because the preview's whole job is showing
 * the user EXACTLY what the glue produces.
 */
import { describe, it, expect } from "bun:test";
import type { GenerationFormat } from "@vibe-tavern/domain";
import { buildFormatPreviewSegments } from "./format-preview.js";

const DEMO = { system: "SYS", user: "USER", assistant: "ASST" };

function segmentsToText(segments: ReturnType<typeof buildFormatPreviewSegments>): string {
	return segments.map((segment) => segment.text).join("");
}

describe("buildFormatPreviewSegments (LS-10)", () => {
	it("minimal shape: role-prefixed lines joined with \\n, bare continuation prefix", () => {
		const fmt: GenerationFormat = { mode: "manual", inputSequence: "User: ", outputSequence: "Assistant: ", systemSequence: "System: " };
		const segments = buildFormatPreviewSegments(fmt, DEMO);
		expect(segmentsToText(segments)).toBe("System: SYS\nUser: USER\nAssistant:");
		// Sequence parts are flagged (the highlighting contract).
		expect(segments.filter((s) => s.kind === "seq").map((s) => s.text)).toEqual(["System: ", "User: ", "Assistant:"]);
	});

	it("extended ChatML shape: wrap newlines + <|im_end|> suffixes, the assistant line is the bare continuation point", () => {
		const fmt: GenerationFormat = {
			mode: "manual",
			inputSequence: "<|im_start|>user",
			outputSequence: "<|im_start|>assistant",
			systemSequence: "<|im_start|>system",
			inputSuffix: "<|im_end|>\n",
			outputSuffix: "<|im_end|>\n",
			systemSuffix: "<|im_end|>\n",
			wrap: true,
		};
		const segments = buildFormatPreviewSegments(fmt, DEMO);
		expect(segmentsToText(segments)).toBe(
			"<|im_start|>system\nSYS<|im_end|>\n<|im_start|>user\nUSER<|im_end|>\n<|im_start|>assistant",
		);
	});

	it("absent sequences render as EMPTY prefixes (the seam maps absent ST fields to \"\" — no invented labels)", () => {
		const fmt: GenerationFormat = { mode: "manual" };
		const segments = buildFormatPreviewSegments(fmt, DEMO);
		// Minimal path with no sequences: contents joined with \n, the empty
		// trailer line leaves a trailing separator (byte-true vs the seam — its
		// minimal path pushes the (empty) trailer before joining).
		expect(segmentsToText(segments)).toBe("SYS\nUSER\n");
		expect(segments.filter((s) => s.kind === "seq")).toEqual([]);
	});
});
