import { expect, test } from "bun:test";
import { findBareTitles, maskLiterals } from "./check-bare-titles.js";

test("flags an intrinsic title attribute, at its line, with its value", () => {
	const src = [
		"export function X() {",
		"  return (",
		'    <div className="row">',
		'      <span title="why">x</span>',
		"    </div>",
		"  );",
		"}",
	].join("\n");
	expect(findBareTitles(src)).toEqual([{ line: 4, element: "span", value: '"why"' }]);
});

test("flags multi-line opening tags — the whole point of the scan", () => {
	const src = [
		"<button",
		"  type=\"button\"",
		"  title={t('chat.copyPrompt')}",
		"  onClick={copy}",
		"/>",
	].join("\n");
	expect(findBareTitles(src)).toEqual([{ line: 1, element: "button", value: "{t('chat.copyPrompt')}" }]);
});

test("iframe is exempt — its title is the accessible name", () => {
	expect(findBareTitles('<iframe title="preview" src={url} />')).toEqual([]);
});

test("PascalCase components never count — title there is a prop, not a DOM attribute", () => {
	expect(findBareTitles('<CustomTooltip title="x"><span>hi</span></CustomTooltip>')).toEqual([]);
	expect(findBareTitles('<ModelPicker title="x" />')).toEqual([]);
});

test("strings, line comments, block comments and JSX comments are masked out", () => {
	expect(findBareTitles(`const html = '<div title="x">';`)).toEqual([]);
	expect(findBareTitles('// <div title="x"></div>')).toEqual([]);
	expect(findBareTitles("/* <div title=\"x\"></div> */")).toEqual([]);
	expect(findBareTitles("{/* <div title=\"x\"></div> */}")).toEqual([]);
});

test("JSX inside a template interpolation is code and scans", () => {
	const src = "const rows = `<a>${items.map((i) => <li title={i.name} key={i.id}>{i.name}</li>)}</a>`;";
	expect(findBareTitles(src)).toEqual([{ line: 1, element: "li", value: "{i.name}" }]);
});

test("generics and comparisons do not produce hits", () => {
	expect(findBareTitles("const x = useState<record<string, number>>({});")).toEqual([]);
	expect(findBareTitles("if (a < b && c > d) return null;")).toEqual([]);
});

test("data-title and other title-suffixed attributes do not count", () => {
	expect(findBareTitles('<div data-title="x" />')).toEqual([]);
	expect(findBareTitles('<div aria-title="x" />')).toEqual([]);
});

test("a quoted value containing > or an expression containing a string with > stays one tag", () => {
	const src = '<div title="a > b" id="keep" />';
	expect(findBareTitles(src)).toEqual([{ line: 1, element: "div", value: '"a > b"' }]);
	const withExpr = '<div title={cond ? "a>b" : ""} id="keep" />';
	expect(findBareTitles(withExpr)).toEqual([{ line: 1, element: "div", value: '{cond ? "a>b" : ""}' }]);
});

test("template-literal keys do not swallow the tag into later code (CRLF regression)", () => {
	// Found on CoauthorToolActivitySlot.tsx: interpolation closers stayed
	// visible, drove openingTagEnd's depth negative, and the "tag" ran 140
	// lines forward into `const title = isRead` — a phantom hit.
	const src = [
		"<div",
		"  key={`${a}-${b}-${i}`}",
		'  className="row"',
		">",
		"  text",
		"</div>",
		"const title = isRead",
		"    ? activityLabel",
		"    : idleLabel;",
	].join("\r\n");
	expect(findBareTitles(src)).toEqual([]);
});

test("a real title on a template-keyed element still counts", () => {
	const src = '<div key={`${a}-${i}`} title={t("why")}>x</div>\nconst title = decoy;';
	expect(findBareTitles(src)).toEqual([{ line: 1, element: "div", value: '{t("why")}' }]);
});

test("maskLiterals: body opaque, interpolation content visible, delimiters masked", () => {
	const src = "const a = \"x\";\n// c\nconst b = `t ${a} u`;\n/* b */\n";
	const masked = maskLiterals(src);
	expect(masked.length).toBe(src.length);
	expect((masked.match(/\n/g) ?? []).length).toBe((src.match(/\n/g) ?? []).length);
	// `"x"` keeps delimiters; comments go blank; the template keeps only its
	// interpolation code (`a`) — body, backticks and ${…} delimiters are spaces.
	expect(masked).toBe(`const a = " ";\n    \nconst b = ${" ".repeat(5)}a${" ".repeat(4)};\n${" ".repeat(7)}\n`);
});
