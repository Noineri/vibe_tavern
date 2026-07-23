/**
 * Bun bundler plugin for the Vibe Tavern dev server.
 *
 * Referenced from the root bunfig.toml [serve.static] section. Loaded lazily
 * by Bun's HTML-import dev server when routes are bundled.
 *
 * This single plugin integrates bun-plugin-tailwind (for Tailwind 4 CSS
 * compilation) alongside four custom concerns:
 *
 *   1. Root-relative asset resolution — maps Vite-style root-relative paths
 *      (/fonts/..., /logo-256.png) in CSS url() and other references to the
 *      public/ directory.
 *   2. Vite ?raw import support — Bun doesn't natively support the ?raw suffix
 *      that Vite uses to import file contents as a string.
 *   3. HTML path rewriting — rewrites root-relative paths in index.html
 *      (/src/main.tsx → ./src/main.tsx) so Bun's bundler resolves them.
 *   4. Source transforms — define injection (__APP_VERSION__, __UPDATE_API_BASE__),
 *      import.meta.env shim, and data-component attribute injection (dev only).
 *
 * bun-plugin-tailwind's setup is called first so its CSS handlers take
 * precedence; our handlers run only when Tailwind returns undefined.
 */

import type { BunPlugin } from "bun";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPlugin from "bun-plugin-tailwind";
import { transformDataComponent } from "./bun-plugin-data-component";

// ─── Paths ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = __dirname;
const REPO_ROOT = path.resolve(WEB_DIR, "..", "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");

// ─── Version defines (mirrors vite.config.ts) ────────────────────────────────

const rootPkg = JSON.parse(
	readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { version?: string };
const APP_VERSION = process.env.VERSION ?? rootPkg.version ?? "0.0.0-dev";
const UPDATE_API_BASE = (
	process.env.VT_UPDATE_API_BASE ??
	"https://api.github.com/repos/Noineri/vibe_tavern"
).replace(/\/+$/, "");

// ─── Vite import.meta.env shim ──────────────────────────────────────────────
//
// Vite provides import.meta.env with MODE/DEV/PROD/BASE_URL and all VITE_*
// env vars. Bun doesn't have this. We inject a compatible object via define.

const viteEnvEntries: Record<string, string | boolean> = {
	MODE: "development",
	DEV: true,
	PROD: false,
	BASE_URL: "/",
};
for (const [key, value] of Object.entries(process.env)) {
	if (key.startsWith("VITE_") && value !== undefined) {
		viteEnvEntries[key] = value;
	}
}
const VITE_ENV_JSON = JSON.stringify(viteEnvEntries);

// ─── Combined plugin ─────────────────────────────────────────────────────────

const vtDevPlugin: BunPlugin = {
	name: "vt-dev-server",
	setup(builder) {
		// ── Tailwind CSS (via bun-plugin-tailwind) ─────────────────────────
		//
		// Registered first so its onLoad for .css files takes precedence.
		// Our handlers below only run when Tailwind returns undefined.
		tailwindPlugin.setup(builder);

		// ── Root-relative asset resolution (CSS url(), etc.) ───────────────
		//
		// CSS url('/fonts/...') and similar root-relative paths can't be resolved
		// by Bun's bundler. We map them to the public/ directory.
		builder.onResolve({ filter: /^\/[^/]/ }, (args) => {
			const publicPath = path.join(PUBLIC_DIR, args.path.slice(1));
			if (existsSync(publicPath)) return { path: publicPath };
			return undefined;
		});

		// ── Vite ?raw import support ───────────────────────────────────────
		//
		// Vite supports importing file contents as a string via the ?raw suffix:
		//   import coffeeRaw from "../../themes/coffee.css?raw";
		// Bun doesn't support this natively. We intercept the resolution, strip
		// the ?raw suffix, resolve the actual file, and return its content as
		// a default string export.
		builder.onResolve({ filter: /\?raw$/ }, (args) => {
			const cleanPath = args.path.replace(/\?raw$/, "");
			const resolved = path.resolve(path.dirname(args.importer), cleanPath);
			return { path: resolved, namespace: "raw-string" };
		});
		builder.onLoad({ filter: /.*/, namespace: "raw-string" }, async (args) => {
			const content = await Bun.file(args.path).text();
			return {
				contents: `export default ${JSON.stringify(content)};`,
				loader: "js",
			};
		});

		// ── HTML path rewriting ─────────────────────────────────────────────
		//
		// Vite uses root-relative paths in index.html:
		//   <script src="/src/main.tsx">
		//   <link href="/logo-256.png" />
		//   <link href="/logo.ico" />
		//
		// Bun's HTML-import system pre-resolves root-relative paths relative to
		// the project root before onResolve runs, producing wrong filesystem paths.
		// We intercept the HTML file and rewrite root-relative URLs to relative
		// paths so the bundler resolves them from the HTML file's directory.
		builder.onLoad({ filter: /index\.html$/ }, async (args) => {
			const html = await Bun.file(args.path).text();
			const rewritten = html
				.replace(/src="\/src\//g, 'src="./src/')
				.replace(/href="\/(logo[^"]*)"/g, 'href="./public/$1"');
			return { contents: rewritten, loader: "html" };
		});

		// ── Source transforms: defines + data-component ─────────────────────
		//
		// The data-component transform calls transformDataComponent() from task
		// 5.1's bun-plugin-data-component.ts. Define injection and data-component
		// run in the same onLoad pass so files with BOTH (e.g. AppShell.tsx) get
		// both transforms.
		builder.onLoad({ filter: /\.[tj]sx?$/ }, async (args) => {
			if (args.path.includes("node_modules")) return undefined;

			let code = await Bun.file(args.path).text();
			let modified = false;

			// 1. data-component attribute injection (dev only)
			if (process.env.NODE_ENV !== "production") {
				const dcResult = transformDataComponent(code, args.path, true);
				if (dcResult !== null) {
					code = dcResult;
					modified = true;
				}
			}

			// 2. Define injection (__APP_VERSION__, __UPDATE_API_BASE__)
			if (
				code.includes("__APP_VERSION__") ||
				code.includes("__UPDATE_API_BASE__")
			) {
				code = code
					.replace(/__APP_VERSION__/g, JSON.stringify(APP_VERSION))
					.replace(/__UPDATE_API_BASE__/g, JSON.stringify(UPDATE_API_BASE));
				modified = true;
			}

			// 3. Vite import.meta.env shim
			if (code.includes("import.meta.env")) {
				code = code.replace(/import\.meta\.env/g, `(${VITE_ENV_JSON})`);
				modified = true;
			}

			if (!modified) return undefined;
			return { contents: code, loader: args.loader };
		});
	},
};

export default vtDevPlugin;
