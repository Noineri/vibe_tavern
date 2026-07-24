import { join } from "node:path";
import type { BunPlugin } from "bun";
import rootPackage from "../../package.json" with { type: "json" };

const BUILD_CONFIG_PATH = join(import.meta.dir, "src", "build-config.ts");

export type WebBuildConfig = {
	readonly appVersion: string;
	readonly updateApiBase: string;
	readonly mode: "development" | "production";
	readonly apiUrl: string;
	readonly defaultProviderLabel: string;
	readonly defaultBaseUrl: string;
	readonly defaultModel: string;
	readonly forceFirstRun: boolean;
};

function moduleSource(config: WebBuildConfig): string {
	return [
		`export const APP_VERSION = ${JSON.stringify(config.appVersion)};`,
		`export const UPDATE_API_BASE = ${JSON.stringify(config.updateApiBase)};`,
		`export const isDev = ${config.mode === "development"};`,
		`export const isProd = ${config.mode === "production"};`,
		`export const API_URL = ${config.apiUrl === "" ? "null" : JSON.stringify(config.apiUrl)};`,
		`export const DEFAULT_PROVIDER_LABEL = ${JSON.stringify(config.defaultProviderLabel || "OpenAI-compatible")};`,
		`export const DEFAULT_BASE_URL = ${JSON.stringify(config.defaultBaseUrl)};`,
		`export const DEFAULT_MODEL = ${JSON.stringify(config.defaultModel)};`,
		`export const FORCE_FIRST_RUN = ${config.forceFirstRun};`,
	].join("\n");
}

export function buildConfigPlugin(config: WebBuildConfig): BunPlugin {
	return {
		name: "vibe-tavern-build-config",
		setup(builder) {
			builder.onLoad({ filter: /build-config\.ts$/ }, (args) =>
				args.path === BUILD_CONFIG_PATH
					? { contents: moduleSource(config), loader: "ts" }
					: undefined,
			);
		},
	};
}

const updateApiBase = (
	process.env.VT_UPDATE_API_BASE ??
	"https://api.github.com/repos/Noineri/vibe_tavern"
).replace(/\/+$/, "");

export default buildConfigPlugin({
	appVersion: process.env.VERSION ?? rootPackage.version ?? "0.0.0-dev",
	updateApiBase,
	mode: "development",
	apiUrl: process.env.RP_WEB_API_URL ?? "",
	defaultProviderLabel: process.env.RP_WEB_DEFAULT_PROVIDER_LABEL ?? "",
	defaultBaseUrl: process.env.RP_WEB_DEFAULT_BASE_URL ?? "",
	defaultModel: process.env.RP_WEB_DEFAULT_MODEL ?? "",
	forceFirstRun: process.env.RP_WEB_FORCE_FIRST_RUN === "true",
});
