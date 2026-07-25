import { dirname, join, relative, resolve, sep } from "node:path";
import type { BunPlugin, OnResolveArgs } from "bun";

const WEB_DIR = import.meta.dir;
const PROJECT_DIR = resolve(WEB_DIR, "..", "..");
const PUBLIC_DIR = join(WEB_DIR, "public");

function browserPath(path: string): string {
	return `/${path.split(sep).join("/")}`;
}

async function resolvePublicAsset(args: OnResolveArgs): Promise<string | null> {
	if (args.importer === "") return null;

	const relativePath = args.path.startsWith(WEB_DIR)
		? relative(WEB_DIR, args.path)
		: args.path.startsWith(PROJECT_DIR)
			? relative(PROJECT_DIR, args.path)
		: args.path.replace(/^\/+/, "");
	if (relativePath.startsWith("..")) return null;

	return (await Bun.file(join(PUBLIC_DIR, relativePath)).exists())
		? browserPath(relativePath)
		: null;
}

type PluginMode = "build" | "dev";

// In "dev" the Bun.serve HTML bundler resolves <link href>/<script src> itself
// before onResolve runs, absolutizing a leading-slash public path against the
// process cwd (repo root) and failing the build. rewriteIndexHtml turns those
// paths relative so the bundler resolves them from apps/web/public/ instead.
// The <script src="/src/…"> rewrite is needed in BOTH modes (Bun.build emits a
// relative bundle path); the public-asset rewrite is dev-only, because in
// "build" mode onResolve fires first and its { external: true } result keeps the
// original "/logo-256.png" href — matching the Vite baseline exactly.
function rewriteIndexHtml(html: string, mode: PluginMode): string {
	const withScript = html.replace(/src="\/src\//g, 'src="./src/');
	if (mode === "build") return withScript;
	return withScript.replace(
		/(href|src)="\/(logo[^"]*|favicon[^"]*)"/g,
		'$1="./public/$2"',
	);
}

export function webAssetsPlugin(mode: PluginMode = "build"): BunPlugin {
	return {
		name: "vibe-tavern-web-assets",
		setup(builder) {
			builder.onResolve({ filter: /^\// }, async (args) => {
				const path = await resolvePublicAsset(args);
				return path === null ? undefined : { path, external: true };
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
				contents: rewriteIndexHtml(await Bun.file(args.path).text(), mode),
				loader: "html",
			}));
		},
	};
}

export default webAssetsPlugin("dev");
