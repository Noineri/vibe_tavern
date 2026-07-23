import { afterEach, describe, expect, test, vi } from "vitest";

const WEB_ENV_KEYS = [
	"RP_WEB_API_URL",
	"RP_WEB_DEFAULT_PROVIDER_LABEL",
	"RP_WEB_DEFAULT_BASE_URL",
	"RP_WEB_DEFAULT_MODEL",
	"RP_WEB_FORCE_FIRST_RUN",
] as const;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("build configuration", () => {
	test("uses browser-safe defaults when web build variables are empty", async () => {
		// Given
		for (const key of WEB_ENV_KEYS) vi.stubEnv(key, "");

		// When
		const buildConfig = await import("./build-config.js");

		// Then
		expect(buildConfig.API_URL).toBeNull();
		expect(buildConfig.DEFAULT_PROVIDER_LABEL).toBe("OpenAI-compatible");
		expect(buildConfig.DEFAULT_BASE_URL).toBe("");
		expect(buildConfig.DEFAULT_MODEL).toBe("");
		expect(buildConfig.FORCE_FIRST_RUN).toBe(false);
	});

	test("reads configured web build variables at module initialization", async () => {
		// Given
		vi.stubEnv("RP_WEB_API_URL", "https://api.example.test");
		vi.stubEnv("RP_WEB_DEFAULT_PROVIDER_LABEL", "Local provider");
		vi.stubEnv("RP_WEB_DEFAULT_BASE_URL", "https://models.example.test/v1");
		vi.stubEnv("RP_WEB_DEFAULT_MODEL", "example-model");
		vi.stubEnv("RP_WEB_FORCE_FIRST_RUN", "true");

		// When
		const buildConfig = await import("./build-config.js");

		// Then
		expect(buildConfig.API_URL).toBe("https://api.example.test");
		expect(buildConfig.DEFAULT_PROVIDER_LABEL).toBe("Local provider");
		expect(buildConfig.DEFAULT_BASE_URL).toBe("https://models.example.test/v1");
		expect(buildConfig.DEFAULT_MODEL).toBe("example-model");
		expect(buildConfig.FORCE_FIRST_RUN).toBe(true);
	});

	test("only enables forced first run for the literal true value", async () => {
		// Given
		vi.stubEnv("RP_WEB_FORCE_FIRST_RUN", "TRUE");

		// When
		const buildConfig = await import("./build-config.js");

		// Then
		expect(buildConfig.FORCE_FIRST_RUN).toBe(false);
	});
});
