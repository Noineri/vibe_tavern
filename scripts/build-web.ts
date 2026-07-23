import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import rootPackage from "../package.json" with { type: "json" };
import { bunDataComponentPlugin } from "../apps/web/bun-plugin-data-component.js";

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "apps", "web");
const PUBLIC_DIR = join(WEB_DIR, "public");
const OUT_DIR = join(ROOT, "out", "apps", "web");
const tailwindPluginModule: { readonly default: BunPlugin } = await import(
	await Bun.resolve("bun-plugin-tailwind", WEB_DIR),
);
const tailwindPlugin = tailwindPluginModule.default;

const APP_VERSION = process.env.VERSION ?? rootPackage.version ?? "0.0.0-dev";
const UPDATE_API_BASE = (
	process.env.VT_UPDATE_API_BASE ??
	"https://api.github.com/repos/Noineri/vibe_tavern"
).replace(/\/+$/, "");

const PUBLIC_ASSET_PATHS = [
	"logo-256.png",
	"logo.ico",
	"fonts/Literata-VariableFont_opsz,wght.ttf",
	"fonts/Literata-Italic-VariableFont_opsz,wght.ttf",
	"fonts/JetBrainsMonoNLNerdFont-Regular.ttf",
	"fonts/JetBrainsMonoNLNerdFont-Bold.ttf",
	"fonts/Inter-VariableFont_opsz,wght.ttf",
	"fonts/Inter-Italic-VariableFont_opsz,wght.ttf",
	"fonts/Alegreya-VariableFont_wght.ttf",
	"fonts/Alegreya-Italic-VariableFont_wght.ttf",
] as const;

const ALIASES = new Map<string, string>([
	["@vibe-tavern/db/codecs", join(ROOT, "packages", "db", "src", "codecs.ts")],
	["@vibe-tavern/api", join(ROOT, "services", "api", "src", "index.ts")],
	["@vibe-tavern/db", join(ROOT, "packages", "db", "src", "index.ts")],
	["@vibe-tavern/domain", join(ROOT, "packages", "domain", "src", "index.ts")],
	[
		"@vibe-tavern/prompt-pipeline",
		join(ROOT, "packages", "prompt-pipeline", "src", "index.ts"),
	],
	[
		"@vibe-tavern/api-contracts",
		join(ROOT, "packages", "api-contracts", "src", "index.ts"),
	],
	[
		"@vibe-tavern/import-export",
		join(ROOT, "packages", "import-export", "src", "index.ts"),
	],
]);

const webBuildPlugin: BunPlugin = {
	name: "vibe-tavern-web-build",
	setup(builder) {
		tailwindPlugin.setup(builder);

		builder.onResolve({ filter: /^@vibe-tavern\// }, (args) => {
			const path = ALIASES.get(args.path);
			return path ? { path } : undefined;
		});

		builder.onResolve({ filter: /^\/[^/]/ }, (args) => {
			const path = join(PUBLIC_DIR, args.path.slice(1));
			return existsSync(path) ? { path } : undefined;
		});

		builder.onResolve({ filter: /\?raw$/ }, (args) => ({
			path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, "")),
			namespace: "raw-string",
		}));

		builder.onLoad({ filter: /.*/, namespace: "raw-string" }, async (args) => ({
			contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
			loader: "js",
		}));

		builder.onLoad({ filter: /index\.html$/ }, async (args) => ({
			contents: (await Bun.file(args.path).text())
				.replace(/src="\/src\//g, 'src="./src/')
				.replace(/href="\/(logo[^"]*)"/g, 'href="./public/$1"'),
			loader: "html",
		}));
	},
};

async function main(): Promise<void> {
	console.log("📦 Building frontend with Bun.build...\n");

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	// bunDataComponentPlugin reads NODE_ENV while registering its hooks. Set it
	// before Bun.build so its production path does not register a JSX transform.
	process.env.NODE_ENV = "production";
	const result = await Bun.build({
		entrypoints: [join(WEB_DIR, "index.html")],
		outdir: OUT_DIR,
		target: "browser",
		tsconfig: join(WEB_DIR, "tsconfig.json"),
		minify: true,
		sourcemap: "external",
		splitting: true,
		naming: {
			chunk: "assets/index-[hash].[ext]",
			asset: "assets/[name]-[hash].[ext]",
		},
		define: {
			__APP_VERSION__: JSON.stringify(APP_VERSION),
			__UPDATE_API_BASE__: JSON.stringify(UPDATE_API_BASE),
			"process.env.NODE_ENV": JSON.stringify("production"),
			"process.env.RP_WEB_API_URL": JSON.stringify(process.env.RP_WEB_API_URL ?? ""),
			"process.env.RP_WEB_DEFAULT_PROVIDER_LABEL": JSON.stringify(
				process.env.RP_WEB_DEFAULT_PROVIDER_LABEL ?? "",
			),
			"process.env.RP_WEB_DEFAULT_BASE_URL": JSON.stringify(
				process.env.RP_WEB_DEFAULT_BASE_URL ?? "",
			),
			"process.env.RP_WEB_DEFAULT_MODEL": JSON.stringify(
				process.env.RP_WEB_DEFAULT_MODEL ?? "",
			),
			"process.env.RP_WEB_FORCE_FIRST_RUN": JSON.stringify(
				process.env.RP_WEB_FORCE_FIRST_RUN ?? "",
			),
		},
		plugins: [bunDataComponentPlugin(), webBuildPlugin],
		throw: false,
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log);
		}
		process.exitCode = 1;
		return;
	}

	const generatedPublicAssets = result.outputs.flatMap((output) => {
		const source = PUBLIC_ASSET_PATHS.find((asset) => {
			const extension = extname(asset);
			return (
				output.path.endsWith(extension) &&
				basename(output.path).startsWith(`${basename(asset, extension)}-`)
			);
		});
		return source ? [{ source, path: output.path }] : [];
	});

	for (const output of result.outputs) {
		if (!output.path.endsWith(".html") && !output.path.endsWith(".css")) continue;

		let contents = await Bun.file(output.path).text();
		for (const asset of generatedPublicAssets) {
			const generatedName = basename(asset.path);
			const escapedGeneratedName = generatedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const generatedPath = new RegExp(
				`(?:\\.?\\/{0,3}assets\\/|\\.?\\/{0,3})${escapedGeneratedName}`,
				"g",
			);
			contents = contents.replace(generatedPath, `/${asset.source}`);
		}
		await Bun.write(output.path, contents);
	}

	await Promise.all(generatedPublicAssets.map((asset) => rm(asset.path)));
	await cp(PUBLIC_DIR, OUT_DIR, { recursive: true });

	const generatedPublicAssetPaths = new Set(
		generatedPublicAssets.map((asset) => asset.path),
	);
	for (const output of result.outputs) {
		if (generatedPublicAssetPaths.has(output.path)) continue;
		console.log(`  ✅ ${relative(ROOT, output.path)}`);
	}
	console.log("\n✅ Frontend built to out/apps/web/");
}

await main();
