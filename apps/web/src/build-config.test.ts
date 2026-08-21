import { afterEach, describe, expect, test } from "bun:test";

const WEB_ENV_KEYS = [
	"VIBE_TAVERN_WEB_APP_VERSION",
	"VIBE_TAVERN_WEB_UPDATE_API_BASE",
	"VIBE_TAVERN_WEB_MODE",
	"VIBE_TAVERN_WEB_API_URL",
	"VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL",
	"VIBE_TAVERN_WEB_DEFAULT_BASE_URL",
	"VIBE_TAVERN_WEB_DEFAULT_MODEL",
	"VIBE_TAVERN_WEB_FORCE_FIRST_RUN",
] as const;

const originalEnv = new Map(WEB_ENV_KEYS.map((key) => [key, process.env[key]]));
let importVersion = 0;

function setEnv(key: typeof WEB_ENV_KEYS[number], value: string): void {
	// process.env is a special object: Node — and Bun since 1.4 — reject any
	// descriptor that is not a configurable, writable AND enumerable data
	// descriptor with ERR_INVALID_OBJECT_DEFINE_PROPERTY. Bun 1.3 silently
	// tolerated the missing `enumerable`.
	Object.defineProperty(process.env, key, { configurable: true, enumerable: true, value, writable: true });
}

function importBuildConfig() {
	importVersion += 1;
	return import(`./build-config.js?wave6=${importVersion}`);
}

afterEach(() => {
	for (const key of WEB_ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else setEnv(key, value);
	}
});

describe("build configuration", () => {
	test("uses browser-safe defaults when web build variables are empty", async () => {
		// Given
		for (const key of WEB_ENV_KEYS) setEnv(key, "");

		// When
		const buildConfig = await importBuildConfig();

		// Then
		expect(buildConfig.API_URL).toBeNull();
		expect(buildConfig.APP_VERSION).toBe("0.0.0-dev");
		expect(buildConfig.UPDATE_API_BASE).toBe(
			"https://api.github.com/repos/Noineri/vibe_tavern",
		);
		expect(buildConfig.isDev).toBe(false);
		expect(buildConfig.isProd).toBe(false);
		expect(buildConfig.DEFAULT_PROVIDER_LABEL).toBe("OpenAI-compatible");
		expect(buildConfig.DEFAULT_BASE_URL).toBe("");
		expect(buildConfig.DEFAULT_MODEL).toBe("");
		expect(buildConfig.FORCE_FIRST_RUN).toBe(false);
	});

	test("reads configured web build variables at module initialization", async () => {
		// Given
		setEnv("VIBE_TAVERN_WEB_API_URL", "https://api.example.test");
		setEnv("VIBE_TAVERN_WEB_APP_VERSION", "9.8.7");
		setEnv("VIBE_TAVERN_WEB_UPDATE_API_BASE", "https://updates.example.test/");
		setEnv("VIBE_TAVERN_WEB_MODE", "development");
		setEnv("VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL", "Local provider");
		setEnv("VIBE_TAVERN_WEB_DEFAULT_BASE_URL", "https://models.example.test/v1");
		setEnv("VIBE_TAVERN_WEB_DEFAULT_MODEL", "example-model");
		setEnv("VIBE_TAVERN_WEB_FORCE_FIRST_RUN", "true");

		// When
		const buildConfig = await importBuildConfig();

		// Then
		expect(buildConfig.API_URL).toBe("https://api.example.test");
		expect(buildConfig.APP_VERSION).toBe("9.8.7");
		expect(buildConfig.UPDATE_API_BASE).toBe("https://updates.example.test");
		expect(buildConfig.isDev).toBe(true);
		expect(buildConfig.isProd).toBe(false);
		expect(buildConfig.DEFAULT_PROVIDER_LABEL).toBe("Local provider");
		expect(buildConfig.DEFAULT_BASE_URL).toBe("https://models.example.test/v1");
		expect(buildConfig.DEFAULT_MODEL).toBe("example-model");
		expect(buildConfig.FORCE_FIRST_RUN).toBe(true);
	});

	test("only enables forced first run for the literal true value", async () => {
		// Given
		setEnv("VIBE_TAVERN_WEB_FORCE_FIRST_RUN", "TRUE");

		// When
		const buildConfig = await importBuildConfig();

		// Then
		expect(buildConfig.FORCE_FIRST_RUN).toBe(false);
	});
});
