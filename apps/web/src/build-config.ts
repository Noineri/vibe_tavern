export const APP_VERSION: string =
	process.env.RP_WEB_APP_VERSION || "0.0.0-dev";
export const UPDATE_API_BASE: string = (
	process.env.RP_WEB_UPDATE_API_BASE ||
	"https://api.github.com/repos/Noineri/vibe_tavern"
).replace(/\/+$/, "");

export const isDev: boolean = process.env.RP_WEB_MODE === "development";
export const isProd: boolean = process.env.RP_WEB_MODE === "production";

export const API_URL: string | null = process.env.RP_WEB_API_URL || null;
export const DEFAULT_PROVIDER_LABEL: string =
	process.env.RP_WEB_DEFAULT_PROVIDER_LABEL || "OpenAI-compatible";
export const DEFAULT_BASE_URL: string = process.env.RP_WEB_DEFAULT_BASE_URL || "";
export const DEFAULT_MODEL: string = process.env.RP_WEB_DEFAULT_MODEL || "";
export const FORCE_FIRST_RUN: boolean = process.env.RP_WEB_FORCE_FIRST_RUN === "true";
