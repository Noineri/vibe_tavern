/**
 * LS-10 decision (c) — the effective generation format (supervisor-approved
 * 2026-09-09): the PROFILE's format wins when set (option A ownership — any
 * interaction with the provider format block adopts it); otherwise the ACTIVE
 * PRESET's format keeps applying (the fallback — preset-borne templates,
 * incl. imported ST instruct ones, keep shaping generations until the user
 * touches the new UI; nothing is migrated or dropped).
 */
import { describe, it, expect } from "bun:test";
import type { GenerationFormat, ProviderGenerationFormat } from "../src/generation-format.js";
import {
	BUILTIN_FORMAT_TEMPLATES,
	builtinFormatTemplateBySelection,
	resolveEffectiveGenerationFormat,
} from "../src/generation-format.js";

const PRESET_FORMAT: GenerationFormat = {
	mode: "manual",
	inputSequence: "<|preset_user|>",
	outputSequence: "<|preset_asst|>",
};

const PROFILE_FORMAT: ProviderGenerationFormat = {
	mode: "manual",
	format: {
		mode: "manual",
		inputSequence: "<|profile_user|>",
		outputSequence: "<|profile_asst|>",
	},
};

describe("resolveEffectiveGenerationFormat (LS-10 decision c)", () => {
	it("no profile format + preset format present → the PRESET format applies (the fallback)", () => {
		expect(resolveEffectiveGenerationFormat(null, PRESET_FORMAT)).toEqual(PRESET_FORMAT);
		expect(resolveEffectiveGenerationFormat(undefined, PRESET_FORMAT)).toEqual(PRESET_FORMAT);
	});

	it("profile format set → the PROFILE wins regardless of the preset", () => {
		expect(resolveEffectiveGenerationFormat(PROFILE_FORMAT, PRESET_FORMAT)).toEqual(PROFILE_FORMAT.format);
	});

	it("profile manual without stored sequences degrades to auto (never a broken format)", () => {
		expect(resolveEffectiveGenerationFormat({ mode: "manual" }, PRESET_FORMAT)).toEqual({ mode: "auto" });
	});

	it("profile auto + backend selection (or absent) → plain auto; the preset fallback does NOT leak through", () => {
		expect(resolveEffectiveGenerationFormat({ mode: "auto", selection: "backend" }, PRESET_FORMAT)).toEqual({ mode: "auto" });
		expect(resolveEffectiveGenerationFormat({ mode: "auto" }, PRESET_FORMAT)).toEqual({ mode: "auto" });
	});

	it("profile auto + builtin selection materializes THAT builtin's sequences", () => {
		const effective = resolveEffectiveGenerationFormat({ mode: "auto", selection: "builtin:chatml" }, PRESET_FORMAT);
		expect(effective).toEqual({
			mode: "manual",
			selection: "builtin:chatml",
			inputSequence: "<|im_start|>user",
			outputSequence: "<|im_start|>assistant",
			systemSequence: "<|im_start|>system",
			inputSuffix: "<|im_end|>\n",
			outputSuffix: "<|im_end|>\n",
			systemSuffix: "<|im_end|>\n",
			firstOutputSequence: "",
			lastOutputSequence: "",
			systemSequencePrefix: "",
			systemSequenceSuffix: "",
			wrap: true,
			namesBehavior: "always",
		});
	});

	it("both absent → null (the adapters keep their auto semantics)", () => {
		expect(resolveEffectiveGenerationFormat(null, null)).toBeNull();
		expect(resolveEffectiveGenerationFormat(undefined, undefined)).toBeNull();
	});
});

describe("BUILTIN_FORMAT_TEMPLATES (LS-10 dropdown)", () => {
	it("ships the three verified builtin templates with pinned sequences and metadata", () => {
		expect(BUILTIN_FORMAT_TEMPLATES.map((tpl) => tpl.id)).toEqual(["chatml", "llama3", "mistral"]);
		for (const tpl of BUILTIN_FORMAT_TEMPLATES) {
			expect(tpl.label.length).toBeGreaterThan(0);
			expect(tpl.source.length).toBeGreaterThan(0);
		}
		expect(BUILTIN_FORMAT_TEMPLATES.map((tpl) => ({ id: tpl.id, format: tpl.format }))).toEqual([
			{
				id: "chatml",
				format: {
					mode: "manual",
					inputSequence: "<|im_start|>user",
					outputSequence: "<|im_start|>assistant",
					systemSequence: "<|im_start|>system",
					inputSuffix: "<|im_end|>\n",
					outputSuffix: "<|im_end|>\n",
					systemSuffix: "<|im_end|>\n",
					firstOutputSequence: "",
					lastOutputSequence: "",
					systemSequencePrefix: "",
					systemSequenceSuffix: "",
					wrap: true,
					namesBehavior: "always",
				},
			},
			{
				id: "llama3",
				format: {
					mode: "manual",
					inputSequence: "<|start_header_id|>user<|end_header_id|>\n\n",
					outputSequence: "<|start_header_id|>assistant<|end_header_id|>\n\n",
					systemSequence: "<|start_header_id|>system<|end_header_id|>\n\n",
					inputSuffix: "<|eot_id|>",
					outputSuffix: "<|eot_id|>",
					systemSuffix: "<|eot_id|>",
					firstOutputSequence: "",
					lastOutputSequence: "",
					wrap: false,
					namesBehavior: "always",
				},
			},
			{
				id: "mistral",
				format: {
					mode: "manual",
					inputSequence: "[INST] ",
					outputSequence: "[/INST] ",
					lastOutputSequence: "[/INST]",
					systemSequence: "",
					outputSuffix: "</s>",
					wrap: false,
					namesBehavior: "always",
				},
			},
		]);
	});

	it("the selection parser resolves builtins and rejects unknown ids", () => {
		expect(builtinFormatTemplateBySelection("builtin:chatml")?.id).toBe("chatml");
		expect(builtinFormatTemplateBySelection("builtin:nope")).toBeNull();
		expect(builtinFormatTemplateBySelection("custom:abc")).toBeNull();
		expect(builtinFormatTemplateBySelection("backend")).toBeNull();
	});

	it("Mistral (V2/V3) pins the ST-sourced sequences exactly — no system role, EOS as assistant suffix", () => {
		const mistral = BUILTIN_FORMAT_TEMPLATES.find((tpl) => tpl.id === "mistral");
		expect(mistral?.format.inputSequence).toBe("[INST] ");
		expect(mistral?.format.outputSequence).toBe("[/INST] ");
		expect(mistral?.format.lastOutputSequence).toBe("[/INST]");
		expect(mistral?.format.systemSequence).toBe("");
		expect(mistral?.format.outputSuffix).toBe("</s>");
		expect(mistral?.format.wrap).toBe(false);
	});
});
