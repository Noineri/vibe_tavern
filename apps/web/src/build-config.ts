export const APP_VERSION: string = __APP_VERSION__;
export const UPDATE_API_BASE: string = __UPDATE_API_BASE__;

export const isDev: boolean = process.env.NODE_ENV === "development";
export const isProd: boolean = process.env.NODE_ENV === "production";

export const API_URL: string | null = process.env.RP_WEB_API_URL || null;
export const DEFAULT_PROVIDER_LABEL: string =
	process.env.RP_WEB_DEFAULT_PROVIDER_LABEL || "OpenAI-compatible";
export const DEFAULT_BASE_URL: string = process.env.RP_WEB_DEFAULT_BASE_URL || "";
export const DEFAULT_MODEL: string = process.env.RP_WEB_DEFAULT_MODEL || "";
export const FORCE_FIRST_RUN: boolean = process.env.RP_WEB_FORCE_FIRST_RUN === "true";
