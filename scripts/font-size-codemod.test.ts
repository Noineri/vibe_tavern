import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	FONT_SIZE_CSS_TARGET,
	MFS_LADDER,
	collectFixedFontSizeMatches,
	collectFontSizeTargetFiles,
	convertSourceFontSizes,
	cssFontSizeFor,
	fontSizeArea,
	fontSizeScopeRejection,
	inlineFontSizeFor,
	isChatMessageFile,
	pixelClassFor,
	runFontSizeCodemod,
	tailwindClassFor,
} from "./font-size-codemod.js";

function writeFixture(root: string, relativePath: string, content: string): void {
	const file = join(root, relativePath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

describe("font-size ladder mapping", () => {
	test("maps every pixel size from the audit census onto the --ui-fs ladder", () => {
		const census: Array<[number, string]> = [
			[9, "text-[calc(var(--ui-fs)-5px)]"],
			[10, "text-[calc(var(--ui-fs)-4px)]"],
			[10.5, "text-[calc(var(--ui-fs)-3.5px)]"],
			[11, "text-[calc(var(--ui-fs)-3px)]"],
			[12, "text-[calc(var(--ui-fs)-2px)]"],
			[12.5, "text-[calc(var(--ui-fs)-1.5px)]"],
			[13, "text-[calc(var(--ui-fs)-1px)]"],
			[14, "text-[var(--ui-fs)]"],
			[15, "text-[calc(var(--ui-fs)+1px)]"],
			[15.5, "text-[calc(var(--ui-fs)+1.5px)]"],
			[16, "text-[calc(var(--ui-fs)+2px)]"],
			[17, "text-[calc(var(--ui-fs)+3px)]"],
			[18, "text-[calc(var(--ui-fs)+4px)]"],
			[22, "text-[calc(var(--ui-fs)+8px)]"],
			// Live in the tree today outside the report's itemized list.
			[8, "text-[calc(var(--ui-fs)-6px)]"],
			[11.5, "text-[calc(var(--ui-fs)-2.5px)]"],
		];
		for (const [px, expected] of census) expect(pixelClassFor(px)).toBe(expected);
	});

	test("maps tailwind size classes by their px at the 16px root, keeping the line height", () => {
		expect(tailwindClassFor("xs")).toBe("text-[calc(var(--ui-fs)-2px)] leading-4");
		expect(tailwindClassFor("sm")).toBe("text-[var(--ui-fs)] leading-5");
		expect(tailwindClassFor("base")).toBe("text-[calc(var(--ui-fs)+2px)] leading-6");
		expect(tailwindClassFor("lg")).toBe("text-[calc(var(--ui-fs)+4px)] leading-7");
		expect(tailwindClassFor("xl")).toBe("text-[calc(var(--ui-fs)+6px)] leading-7");
		expect(tailwindClassFor("2xl")).toBe("text-[calc(var(--ui-fs)+10px)] leading-8");
	});

	test("maps inline numeric and quoted fontSize values onto the ladder string", () => {
		expect(inlineFontSizeFor(18)).toBe('fontSize: "calc(var(--ui-fs)+4px)"');
		expect(inlineFontSizeFor(13)).toBe('fontSize: "calc(var(--ui-fs)-1px)"');
		expect(inlineFontSizeFor(14)).toBe('fontSize: "var(--ui-fs)"');
	});

	test("maps styles.css font-size rules", () => {
		expect(cssFontSizeFor(12.5)).toBe("font-size: calc(var(--ui-fs)-1.5px)");
		expect(cssFontSizeFor(14)).toBe("font-size: var(--ui-fs)");
	});

	test("maps message content onto --mfs at its 17px reference", () => {
		expect(pixelClassFor(12, MFS_LADDER)).toBe("text-[calc(var(--mfs)-5px)]");
		expect(pixelClassFor(17, MFS_LADDER)).toBe("text-[var(--mfs)]");
		expect(pixelClassFor(19, MFS_LADDER)).toBe("text-[calc(var(--mfs)+2px)]");
	});
});

describe("fixed font-size detection", () => {
	test("counts pixel classes, tailwind size classes and inline sizes; ignores colors and near-misses", () => {
		const source = [
			'<span className="text-[11px] text-primary">a</span>',
			'<span className="sm:text-sm text-red-500">b</span>',
			'<span className="text-2xl font-bold text-t1">c</span>',
			'<span className="text-small text-2xlarge my-text-sm">d</span>',
			'<p style={{ fontFamily: "var(--font-ui)", fontSize: 18, marginBottom: 4 }}>e</p>',
			'<p style={{ fontSize: "12px" }}>f</p>',
			"const uiFontSize = 17;",
		].join("\n");
		const matches = collectFixedFontSizeMatches("apps/web/src/components/shared/Sample.tsx", source);
		expect(matches.map((match) => match.text)).toEqual(["text-[11px]", "text-sm", "text-2xl", "fontSize: 18", 'fontSize: "12px"']);
		expect(matches[0]).toMatchObject({ kind: "pixel-class", sizePx: 11, line: 1 });
		expect(matches[1]).toMatchObject({ kind: "tailwind-size-class", sizePx: 14, line: 2 });
		expect(matches[2]).toMatchObject({ kind: "tailwind-size-class", sizePx: 24, line: 3 });
		expect(matches[3]).toMatchObject({ kind: "inline-font-size", sizePx: 18, line: 5 });
		expect(matches[4]).toMatchObject({ kind: "inline-font-size", sizePx: 12, line: 6 });
	});

	test("counts css font-size rules for the styles.css target only", () => {
		const css = ".a{font-size:12px}\n.b{font-size:.85em}\n.c{font-size: 12.5px}";
		expect(collectFixedFontSizeMatches(FONT_SIZE_CSS_TARGET, css).map((match) => match.text)).toEqual([
			"font-size:12px",
			"font-size: 12.5px",
		]);
		// Experience starters embed css in ts strings — isolated frame documents,
		// the ladder variables do not exist there, so the css rule never applies.
		expect(collectFixedFontSizeMatches("apps/web/src/components/experience/starters/blank.ts", css)).toEqual([]);
	});

	test("scope rules: tests, components/dev and the tweaks default are out of scope", () => {
		expect(fontSizeScopeRejection("apps/web/src/components/shared/Sample.tsx")).toBeUndefined();
		expect(fontSizeScopeRejection(FONT_SIZE_CSS_TARGET)).toBeUndefined();
		expect(fontSizeScopeRejection("apps/web/src/components/shared/Sample.test.tsx")).toBe("test file");
		expect(fontSizeScopeRejection("apps/web/src/components/dev/ThemeTuner.tsx")).toBe("components/dev is excluded");
		expect(fontSizeScopeRejection("apps/web/src/lib/local-storage.ts")).toContain("chat font-size setting");
		expect(fontSizeScopeRejection("apps/web/src/themes/coffee.css")).toContain("only css target");
		expect(fontSizeScopeRejection("services/api/src/server/updater.ts")).toContain("outside apps/web/src");
	});

	test("chat message files are the message-content candidates", () => {
		expect(isChatMessageFile("apps/web/src/components/chat/MessageBlock.tsx")).toBe(true);
		expect(isChatMessageFile("apps/web/src/components/chat/message-slots/scene-zone.tsx")).toBe(true);
		expect(isChatMessageFile("apps/web/src/components/chat/message-meta/ meta-line.tsx")).toBe(true);
		expect(isChatMessageFile("apps/web/src/components/chat/InputArea.tsx")).toBe(false);
		expect(isChatMessageFile("apps/web/src/components/shared/MessageLike.tsx")).toBe(false);
	});

	test("areas follow the audit census split", () => {
		expect(fontSizeArea("apps/web/src/components/build/editors/LorebookEditor.tsx")).toBe("components/build");
		expect(fontSizeArea("apps/web/src/components/shared/agent-shell/AgentRunCard.tsx")).toBe("components/shared");
		expect(fontSizeArea("apps/web/src/lib/field-tokens.ts")).toBe("rest");
		expect(fontSizeArea(FONT_SIZE_CSS_TARGET)).toBe("rest");
	});
});

describe("font-size codemod conversion", () => {
	test("converts and flags text inside fixed-size boxes", () => {
		const source = '<span className="inline-flex h-4 items-center rounded text-[11px]">3</span>';
		const result = convertSourceFontSizes("apps/web/src/components/shared/TokenCounter.tsx", source);
		expect(result.converted).toBe(true);
		expect(result.output).toBe('<span className="inline-flex h-4 items-center rounded text-[calc(var(--ui-fs)-3px)]">3</span>');
		expect(result.flaggedFixedSizeBox.map((match) => match.text)).toEqual(["text-[11px]"]);
	});

	test("converts and flags size-* circles and w-5 badges the same way", () => {
		const source = '<i className="size-5 rounded-full text-[9px]"/>\n<b className="w-5 text-xs">n</b>';
		const result = convertSourceFontSizes("apps/web/src/components/shared/Badge.tsx", source);
		expect(result.output).toBe('<i className="size-5 rounded-full text-[calc(var(--ui-fs)-5px)]"/>\n<b className="w-5 text-[calc(var(--ui-fs)-2px)] leading-4">n</b>');
		expect(result.flaggedFixedSizeBox.map((match) => match.text)).toEqual(["text-[9px]", "text-xs"]);
	});

	test("keeps an existing explicit leading and flags the conflict instead of adding a companion", () => {
		const source = '<h2 className="text-lg leading-9">T</h2>';
		const result = convertSourceFontSizes("apps/web/src/components/modals/Sample.tsx", source);
		expect(result.output).toBe('<h2 className="text-[calc(var(--ui-fs)+4px)] leading-9">T</h2>');
		expect(result.flaggedLeadingConflict.map((match) => match.text)).toEqual(["text-lg"]);
	});

	test("adds the tailwind companion when no leading is present", () => {
		const source = '<p className="text-sm">T</p>';
		const result = convertSourceFontSizes("apps/web/src/components/modals/Sample.tsx", source);
		expect(result.output).toBe('<p className="text-[var(--ui-fs)] leading-5">T</p>');
		expect(result.flaggedLeadingConflict).toEqual([]);
	});

	test("converts inline numeric and quoted fontSize values", () => {
		const source = '<p style={{ fontSize: 18 }}>a</p>\n<p style={{ fontSize: "12px" }}>b</p>';
		const result = convertSourceFontSizes("apps/web/src/components/build/editors/Preview.tsx", source);
		expect(result.output).toBe('<p style={{ fontSize: "calc(var(--ui-fs)+4px)" }}>a</p>\n<p style={{ fontSize: "calc(var(--ui-fs)-2px)" }}>b</p>');
	});

	test("converts styles.css font-size rules", () => {
		const source = ".scene-note{font-size:12.5px}\n.build-tag{font-size:11px}";
		const result = convertSourceFontSizes(FONT_SIZE_CSS_TARGET, source);
		expect(result.output).toBe(".scene-note{font-size: calc(var(--ui-fs)-1.5px)}\n.build-tag{font-size: calc(var(--ui-fs)-3px)}");
	});

	test("lists chat message files without converting them in the default mode", () => {
		const source = '<span className="text-[13px]">msg</span>';
		const result = convertSourceFontSizes("apps/web/src/components/chat/MessageBlock.tsx", source);
		expect(result.converted).toBe(false);
		expect(result.output).toBe(source);
		expect(result.listedMfsDecision.map((match) => match.text)).toEqual(["text-[13px]"]);
	});

	test("converts chat message files onto --mfs in mfs mode", () => {
		const source = '<span className="text-[13px]">msg</span>';
		const result = convertSourceFontSizes("apps/web/src/components/chat/MessageBlock.tsx", source, { mfs: true });
		expect(result.converted).toBe(true);
		expect(result.mode).toBe("mfs");
		expect(result.output).toBe('<span className="text-[calc(var(--mfs)-4px)]">msg</span>');
		expect(result.listedMfsDecision).toEqual([]);
	});

	test("refuses non-chat files in mfs mode instead of converting them onto --mfs", () => {
		const source = '<span className="text-[13px]">chrome</span>';
		const result = convertSourceFontSizes("apps/web/src/components/shared/Sample.tsx", source, { mfs: true });
		expect(result.converted).toBe(false);
		expect(result.skippedNotChatMessage).toBe(true);
		expect(result.output).toBe(source);
	});

	test("conversion is idempotent: rerunning on converted output changes nothing", () => {
		const source = [
			'<a className="text-[11px]">1</a>',
			'<b className="text-base">2</b>',
			'<i style={{ fontSize: 18 }}>3</i>',
			'<u className="text-2xl">4</u>',
		].join("\n");
		const file = "apps/web/src/components/shared/Sample.tsx";
		const first = convertSourceFontSizes(file, source);
		expect(first.converted).toBe(true);
		const second = convertSourceFontSizes(file, first.output);
		expect(second.matches).toEqual([]);
		expect(second.replacements).toEqual([]);
		expect(second.output).toBe(first.output);
		const mfsFirst = convertSourceFontSizes("apps/web/src/components/chat/MessageBlock.tsx", source, { mfs: true });
		const mfsSecond = convertSourceFontSizes("apps/web/src/components/chat/MessageBlock.tsx", mfsFirst.output, { mfs: true });
		expect(mfsSecond.output).toBe(mfsFirst.output);
		expect(mfsSecond.matches).toEqual([]);
	});
});

describe("font-size codemod run", () => {
	function fixtureRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "vt-font-size-codemod-"));
		writeFixture(root, "apps/web/src/components/chat/MessageBlock.tsx", '<span className="text-[13px]">msg</span>\n');
		writeFixture(root, "apps/web/src/components/shared/TokenCounter.tsx", '<span className="h-4 text-[11px]">3</span>\n');
		writeFixture(root, "apps/web/src/components/build/editors/Lorebook.tsx", '<p className="text-xs">k</p>\n');
		writeFixture(root, FONT_SIZE_CSS_TARGET, ".build-tag{font-size:11px}\n");
		writeFixture(root, "apps/web/src/components/dev/ThemeTuner.tsx", '<p className="text-[11px]">dev</p>\n');
		writeFixture(root, "apps/web/src/lib/local-storage.ts", "export const DEFAULT_TWEAKS = { fontSize: 17, uiFontSize: 17 };\n");
		writeFixture(root, "apps/web/src/components/shared/Skipped.test.tsx", '<p className="text-[11px]">test</p>\n');
		writeFixture(root, "apps/web/src/themes/coffee.css", ".themed{font-size:12px}\n");
		return root;
	}

	test("dry run reports areas, per-file counts and the flagged lists without writing", async () => {
		const root = fixtureRoot();
		try {
			const before = readFileSync(join(root, "apps/web/src/components/shared/TokenCounter.tsx"), "utf8");
			const outcome = await runFontSizeCodemod("apps/web/src", { dryRun: true, root });
			expect(outcome.changedFiles).toEqual([]);
			expect(readFileSync(join(root, "apps/web/src/components/shared/TokenCounter.tsx"), "utf8")).toBe(before);
			expect(outcome.report).toContain("components/build  1 in 1 file(s)");
			expect(outcome.report).toContain("components/chat  1 in 1 file(s)");
			expect(outcome.report).toContain("components/shared  1 in 1 file(s)");
			expect(outcome.report).toContain("rest  1 in 1 file(s)");
			expect(outcome.report).toContain("apps/web/src/components/chat/MessageBlock.tsx  1 (pixel 1, tailwind 0, inline 0, css 0)  [not converted: --mfs decision]");
			expect(outcome.report).toContain("flagged — fixed-size box (converted; check the box still fits):");
			expect(outcome.report).toContain("apps/web/src/components/shared/TokenCounter.tsx:1:22  text-[11px]");
			expect(outcome.report).toContain("--mfs decision — NOT converted (decide per occurrence, rerun with --mfs):");
			expect(outcome.report).toContain("apps/web/src/components/chat/MessageBlock.tsx:1:18  text-[13px]");
			expect(outcome.report).toContain("totals: 4 occurrence(s) in 4 file(s) — pixel 2, tailwind 1, inline 0, css 1");
			expect(outcome.report).toContain("dry run — no files written");
			const rerun = await runFontSizeCodemod("apps/web/src", { dryRun: true, root });
			expect(rerun.report).toBe(outcome.report);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("write mode converts scoped files on disk and leaves the rest untouched", async () => {
		const root = fixtureRoot();
		try {
			const outcome = await runFontSizeCodemod("apps/web/src", { root });
			expect(outcome.changedFiles).toEqual([
				"apps/web/src/components/build/editors/Lorebook.tsx",
				"apps/web/src/components/shared/TokenCounter.tsx",
				FONT_SIZE_CSS_TARGET,
			]);
			expect(readFileSync(join(root, "apps/web/src/components/shared/TokenCounter.tsx"), "utf8")).toBe(
				'<span className="h-4 text-[calc(var(--ui-fs)-3px)]">3</span>\n',
			);
			expect(readFileSync(join(root, "apps/web/src/components/chat/MessageBlock.tsx"), "utf8")).toBe(
				'<span className="text-[13px]">msg</span>\n',
			);
			expect(readFileSync(join(root, "apps/web/src/lib/local-storage.ts"), "utf8")).toBe(
				"export const DEFAULT_TWEAKS = { fontSize: 17, uiFontSize: 17 };\n",
			);
			expect(readFileSync(join(root, "apps/web/src/components/dev/ThemeTuner.tsx"), "utf8")).toBe(
				'<p className="text-[11px]">dev</p>\n',
			);
			expect(readFileSync(join(root, "apps/web/src/themes/coffee.css"), "utf8")).toBe(".themed{font-size:12px}\n");
			expect(readFileSync(join(root, FONT_SIZE_CSS_TARGET), "utf8")).toBe(".build-tag{font-size: calc(var(--ui-fs)-3px)}\n");
			expect(outcome.report).toContain("written: 3 file(s)");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("collectFontSizeTargetFiles throws for an explicit out-of-scope file", () => {
		const root = fixtureRoot();
		try {
			expect(() => collectFontSizeTargetFiles("apps/web/src/lib/local-storage.ts", root)).toThrow("out of codemod scope");
			expect(() => collectFontSizeTargetFiles("apps/web/src/missing.tsx", root)).toThrow("path not found");
			expect(collectFontSizeTargetFiles("apps/web/src/components/shared", root)).toEqual([
				"apps/web/src/components/shared/TokenCounter.tsx",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
