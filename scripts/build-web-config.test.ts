import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import type { WebBuildEnv } from "../apps/web/bun-plugin-build-config.js";
import {
	buildConfigPlugin,
	inlineWebBuildEnv,
	resolveWebBuildEnv,
} from "../apps/web/bun-plugin-build-config.js";
import rootPackage from "../package.json" with { type: "json" };

const BUILD_CONFIG_MODULE = join(
	import.meta.dir,
	"..",
	"apps",
	"web",
	"src",
	"build-config.ts",
);

const DEFAULT_UPDATE_API_BASE = "https://api.github.com/repos/Noineri/vibe_tavern";

const EMPTY_ENV: WebBuildEnv = {
	VIBE_TAVERN_WEB_APP_VERSION: "",
	VIBE_TAVERN_WEB_UPDATE_API_BASE: "",
	VIBE_TAVERN_WEB_MODE: "",
	VIBE_TAVERN_WEB_API_URL: "",
	VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "",
	VIBE_TAVERN_WEB_DEFAULT_BASE_URL: "",
	VIBE_TAVERN_WEB_DEFAULT_MODEL: "",
	VIBE_TAVERN_WEB_FORCE_FIRST_RUN: "",
};

const tempDirs: string[] = [];
const restoreEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
	if (!restoreEnv.has(key)) restoreEnv.set(key, process.env[key]);
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	// process.env rejects any descriptor that is not a configurable, writable
	// AND enumerable data descriptor (ERR_INVALID_OBJECT_DEFINE_PROPERTY).
	Object.defineProperty(process.env, key, {
		configurable: true,
		enumerable: true,
		writable: true,
		value,
	});
}

type BuiltConfigModule = {
	readonly APP_VERSION: string;
	readonly UPDATE_API_BASE: string;
	readonly isDev: boolean;
	readonly isProd: boolean;
	readonly API_URL: string | null;
	readonly DEFAULT_PROVIDER_LABEL: string;
	readonly DEFAULT_BASE_URL: string;
	readonly DEFAULT_MODEL: string;
	readonly FORCE_FIRST_RUN: boolean;
};

type BuiltConfig = BuiltConfigModule & { readonly code: string };

/**
 * Bundles the real `build-config.ts` the way the app does, then evaluates the
 * artifact. `apps/web/src/build-config.test.ts` covers the module as Bun
 * executes it; this covers what the browser actually receives, which is a
 * different program: every `process.env` read is resolved at build time and the
 * browser has no `process` to fall back on.
 */
async function buildConfigModule(plugin: BunPlugin, minify: boolean): Promise<BuiltConfig> {
	const dir = await mkdtemp(join(tmpdir(), "vt-build-config-"));
	tempDirs.push(dir);
	const entry = join(dir, "entry.ts");
	await Bun.write(entry, `export * from ${JSON.stringify(BUILD_CONFIG_MODULE)};\n`);

	const result = await Bun.build({
		entrypoints: [entry],
		outdir: join(dir, "out"),
		target: "browser",
		minify,
		plugins: [plugin],
		throw: true,
	});
	const artifact = result.outputs[0];
	if (artifact === undefined) throw new Error("build produced no artifact");

	const built: BuiltConfigModule = await import(artifact.path);
	return { code: await artifact.text(), ...built };
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
	for (const [key, value] of restoreEnv) setEnv(key, value);
	restoreEnv.clear();
});

describe("web build config injection", () => {
	test("falls back to the module defaults when nothing is configured", async () => {
		// Given
		const plugin = buildConfigPlugin({ ...EMPTY_ENV, VIBE_TAVERN_WEB_MODE: "production" });

		// When
		const config = await buildConfigModule(plugin, true);

		// Then
		expect(config.APP_VERSION).toBe("0.0.0-dev");
		expect(config.UPDATE_API_BASE).toBe(DEFAULT_UPDATE_API_BASE);
		expect(config.isProd).toBe(true);
		expect(config.isDev).toBe(false);
		expect(config.API_URL).toBeNull();
		expect(config.DEFAULT_PROVIDER_LABEL).toBe("OpenAI-compatible");
		expect(config.DEFAULT_BASE_URL).toBe("");
		expect(config.DEFAULT_MODEL).toBe("");
		expect(config.FORCE_FIRST_RUN).toBe(false);
	});

	test("leaves no process.env read in the bundle", async () => {
		// Given — an un-inlined `process.env.X` is not a missing value but a
		// `ReferenceError: process is not defined` on first module evaluation:
		// the browser bundle carries no process shim (verified against a real
		// page; Bun documents the same failure for its own `env:` inlining).
		const plugin = buildConfigPlugin({
			...EMPTY_ENV,
			VIBE_TAVERN_WEB_APP_VERSION: "1.2.3",
			VIBE_TAVERN_WEB_MODE: "production",
		});

		// When
		const minified = await buildConfigModule(plugin, true);
		const readable = await buildConfigModule(plugin, false);

		// Then
		expect(minified.code).not.toInclude("process.env");
		expect(readable.code).not.toInclude("process.env");
		expect(minified.APP_VERSION).toBe("1.2.3");
		expect(readable.APP_VERSION).toBe("1.2.3");
	});

	test("carries development mode and configured values through the bundle", async () => {
		// Given
		const plugin = buildConfigPlugin({
			VIBE_TAVERN_WEB_APP_VERSION: "9.8.7",
			VIBE_TAVERN_WEB_UPDATE_API_BASE: "https://updates.example.test/",
			VIBE_TAVERN_WEB_MODE: "development",
			VIBE_TAVERN_WEB_API_URL: "https://api.example.test",
			VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "Local provider",
			VIBE_TAVERN_WEB_DEFAULT_BASE_URL: "https://models.example.test/v1",
			VIBE_TAVERN_WEB_DEFAULT_MODEL: "example-model",
			VIBE_TAVERN_WEB_FORCE_FIRST_RUN: "true",
		});

		// When
		const config = await buildConfigModule(plugin, false);

		// Then
		expect(config.isDev).toBe(true);
		expect(config.isProd).toBe(false);
		expect(config.APP_VERSION).toBe("9.8.7");
		expect(config.UPDATE_API_BASE).toBe("https://updates.example.test");
		expect(config.API_URL).toBe("https://api.example.test");
		expect(config.DEFAULT_PROVIDER_LABEL).toBe("Local provider");
		expect(config.DEFAULT_BASE_URL).toBe("https://models.example.test/v1");
		expect(config.DEFAULT_MODEL).toBe("example-model");
		expect(config.FORCE_FIRST_RUN).toBe(true);
	});

	test("forces first run only for the literal true value", async () => {
		// Given
		const plugin = buildConfigPlugin({
			...EMPTY_ENV,
			VIBE_TAVERN_WEB_FORCE_FIRST_RUN: "TRUE",
		});

		// When
		const config = await buildConfigModule(plugin, true);

		// Then
		expect(config.FORCE_FIRST_RUN).toBe(false);
	});
});

describe("inlineWebBuildEnv", () => {
	test("rejects a read the build does not define", () => {
		// Given — a new read added to build-config.ts without a matching entry
		// in resolveWebBuildEnv() would otherwise reach the browser verbatim.
		const source = 'export const X = process.env.VIBE_TAVERN_WEB_NEW_FLAG || "";';

		// When / Then
		expect(() => inlineWebBuildEnv(source, EMPTY_ENV)).toThrow(
			"process.env.VIBE_TAVERN_WEB_NEW_FLAG",
		);
	});

	test("escapes injected values instead of pasting them as code", () => {
		// Given
		const source = "export const LABEL = process.env.VIBE_TAVERN_WEB_DEFAULT_MODEL;";

		// When
		const inlined = inlineWebBuildEnv(source, {
			...EMPTY_ENV,
			VIBE_TAVERN_WEB_DEFAULT_MODEL: 'a"b\n\\c',
		});

		// Then
		expect(inlined).toBe('export const LABEL = "a\\"b\\n\\\\c";');
	});
});

describe("resolveWebBuildEnv", () => {
	test("reads the environment at call time, not at process startup", () => {
		// Given — Bun's own `env:` inlining reads a snapshot taken before user
		// code runs, so a value a build script exports never lands in the
		// bundle. This resolver must see it. Release builds depend on the same
		// property for VERSION, which overrides the package.json version.
		setEnv("VIBE_TAVERN_WEB_DEFAULT_MODEL", "set-after-startup");
		setEnv("VERSION", "4.5.6-release");

		// When
		const overridden = resolveWebBuildEnv("production");
		setEnv("VERSION", undefined);
		const fromPackage = resolveWebBuildEnv("development");

		// Then
		expect(overridden.VIBE_TAVERN_WEB_DEFAULT_MODEL).toBe("set-after-startup");
		expect(overridden.VIBE_TAVERN_WEB_MODE).toBe("production");
		expect(overridden.VIBE_TAVERN_WEB_APP_VERSION).toBe("4.5.6-release");
		expect(fromPackage.VIBE_TAVERN_WEB_MODE).toBe("development");
		expect(fromPackage.VIBE_TAVERN_WEB_APP_VERSION).toBe(rootPackage.version);
	});
});
