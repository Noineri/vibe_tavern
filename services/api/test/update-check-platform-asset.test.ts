import { afterEach, describe, expect, it } from "bun:test";
import { checkForUpdateDetailed } from "../src/server/updater.js";

/**
 * Pins the `requirePlatformAsset` gate.
 *
 * The updater decides whether a release is usable by looking for an archive
 * matching this platform, because that is what it downloads. The npm channel
 * installs from the registry instead, and there is NO release archive at all
 * for macOS or for any non-x64 machine — so applying the same gate would hide
 * every update from precisely the users the npm channel exists to reach.
 *
 * The release payloads below deliberately carry no asset this (or any) host can
 * select, which is what makes the two answers differ.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const previousBase = process.env.VT_UPDATE_API_BASE;

function startReleaseApi(tag: string): string {
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				tag_name: tag,
				name: `Vibe Tavern ${tag}`,
				body: "## What's new",
				draft: false,
				prerelease: false,
				// An APK and a Windows installer: neither is ever selectable as an
				// update archive on any platform. SHA256SUMS.txt is present
				// because resolveRelease treats a release without it as
				// unparseable — a coupling the npm channel inherits even though
				// it never verifies a checksum. Every release the workflow
				// produces carries one, so this is a fixture requirement, not a
				// live hazard.
				assets: [
					{ name: `Vibe-Tavern-${tag}-android.apk`, browser_download_url: "http://127.0.0.1:1/a.apk", size: 1 },
					{ name: `Vibe-Tavern-${tag}-windows-setup.exe`, browser_download_url: "http://127.0.0.1:1/s.exe", size: 1 },
					{ name: "SHA256SUMS.txt", browser_download_url: "http://127.0.0.1:1/SHA256SUMS.txt", size: 1 },
				],
			}),
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	if (previousBase === undefined) delete process.env.VT_UPDATE_API_BASE;
	else process.env.VT_UPDATE_API_BASE = previousBase;
});

describe("checkForUpdateDetailed — requirePlatformAsset", () => {
	it("reports no-asset-for-platform by default, keeping the archive gate for binary channels", async () => {
		process.env.VT_UPDATE_API_BASE = startReleaseApi("v9.9.9");
		const outcome = await checkForUpdateDetailed();
		expect(outcome.kind).toBe("no-asset-for-platform");
	});

	it("resolves the same release as 'ok' when the caller does not install from archives", async () => {
		process.env.VT_UPDATE_API_BASE = startReleaseApi("v9.9.9");
		const outcome = await checkForUpdateDetailed({ requirePlatformAsset: false });
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(outcome.result.latestVersion).toBe("9.9.9");
		expect(outcome.result.latestTag).toBe("v9.9.9");
		expect(outcome.result.updateAvailable).toBe(true);
	});

	it("does not invent an update when the assetless release is not newer", async () => {
		// CURRENT_VERSION is "dev" in a non-compiled build, which compareVersions
		// reads as 0.0.0 — so v0.0.0 is the not-newer case here.
		process.env.VT_UPDATE_API_BASE = startReleaseApi("v0.0.0");
		const outcome = await checkForUpdateDetailed({ requirePlatformAsset: false });
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(outcome.result.updateAvailable).toBe(false);
	});

	it("still reports offline when the release API is unreachable, regardless of the flag", async () => {
		process.env.VT_UPDATE_API_BASE = "http://127.0.0.1:1";
		expect((await checkForUpdateDetailed({ requirePlatformAsset: false })).kind).toBe("offline");
	});
});
