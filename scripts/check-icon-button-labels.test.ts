import { expect, test } from "bun:test";
import { findUnlabeledIconButtons, isIconOnlyContent } from "./check-icon-button-labels.js";

test("flags an icon-only button with no accessible name, at its line", () => {
	const src = [
		"export function X() {",
		"  return (",
		'    <button type="button" onClick={() => go()}>',
		"      <Ic.crop />",
		"    </button>",
		"  );",
		"}",
	].join("\n");
	expect(findUnlabeledIconButtons(src)).toEqual([3]);
});

test("flags multi-line opening tags with arrow functions and > inside attributes", () => {
	const src = [
		"<button",
		'  type="button"',
		"  disabled={count > 3}",
		"  onClick={(e) => { e.stopPropagation(); open(); }}",
		"><Icons.Caret direction=\"r\" /></button>",
	].join("\n");
	expect(findUnlabeledIconButtons(src)).toEqual([1]);
});

test("flags empty and self-closing buttons", () => {
	expect(findUnlabeledIconButtons('<button type="button"></button>')).toEqual([1]);
	expect(findUnlabeledIconButtons('<button type="button" />')).toEqual([1]);
});

test("a naming attribute or a spread exempts the button", () => {
	for (const attr of ['aria-label={t("close")}', 'aria-labelledby="h1"', 'title="Close"', "{...props}"]) {
		expect(findUnlabeledIconButtons(`<button ${attr}><XIcon /></button>`)).toEqual([]);
	}
});

test("visible text, translated text, variables and ternaries count as a name", () => {
	expect(findUnlabeledIconButtons("<button><XIcon /> Save</button>")).toEqual([]);
	expect(findUnlabeledIconButtons('<button><XIcon />{t("save")}</button>')).toEqual([]);
	expect(findUnlabeledIconButtons("<button>{label}</button>")).toEqual([]);
	expect(findUnlabeledIconButtons("<button>{open ? <A /> : <B />}</button>")).toEqual([]);
	expect(findUnlabeledIconButtons("<button><span>Save</span></button>")).toEqual([]);
});

test("only intrinsic <button> counts; comments are ignored", () => {
	expect(findUnlabeledIconButtons("<ButtonGroup><XIcon /></ButtonGroup>")).toEqual([]);
	expect(findUnlabeledIconButtons("// <button><XIcon /></button>")).toEqual([]);
	expect(findUnlabeledIconButtons(" * <button><XIcon /></button>")).toEqual([]);
});

test("isIconOnlyContent: JSX comments and whitespace are not a name", () => {
	expect(isIconOnlyContent("\n  {/* icon */}\n  <XIcon size={14} />\n")).toBe(true);
	expect(isIconOnlyContent("<XIcon /><YIcon />")).toBe(true);
	expect(isIconOnlyContent("<span><XIcon /></span>")).toBe(false);
});
