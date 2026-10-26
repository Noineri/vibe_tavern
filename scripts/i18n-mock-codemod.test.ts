import { describe, expect, test } from "bun:test";
import {
	INTERPOLATED_OVERRIDES,
	classifyFile,
	extractCustomSpec,
	findMockCallSpan,
	insertSeamImport,
	isPortableFunctionValue,
	splitObjectEntries,
	stripParameterAnnotations,
	transformFile,
} from "./i18n-mock-codemod.js";

const IDENTITY_SOURCE = `import { describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { MyComponent } = await import("./MyComponent.js");
`;

const IDENTITY_FILE = "apps/web/src/components/settings/provider/SomePanel.test.tsx";

/** Swaps the `useT` value inside IDENTITY_SOURCE for a synthetic one. */
function withUseT(useTValue: string): string {
	return IDENTITY_SOURCE.replace(
		/useT: \(\) => \(\{[\s\S]*?\n  \}\),\n/,
		`useT: () => (${useTValue}),\n`,
	);
}

describe("i18n mock codemod classification", () => {
	test("full identity shape (spread + identity family) classifies IDENTITY", () => {
		expect(classifyFile(IDENTITY_FILE, IDENTITY_SOURCE).classification).toBe("IDENTITY");
	});

	test("partial identity shapes (t only, NOOP setLocale, comment-led, k-param) classify IDENTITY", () => {
		const partials = [
			`{ t: (key: string) => key }`,
			`{ t: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }`,
			`{\n    // Return the key verbatim — assertions check for key strings.\n    t: (k: string) => k,\n    tDynamic: (k: string) => k,\n    locale: "en",\n    setLocale: () => {},\n    ready: true,\n  }`,
			`{ t: (k: string) => k, setLocale: () => {} }`,
		];
		for (const useT of partials) {
			expect(classifyFile(IDENTITY_FILE, withUseT(useT)).classification, useT).toBe("IDENTITY");
		}
	});

	test("object-returning t (not a string function) classifies OTHER", () => {
		const customs = [
			`{ t: (key: string) => ({ label: key }) }`,
			`{ t: 42 }`,
		];
		for (const useT of customs) {
			expect(classifyFile(IDENTITY_FILE, withUseT(useT)).classification, useT).toBe("OTHER");
		}
	});

	test("factory without the real-module spread classifies OTHER (jest-style / missing spread)", () => {
		const src = IDENTITY_SOURCE.replace("...realI18n,", "");
		expect(classifyFile(IDENTITY_FILE, src).classification).toBe("OTHER");
	});

	test("named stableT reference (no object-returning arrow) classifies OTHER", () => {
		expect(classifyFile(IDENTITY_FILE, withUseT("stableT")).classification).toBe("OTHER");
	});

	test("already-migrated files classify ON-SEAM and are never editable", () => {
		const plan = classifyFile(IDENTITY_FILE, "installI18nContextSeam();\n");
		expect(plan.classification).toBe("ON-SEAM");
		expect(plan.editable).toBe(false);
	});

	test("verified overrides classify INTERPOLATED with their keys only while the markers live in the mock block", () => {
		const file = "apps/web/src/components/chat/ImageGenProgressRow.test.tsx";
		const keys = INTERPOLATED_OVERRIDES[file]?.interpolateKeys ?? [];
		// The real shape: the key literals sit INSIDE the mock block (the t
		// closure), so the override's markers are verifiable in-span.
		const fresh = `import { describe, expect, it, mock } from "bun:test";\nimport { useDomEnv } from "../../test/dom-env.js";\n\nconst realI18n = await import("../../i18n/context.js");\nmock.module("../../i18n/context.js", () => ({\n  ...realI18n,\n  useT: () => ({\n    t: (key: string, values?: Record<string, number>) => {\n      if (key === "image_gen_horde_queue") {\n        return \`In queue: position \${values?.position} · ~\${values?.minutes}m\`;\n      }\n      if (key === "image_gen_horde_drawing") return "Drawing…";\n      return key;\n    },\n    tDynamic: (key: string) => key,\n    locale: "en",\n    setLocale: () => {},\n    ready: true,\n  }),\n}));\n`;
		const plan = classifyFile(file, fresh);
		expect(plan.classification).toBe("INTERPOLATED");
		expect(plan.interpolateKeys).toEqual(keys);
		// A mock block WITHOUT the override markers must not ride the stale
		// table — it falls through to CUSTOM (the suffix semantics port verbatim)
		// for exact reading, never silently INTERPOLATED.
		const stale = withUseT(`{ t: (key: string, n?: number) => \`\${key}!\${n}\`, tDynamic: (key: string) => key }`);
		expect(classifyFile(file, stale).classification).toBe("CUSTOM");
	});
});

describe("i18n mock codemod transform", () => {
	test("replaces the mock in place, before the dynamic component import, and drops the dead const + mock binding", () => {
		const plan = classifyFile(IDENTITY_FILE, IDENTITY_SOURCE);
		const out = transformFile(IDENTITY_SOURCE, plan);
		expect(out).not.toBeNull();
		const text = out as string;
		expect(text).toContain('import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";');
		expect(text).toContain("installI18nContextSeam();\n");
		expect(text).not.toContain("mock.module");
		expect(text).not.toContain("realI18n");
		expect(text).not.toMatch(/import\s*\{[^}]*\bmock\b/);
		// Ordering constraint: the seam call sits before the dynamic import of
		// the component under test (exactly where the mock was).
		expect(text.indexOf("installI18nContextSeam();")).toBeLessThan(text.indexOf('await import("./MyComponent.js")'));
		// The seam import rides the dom-env import line (house style).
		const lines = text.split("\n");
		const domEnvLineIdx = lines.findIndex((line) => line.includes("test/dom-env.js"));
		const seamLineIdx = lines.findIndex((line) => line.includes("i18n-context-seam.js"));
		expect(seamLineIdx).toBe(domEnvLineIdx + 1);
	});

	test("keeps the real-context const when the file still references it", () => {
		const src = `${IDENTITY_SOURCE}\nconst provider = realI18n.LocaleProvider;\n`;
		const out = transformFile(src, classifyFile(IDENTITY_FILE, src));
		expect(out).toContain("realI18n.LocaleProvider");
		expect(out).toContain("const realI18n = await import");
	});

	test("keeps the mock binding when another mock.module survives", () => {
		const src = IDENTITY_SOURCE.replace(
			'const { MyComponent } = await import("./MyComponent.js");',
			'const realMobile = await import("../../../hooks/use-mobile.js");\nmock.module("../../../hooks/use-mobile.js", () => ({ ...realMobile, useIsMobile: () => false }));\nconst { MyComponent } = await import("./MyComponent.js");',
		);
		const out = transformFile(src, classifyFile(IDENTITY_FILE, src));
		expect(out).toMatch(/import \{ describe, expect, it, mock \} from "bun:test";/);
		expect(out).toContain("use-mobile.js");
	});

	test("INTERPOLATED transform emits the interpolateKeys spec", () => {
		const file = "apps/web/src/components/layout/topbar-regex-indicator.test.tsx";
		const src = `import { describe, expect, it, mock } from "bun:test";\nimport { useDomEnv } from "../../../test/dom-env.js";\n\nconst realI18n = await import("../../../i18n/context.js");\nmock.module("../../../i18n/context.js", () => ({\n  ...realI18n,\n  useT: () => ({\n    t: (key: string, opts?: Record<string, unknown>) => {\n      const raw = { topbar_regex_active_one: "Regex active: {{name}}", topbar_regex_active_many: "Regex active: {{n}}" } as Record<string, string>;\n      let out = raw[key] ?? key;\n      for (const [k, v] of Object.entries(opts ?? {})) out = out.replaceAll(\`{{\${k}}}\`, String(v));\n      return out;\n    },\n    tDynamic: (key: string) => key,\n    locale: "en",\n    setLocale: NOOP,\n    ready: true,\n  }),\n}));\n`;
		const plan = classifyFile(file, src);
		expect(plan.classification).toBe("INTERPOLATED");
		const out = transformFile(src, plan);
		expect(out).toContain('installI18nContextSeam({ interpolateKeys: ["topbar_regex_active_one", "topbar_regex_active_many"] });');
		expect(out).toContain('from "../../../test/i18n-context-seam.js"');
	});

	test("findMockCallSpan cuts the whole balanced statement, not the arrow parens", () => {
		const span = findMockCallSpan(IDENTITY_SOURCE);
		expect(span).not.toBeNull();
		const block = IDENTITY_SOURCE.slice(span?.start ?? 0, span?.end ?? 0);
		expect(block.trimEnd().endsWith("}));")).toBe(true);
		expect(block).not.toContain("await import");
	});

	test("insertSeamImport falls back to the leading import run when dom-env is absent", () => {
		const src = `import { describe, expect, it } from "bun:test";\nimport React from "react";\n\nconst x = 1;\n`;
		const out = insertSeamImport(src, "apps/web/src/hooks/use-x.test.tsx");
		const lines = out.split("\n");
		expect(lines[2]).toContain('from "../../test/i18n-context-seam.js"');
	});
});

describe("i18n mock codemod custom extraction", () => {
	test("splitObjectEntries never splits on commas inside strings, template text or ${…} code", () => {
		const body = 't: (key, opts?) => {\n  if (key === "dice_meta_checks") return `${opts?.count} checks, total`;\n  return `Scene: ${opts?.n} field, done`;\n},\ntDynamic: (key) => key,\nlocale: "en",';
		const entries = splitObjectEntries(body);
		expect(entries).not.toBeNull();
		expect((entries as string[]).length).toBe(3);
		expect((entries as string[])[0]).toContain("dice_meta_checks");
		expect((entries as string[])[0]).toContain("field, done");
	});

	test("isPortableFunctionValue accepts inline arrows, rejects bare identifiers and objects", () => {
		expect(isPortableFunctionValue(" (key, opts?) => opts ? `${key}:${String(opts.n)}` : key")).toBe(true);
		expect(isPortableFunctionValue(" (key) => {\n  return key;\n}")).toBe(true);
		expect(isPortableFunctionValue(" k => k")).toBe(true);
		expect(isPortableFunctionValue(" stableT")).toBe(false);
		expect(isPortableFunctionValue(" ({ label: key })")).toBe(false);
	});

	test("stripParameterAnnotations drops annotations without touching Record commas", () => {
		expect(stripParameterAnnotations(" (key: string, opts?: Record<string, unknown>) => key")).toBe(" (key, opts?) => key");
		expect(stripParameterAnnotations(" (key: string, opts?: { count?: number }) => key")).toBe(" (key, opts?) => key");
		expect(stripParameterAnnotations(" (key: string, values?: Record<string, string | number>) => key")).toBe(" (key, values?) => key");
	});

	test("param-suffix, count-suffix and JSON.stringify semantics classify CUSTOM", () => {
		const customs = [
			'{ t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }',
			'{ t: (key: string, opts?: { count?: number }) => (typeof opts?.count === "number" ? `${key}#${opts.count}` : key), tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }',
		];
		for (const useT of customs) {
			expect(classifyFile(IDENTITY_FILE, withUseT(useT)).classification, useT).toBe("CUSTOM");
		}
	});

	test("multi-line switch tables and comment-led entries classify CUSTOM; missing tDynamic is allowed", () => {
		const switchTable = '{\n    t: (key: string, opts?: Record<string, unknown>) => {\n      const n = Number(opts?.n);\n      switch (key) {\n        case "character_tracker_template_scene": return `Scene: ${n} field${n === 1 ? "" : "s"}, done`;\n        default: return key;\n      }\n    },\n    locale: "en",\n    ready: true,\n  }';
		expect(classifyFile(IDENTITY_FILE, withUseT(switchTable)).classification).toBe("CUSTOM");
		const commentLed = '{\n    // Identity with the single count echoed.\n    t: (key: string, opts?: Record<string, unknown>) =>\n      opts !== undefined ? `${key}:${String(opts.n)}` : key,\n    setLocale: () => {},\n  }';
		expect(classifyFile(IDENTITY_FILE, withUseT(commentLed)).classification).toBe("CUSTOM");
	});

	test("named-reference t, mutable locale and missing spread classify OTHER (hand work)", () => {
		expect(classifyFile(IDENTITY_FILE, withUseT('{ t: stableT, tDynamic: stableTDynamic, locale: "en" }')).classification).toBe("OTHER");
		expect(classifyFile(IDENTITY_FILE, withUseT('{ t: (key) => key, locale: activeLocale ?? "en" }')).classification).toBe("OTHER");
		const noSpread = IDENTITY_SOURCE.replace("...realI18n,", "");
		expect(classifyFile(IDENTITY_FILE, noSpread).classification).toBe("OTHER");
	});

	test("CUSTOM transform emits the verbatim body with contextual parameter names", () => {
		const src = IDENTITY_SOURCE.replace(
			/useT: \(\) => \(\{[\s\S]*?\n  \}\),\n/,
			'useT: () => ({\n    t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key,\n    tDynamic: (key: string) => key,\n    locale: "en",\n    setLocale: () => {},\n    ready: true,\n  }),\n',
		);
		const plan = classifyFile(IDENTITY_FILE, src);
		expect(plan.classification).toBe("CUSTOM");
		const out = transformFile(src, plan) as string;
		expect(out).toContain("installI18nContextSeam({");
		expect(out).toContain("t: (key, opts?) => opts ? `${key}:${JSON.stringify(opts)}` : key,");
		expect(out).toContain("tDynamic: (key) => key,");
		expect(out).not.toContain("mock.module");
		expect(out).not.toContain("realI18n");
		expect(out.indexOf("installI18nContextSeam({")).toBeLessThan(out.indexOf('await import("./MyComponent.js")'));
	});

	test("extractCustomSpec returns null for unparsable shapes", () => {
		expect(extractCustomSpec('mock.module("x", () => ({ useT: () => ({ t: stableT }) }));')).toBeNull();
	});
});
