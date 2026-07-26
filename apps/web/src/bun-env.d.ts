declare namespace NodeJS {
	interface ProcessEnv {
		readonly RP_WEB_APP_VERSION?: string;
		readonly RP_WEB_DEV_PORT?: string;
		readonly RP_WEB_UPDATE_API_BASE?: string;
		readonly RP_WEB_MODE?: "development" | "production";
	}
}

// `?raw` suffix imports the file content as a plain string at build time
// (handled by the raw-string loader in apps/web/bun-plugin-web-assets.ts).
declare module "*?raw" {
	const content: string;
	export default content;
}

declare module "*.css";
