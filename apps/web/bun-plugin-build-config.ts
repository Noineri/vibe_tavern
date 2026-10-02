import { join } from "node:path";
import type { BunPlugin } from "bun";
import rootPackage from "../../package.json" with { type: "json" };

const BUILD_CONFIG_PATH = join(import.meta.dir, "src", "build-config.ts");

const ENV_REFERENCE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;

export type WebBuildMode = "development" | "production";

/**
 * Environment the browser build of `src/build-config.ts` is compiled against,
 * keyed by the `process.env` names that module reads.
 */
export type WebBuildEnv = Readonly<Record<string, string>>;

/**
 * Replaces every `process.env.X` read in `build-config.ts` with its build-time
 * value. Browser bundles have no `process`, so a read that survives is not a
 * missing value but a `ReferenceError` on the first module evaluation — hence
 * the hard failure on an undeclared key instead of an empty string.
 */
export function inlineWebBuildEnv(source: string, env: WebBuildEnv): string {
	return source.replace(ENV_REFERENCE, (_match, key: string) => {
		const value = env[key];
		if (value === undefined) {
			throw new Error(
				`apps/web/src/build-config.ts reads process.env.${key}, which the web build does not define. ` +
					"An un-inlined read is a ReferenceError in the browser: add the key to resolveWebBuildEnv().",
			);
		}
		return JSON.stringify(value);
	});
}

/**
 * Reads the build-time environment. Called in the build process, so values
 * exported after startup are picked up — unlike Bun's own `env:` inlining,
 * which reads the environment snapshot taken when the process started and
 * leaves unset variables in the bundle as live `process.env` reads.
 */
export function resolveWebBuildEnv(mode: WebBuildMode): WebBuildEnv {
	return {
		VIBE_TAVERN_WEB_APP_VERSION: process.env.VERSION ?? rootPackage.version,
		VIBE_TAVERN_WEB_UPDATE_API_BASE: process.env.VT_UPDATE_API_BASE ?? "",
		VIBE_TAVERN_WEB_MODE: mode,
		VIBE_TAVERN_WEB_API_URL: process.env.VIBE_TAVERN_WEB_API_URL ?? "",
		VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL:
			process.env.VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL ?? "",
		VIBE_TAVERN_WEB_DEFAULT_BASE_URL: process.env.VIBE_TAVERN_WEB_DEFAULT_BASE_URL ?? "",
		VIBE_TAVERN_WEB_DEFAULT_MODEL: process.env.VIBE_TAVERN_WEB_DEFAULT_MODEL ?? "",
		VIBE_TAVERN_WEB_FORCE_FIRST_RUN: process.env.VIBE_TAVERN_WEB_FORCE_FIRST_RUN ?? "",
	};
}

export function buildConfigPlugin(env: WebBuildEnv): BunPlugin {
	return {
		name: "vibe-tavern-build-config",
		setup(builder) {
			builder.onLoad({ filter: /build-config\.ts$/ }, async (args) =>
				args.path === BUILD_CONFIG_PATH
					? {
							contents: inlineWebBuildEnv(await Bun.file(args.path).text(), env),
							loader: "ts",
						}
					: undefined,
			);
		},
	};
}

export default buildConfigPlugin(resolveWebBuildEnv("development"));
