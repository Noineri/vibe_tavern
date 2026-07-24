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
				contents: (await Bun.file(args.path).text()).replace(
					/src="\/src\//g,
					'src="./src/',
				),
				loader: "html",
			}));
		},
	};
}

export default webAssetsPlugin();
