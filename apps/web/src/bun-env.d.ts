declare namespace NodeJS {
	interface ProcessEnv {
		readonly VIBE_TAVERN_WEB_APP_VERSION?: string;
		readonly VIBE_TAVERN_WEB_DEV_PORT?: string;
		readonly VIBE_TAVERN_WEB_UPDATE_API_BASE?: string;
		readonly VIBE_TAVERN_WEB_MODE?: "development" | "production";
	}
}

// Text imports (`import css from "./x.css" with { type: "text" }`) are typed as
// string by bun-types' attribute-conditioned ambient modules, which TypeScript
// only resolves from 7.1 on - see the `typescript` pin in the root package.json.
// An attributed import wins over the shorthand below (verified: the theme CSS
// ThemeTuner imports types as `string`, not `any`).

// Side-effect stylesheet imports (`import "./styles.css"` in main.tsx): the
// bundler turns them into a <link>, there is nothing to type.
declare module "*.css";
