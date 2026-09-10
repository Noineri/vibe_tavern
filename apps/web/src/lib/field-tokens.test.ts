import { describe, expect, test } from "bun:test";
import {
	codeQuoteCls,
	composerCls,
	inputCls,
	lblCls,
	monoMod,
	readonlyMod,
	textareaCls,
} from "./field-tokens.js";

/**
 * Contract pins for the field-token canon (FIELD_SYSTEM_UNIFICATION_REPORT
 * FS-1). These tokens are the single source of field styling app-wide; a
 * change here must be a deliberate canon decision, never an accident.
 */

describe("field-tokens canon", () => {
	test("inputCls — LLM provider form shape verbatim", () => {
		expect(inputCls).toContain("h-11 sm:h-[38px]");
		expect(inputCls).toContain("rounded-[6px]");
		expect(inputCls).toContain("px-[13px]");
		expect(inputCls).toContain("focus:border-accent");
		expect(inputCls).toContain("transition-[border-color]");
		// size comes from the ui-fs ladder, never a fixed pixel size
		expect(inputCls).toContain("text-[calc(var(--ui-fs)-1px)]");
		expect(inputCls).not.toMatch(/text-\[\d+px\]/);
		expect(inputCls).not.toContain("text-xs");
	});

	test("textareaCls — same chrome minus height, plus AutoTextarea scroll contract", () => {
		expect(textareaCls).toContain("rounded-[6px]");
		expect(textareaCls).toContain("focus:border-accent");
		expect(textareaCls).toContain("text-[calc(var(--ui-fs)-1px)]");
		// AutoTextarea maxRows contract: must scroll internally, not clip
		expect(textareaCls).toContain("resize-none");
		expect(textareaCls).toContain("overflow-y-auto");
		expect(textareaCls).toContain("field-input-pad");
		// no fixed height — the field grows
		expect(textareaCls).not.toContain("h-11");
		expect(textareaCls).not.toContain("h-[38px]");
		expect(textareaCls).not.toContain("px-[13px]");
	});

	test("composerCls — borderless prose twin (mobile chat + coauthor)", () => {
		expect(composerCls).toContain("min-h-[44px]");
		expect(composerCls).toContain("max-h-[40vh]");
		expect(composerCls).toContain("font-body");
		expect(composerCls).toContain("text-[15px]");
		expect(composerCls).toContain("border-0");
		expect(composerCls).toContain("bg-transparent");
		expect(composerCls).toContain("resize-none");
		expect(composerCls).toContain("overflow-y-auto");
	});

	test("codeQuoteCls — display canon, not a field", () => {
		expect(codeQuoteCls).toContain("font-mono");
		expect(codeQuoteCls).toContain("whitespace-pre-wrap");
		expect(codeQuoteCls).toContain("break-all");
		expect(codeQuoteCls).toContain("rounded-[6px]");
		expect(codeQuoteCls).toContain("p-2");
		expect(codeQuoteCls).toContain("text-t2");
		// ladder size; the old fixed 11px display size is dead
		expect(codeQuoteCls).toContain("text-[calc(var(--ui-fs)-2px)]");
		expect(codeQuoteCls).not.toContain("text-[11px]");
	});

	test("monoMod — modifier only, NEVER carries its own size", () => {
		expect(monoMod).toContain("font-mono");
		expect(monoMod).toContain("tracking-[0.05em]");
		expect(monoMod).not.toContain("text-xs");
		expect(monoMod).not.toMatch(/text-\[/);
	});

	test("readonlyMod — locked-field smear, unified", () => {
		expect(readonlyMod).toBe("!cursor-not-allowed !opacity-60");
	});

	test("lblCls — label with built-in 6px gap", () => {
		expect(lblCls).toContain("mb-1.5");
		expect(lblCls).toContain("block");
		expect(lblCls).toContain("uppercase");
		expect(lblCls).toContain("tracking-[0.06em]");
		expect(lblCls).toContain("text-[calc(var(--ui-fs)-3px)]");
	});
});
