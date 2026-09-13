import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webAssetsPlugin } from "../apps/web/bun-plugin-web-assets.js";

/**
 * Text imports (`with { type: "text" }`) are load-bearing in two places and
 * were previously untested:
 *
 *  - `script-templates/index.ts` ships nine editable `.js` template files
 *    whose source is handed to the script sandbox verbatim.
 *  - `ThemeTuner` imports theme CSS as text so `color-math` can do surgical,
 *    comment-preserving replacements on export - a loader that stripped
 *    comments or normalized whitespace would silently break the export path.
 *
 * Both need the file to arrive BYTE-EXACT, which is what these pins assert:
 * the real production build shape (browser target, minified) against the bytes
 * on disk. The build runs with the web assets plugin loaded, as
 * `scripts/build-web.ts` does, so a plugin that starts claiming these files
 * (the removed `?raw` loader did) is covered too.
 */

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "apps", "web");
const TEMPLATES_DIR = join(WEB_DIR, "src", "components", "build", "editors", "script-templates");
const THEMES_DIR = join(WEB_DIR, "src", "themes");

/** Build one entrypoint the way `build-web.ts` builds the app, and load it. */
async function buildAndLoad(entrypoint: string): Promise<Record<string, unknown>> {
	const built = await Bun.build({
		entrypoints: [entrypoint],
		target: "browser",
		tsconfig: join(WEB_DIR, "tsconfig.json"),
		minify: true,
		plugins: [webAssetsPlugin()],
		throw: false,
	});
	expect(built.logs.filter((log) => log.level === "error")).toEqual([]);
	expect(built.success).toBe(true);

	const dir = await mkdtemp(join(tmpdir(), "vt-text-imports-"));
	const outFile = join(dir, "bundle.js");
	await Bun.write(outFile, await built.outputs[0].text());
	try {
		// Dynamic by necessity: the specifier is a freshly built temp file.
		return await import(outFile);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("every script template reaches the registry as the exact bytes on disk", async () => {
	const mod = await buildAndLoad(join(TEMPLATES_DIR, "index.ts"));
	const templates = mod.SCRIPT_TEMPLATES as Record<string, { name: string; code: string }>;

	// Guard: the registry must actually carry the nine shipped templates, or the
	// byte comparison below would pass vacuously on an empty object.
	const keys = Object.keys(templates);
	expect(keys.length).toBe(9);

	for (const [key, template] of Object.entries(templates)) {
		const file = join(TEMPLATES_DIR, `${key.replaceAll("_", "-")}.js`);
		expect(template.code).toBe(await Bun.file(file).text());
		// The sandbox executes this source as-is: a minifier or a loader that
		// touched it would break user-visible template code.
		expect(template.code.length).toBeGreaterThan(200);
	}
});

test("theme CSS arrives with comments and formatting intact (color-math parses the source)", async () => {
	const themes = [
		"coffee",
		"milk-coffee",
		"mystic-dawn",
		"mystic-night",
		"light-lava",
		"dark-lava",
	];
	const dir = await mkdtemp(join(tmpdir(), "vt-theme-text-"));
	const entry = join(dir, "themes-entry.ts");
	const imports = themes
		.map((id, i) => `import css${i} from ${JSON.stringify(join(THEMES_DIR, `${id}.css`))} with { type: "text" };`)
		.join("\n");
	const exports = themes.map((id, i) => `\t${JSON.stringify(id)}: css${i},`).join("\n");
	await Bun.write(entry, `${imports}\nexport const CSS = {\n${exports}\n};\n`);

	try {
		const mod = await buildAndLoad(entry);
		const css = mod.CSS as Record<string, string>;
		for (const id of themes) {
			const onDisk = await Bun.file(join(THEMES_DIR, `${id}.css`)).text();
			expect(css[id]).toBe(onDisk);
			// color-math's surgical export rewrites the declaration it finds in
			// this source and leaves the comments around it alone - both must
			// survive the build.
			expect(css[id]).toContain("/*");
			expect(css[id]).toMatch(/--[a-z-]+:/);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
