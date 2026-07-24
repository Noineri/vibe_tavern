declare namespace NodeJS {
	interface ProcessEnv {
		readonly RP_WEB_APP_VERSION?: string;
		readonly RP_WEB_DEV_PORT?: string;
		readonly RP_WEB_UPDATE_API_BASE?: string;
		readonly RP_WEB_MODE?: "development" | "production";
	}
}
