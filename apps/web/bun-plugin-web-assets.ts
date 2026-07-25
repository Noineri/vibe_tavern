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

// Bun's HTML bundler resolves <link href>/<script src> BEFORE our onResolve hook
// runs. A leading-slash path like "/logo-256.png" is absolutized against the
// process cwd: on POSIX it still reaches onResolve (marked external, kept
// verbatim), but on Windows it becomes a drive-rooted path that misses the
// /^\// filter, so default resolution runs and the build fails with
// `Could not resolve: "/logo-256.png"`. Relativizing the hrefs sidesteps the
// race entirely — Bun resolves them from apps/web/ and bundles+hashes the icons
// natively on every platform. The <script src="/src/…"> rewrite is required for
// the same reason (the emitted bundle path is relative).
export function rewriteIndexHtml(html: string): string {
	return html
		.replace(/src="\/src\//g, 'src="./src/')
		.replace(/(href|src)="\/(logo[^"]*|favicon[^"]*)"/g, '$1="./public/$2"');
}

export function webAssetsPlugin(): BunPlugin {
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
				contents: rewriteIndexHtml(await Bun.file(args.path).text()),
				loader: "html",
			}));
		},
	};
}

export default webAssetsPlugin();
