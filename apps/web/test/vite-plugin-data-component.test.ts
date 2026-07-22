/**
 * Characterization tests for the data-component Vite plugin transform.
 *
 * These tests pin the observable behavior of the JSX transform that injects
 * `data-component="Name"` attributes into dev-mode JSX, so Wave 5's Bun-native
 * port can be verified against the same contract.
 *
 * The transform is tested as a unit: we call the plugin's transform hook
 * directly after enabling it via configResolved({ command: "serve" }).
 * No Vite server is spun up.
 */
import { describe, test, expect } from "bun:test";
import type { ResolvedConfig } from "vite";
import { dataComponentPlugin } from "../vite-plugin-data-component.js";

const FILE = "/src/component.tsx";

/**
 * Build a dev-mode (serve) transform callable. The plugin enables itself
 * when configResolved sees command === "serve".
 */
function devTransform(): (code: string, id: string) => string | null {
	const plugin = dataComponentPlugin();
	if (plugin.configResolved) {
		plugin.configResolved({ command: "serve" } as ResolvedConfig);
	}
	return (code: string, id: string): string | null => {
		const transform = plugin.transform;
		if (typeof transform !== "function") return null;
		const out = transform.call(plugin, code, id);
		return typeof out === "string" ? out : null;
	};
}

/**
 * Build a production-mode (build) transform callable. The plugin stays
 * disabled and should always return null.
 */
function prodTransform(): (code: string, id: string) => string | null {
	const plugin = dataComponentPlugin();
	if (plugin.configResolved) {
		plugin.configResolved({ command: "build" } as ResolvedConfig);
	}
	return (code: string, id: string): string | null => {
		const transform = plugin.transform;
		if (typeof transform !== "function") return null;
		const out = transform.call(plugin, code, id);
		return typeof out === "string" ? out : null;
	};
}

// ─── Plugin metadata ───

describe("data-component plugin — identity", () => {
	test("plugin has the correct name and enforce value", () => {
		const plugin = dataComponentPlugin();
		expect(plugin.name).toBe("vite-plugin-data-component");
		expect(plugin.enforce).toBe("pre");
	});

	test("exposes configResolved and transform hooks", () => {
		const plugin = dataComponentPlugin();
		expect(typeof plugin.configResolved).toBe("function");
		expect(typeof plugin.transform).toBe("function");
	});
});

// ─── Dev mode activation ───

describe("data-component plugin — dev mode activation", () => {
	test("injects attribute into root JSX of exported function component", () => {
		const t = devTransform();
		const out = t(
			`export function Foo() {\n  return <div/>;\n}\n`,
			FILE,
		);
		expect(out).not.toBeNull();
		expect(out).toContain('data-component="Foo"');
		expect(out).toContain('<div data-component="Foo"/>');
	});

	test("injects attribute into root JSX of default export function", () => {
		const t = devTransform();
		const out = t(
			`export default function Bar() {\n  return <span>hi</span>;\n}\n`,
			FILE,
		);
		expect(out).not.toBeNull();
		expect(out).toContain('data-component="Bar"');
	});

	test("injects attribute for arrow const component with explicit return block", () => {
		const t = devTransform();
		const out = t(
			`export const Baz = () => {\n  return <p>x</p>;\n};\n`,
			FILE,
		);
		expect(out).not.toBeNull();
		expect(out).toContain('data-component="Baz"');
	});
});

// ─── Element types and insertion position ───

describe("data-component plugin — element types", () => {
	test("intrinsic element (lowercase tag) receives attribute", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <main/>;\n}\n`,
			FILE,
		);
		expect(out).toContain('<main data-component="C"/>');
	});

	test("component tag (uppercase) receives the EXPORT name, not the tag name", () => {
		const t = devTransform();
		const out = t(
			`export function Wrapper() {\n  return <Child/>;\n}\n`,
			FILE,
		);
		// The attribute value is the exported function name, not the JSX tag name
		expect(out).toContain('<Child data-component="Wrapper"/>');
		expect(out).not.toContain('data-component="Child"');
	});

	test("self-closing tag gets attribute before the closing slash", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <img/>;\n}\n`,
			FILE,
		);
		expect(out).toContain('<img data-component="C"/>');
	});

	test("tag with existing attributes — attribute inserted after tag name, before existing attrs", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div className="x">hi</div>;\n}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="C" className="x">');
	});

	test("tag with spread props — attribute inserted before spread", () => {
		const t = devTransform();
		const out = t(
			`export function C(props: { x: number }) {\n  return <div {...props}/>;\n}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="C" {...props}/>');
	});

	test("fragment with single child returns null — '>' from <> triggers generic-skip", () => {
		// QUIRK: <><div/></> — the char before <div is > (from <>), which
		// matches the generic-skip regex /[A-Za-z0-9_)>]/, so <div is treated
		// as a TS generic and skipped. The k-loop finds no valid tag → null.
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <><div/></>;\n}\n`,
			FILE,
		);
		expect(out).toBeNull();
	});

	test("fragment with whitespace before child IS tagged", () => {
		// When there's whitespace between <> and the child, charBefore is a
		// space, so the generic-skip does NOT trigger.
		const t = devTransform();
		const out = t(
			`export function C() {\n  return (\n    <>\n      <div/>\n    </>\n  );\n}\n`,
			FILE,
		);
		expect(out).not.toBeNull();
		expect(out).toContain('<div data-component="C"/>');
	});

	test("tag with dotted name (e.g. Foo.Bar) matches the tag regex", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <Foo.Bar/>;\n}\n`,
			FILE,
		);
		// [A-Za-z0-9.-]* allows dots in tag names
		expect(out).toContain('data-component="C"');
	});
});

// ─── JSX layout patterns ───

describe("data-component plugin — JSX layout patterns", () => {
	test("JSX on the same line as return", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>;\n}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="C"/>');
	});

	test("multiline return — return paren on one line, JSX on next line", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return (\n    <div/>\n  );\n}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="C"/>');
	});

	test("return with parenthesized JSX on same line", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return (<div/>);\n}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="C"/>');
	});
});

// ─── Scope and deduplication ───

describe("data-component plugin — scope and deduplication", () => {
	test("only the first matching component in a file receives the attribute", () => {
		const t = devTransform();
		const out = t(
			`export function First() {\n  return <div/>\n}\n` +
			`export function Second() {\n  return <span/>\n}\n`,
			FILE,
		);
		expect(out).toContain('data-component="First"');
		expect(out).not.toContain('data-component="Second"');
	});

	test("first component's return with no JSX scans into subsequent components (k-loop has no depth guard)", () => {
		// QUIRK: when a component's return has no JSX tag on its line, the
		// k-loop scans forward through ALL remaining lines (including other
		// function bodies) until it finds any <Tag. So NoJsx's name gets
		// injected into WithJsx's div.
		const t = devTransform();
		const out = t(
			`export function NoJsx() {\n  return null;\n}\n` +
			`export function WithJsx() {\n  return <div/>\n}\n`,
			FILE,
		);
		expect(out).not.toBeNull();
		expect(out).toContain('data-component="NoJsx"');
		// WithJsx never gets its own attribute (modified breaks after first)
		expect(out).not.toContain('data-component="WithJsx"');
	});

	test("skips insertion when data-component already present — returns null (no modification)", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div data-component="existing"/>;\n}\n`,
			FILE,
		);
		// The dedup check finds "data-component" within 20 chars of insertPos,
		// breaks the while-loop, and the k-loop finds no other tag → null.
		expect(out).toBeNull();
	});

	test("nested function returns are skipped via brace depth tracking", () => {
		const t = devTransform();
		const out = t(
			`export function Outer() {\n` +
			`  const helper = () => {\n` +
			`    return <span/>\n` +
			`  }\n` +
			`  return <div/>\n` +
			`}\n`,
			FILE,
		);
		expect(out).toContain('<div data-component="Outer"/>');
		// The nested component's return is at a deeper brace level, so it's skipped
		expect(out).not.toContain('<span data-component');
	});
});

// ─── File-level guards ───

describe("data-component plugin — file-level guards", () => {
	test("production (build) mode — transform is a no-op", () => {
		const t = prodTransform();
		const out = t(
			`export function C() {\n  return <div/>;\n}\n`,
			FILE,
		);
		expect(out).toBeNull();
	});

	test(".ts files are skipped", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>\n}\n`,
			"/src/foo.ts",
		);
		expect(out).toBeNull();
	});

	test(".jsx files are processed", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>\n}\n`,
			"/src/foo.jsx",
		);
		expect(out).toContain('data-component="C"');
	});

	test(".tsx files are processed", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>\n}\n`,
			"/src/foo.tsx",
		);
		expect(out).toContain('data-component="C"');
	});

	test("node_modules files are skipped", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>\n}\n`,
			"/node_modules/lib/foo.tsx",
		);
		expect(out).toBeNull();
	});

	test("test files (.test.) are skipped", () => {
		const t = devTransform();
		const out = t(
			`export function C() {\n  return <div/>\n}\n`,
			"/src/foo.test.tsx",
		);
		expect(out).toBeNull();
	});

	test("files without exports are skipped", () => {
		const t = devTransform();
		const out = t(
			`function C() {\n  return <div/>\n}\n`,
			FILE,
		);
		expect(out).toBeNull();
	});

	test("lowercase export names are not matched (component name must start uppercase)", () => {
		const t = devTransform();
		const out = t(
			`export function widget() {\n  return <div/>\n}\n`,
			FILE,
		);
		expect(out).toBeNull();
	});
});

// ─── Arrow const edge cases ───

describe("data-component plugin — arrow const edge cases", () => {
	test("implicit-return arrow const does NOT receive attribute (no 'return' keyword found)", () => {
		const t = devTransform();
		const out = t(
			`export const C = () => <div/>;\n`,
			FILE,
		);
		// The const regex matches "C", but the transform scans for a "return"
		// keyword — arrow implicit returns don't have one.
		expect(out).toBeNull();
	});

	test("single-arg arrow const with explicit return receives attribute", () => {
		const t = devTransform();
		const out = t(
			`export const C = (props) => {\n  return <div/>\n};\n`,
			FILE,
		);
		expect(out).toContain('data-component="C"');
	});

	test("empty-parens arrow const with explicit return receives attribute", () => {
		const t = devTransform();
		const out = t(
			`export const C = () => {\n  return <div/>\n};\n`,
			FILE,
		);
		expect(out).toContain('data-component="C"');
	});

	test("const with return-type annotation after parens is matched", () => {
		const t = devTransform();
		const out = t(
			`export const C = (): JSX.Element => {\n  return <div/>\n};\n`,
			FILE,
		);
		// The regex alternative (?:\([^)]*\)\s*(?:=>|:)) accepts ":" after
		// the closing paren for return-type annotations.
		expect(out).toContain('data-component="C"');
	});

	test("let keyword is blocked by the whole-file export guard", () => {
		// QUIRK: the per-line regex accepts `export let Name = ...` but the
		// whole-file guard only checks for "export function", "export const",
		// and "export default function" substrings. "export let" contains
		// none of those, so the guard returns null before matching runs.
		const t = devTransform();
		const out = t(
			`export let C = () => {\n  return <div/>\n};\n`,
			FILE,
		);
		expect(out).toBeNull();
	});
});
