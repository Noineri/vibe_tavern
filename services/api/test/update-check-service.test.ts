/**
 * The server-owned update check and its cache.
 *
 * The cache is not an optimization detail — an unauthenticated client gets 60
 * GitHub requests per hour, and every open tab polls. Caching successes alone
 * would leave an offline or rate-limited server re-hitting the API on every
 * poll, which is exactly how the ban is earned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearUpdateCheckCache, getUpdateCheck } from "../src/domain/update/update-check-service.js";

const originalBase = process.env.VT_UPDATE_API_BASE;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

function releasePayload(version: string) {
	const assetsFor = (v: string) => [
		{ name: `Vibe-Tavern-v${v}-linux.tar.gz`, browser_download_url: "http://x.test/a", size: 100 },
		{ name: `Vibe-Tavern-v${v}-windows.zip`, browser_download_url: "http://x.test/b", size: 100 },
		{ name: "SHA256SUMS.txt", browser_download_url: "http://x.test/s", size: 10 },
	];
	return { tag_name: `v${version}`, body: `notes for ${version}`, assets: assetsFor(version) };
}

/** Serve a release and count how many times GitHub was actually hit. */
function serve(version: string, opts: { status?: number } = {}) {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			hits += 1;
			if (opts.status !== undefined) return new Response("nope", { status: opts.status });
			return Response.json(releasePayload(version));
		},
	});
	servers.push(server);
	process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${server.port}`;
	return { hits: () => hits };
}

beforeEach(() => {
	clearUpdateCheckCache();
});

afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
	if (originalBase === undefined) delete process.env.VT_UPDATE_API_BASE;
	else process.env.VT_UPDATE_API_BASE = originalBase;
	clearUpdateCheckCache();
});

describe("getUpdateCheck", () => {
	it("reports an available update with the tag, version and notes", async () => {
		serve("99.0.0");

		const result = await getUpdateCheck();

		// The dev build reports version "dev", which compares as 0.0.0, so any
		// real release is an update.
		expect(result.available).toBe(true);
		expect(result.reason).toBe("update-available");
		expect(result.latestVersion).toBe("99.0.0");
		expect(result.latestTag).toBe("v99.0.0");
		expect(result.releaseNotes).toBe("notes for 99.0.0");
		expect(result.releaseUrl).not.toBeNull();
	});

	it("does not re-fetch within the success TTL", async () => {
		const probe = serve("99.0.0");

		await getUpdateCheck();
		await getUpdateCheck();
		await getUpdateCheck();

		expect(probe.hits()).toBe(1);
	});

	it("reports offline — not a crash — when GitHub is unreachable", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const port = dead.port;
		dead.stop(true);
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${port}`;

		const result = await getUpdateCheck();

		expect(result.available).toBe(false);
		expect(result.reason).toBe("offline");
		expect(result.latestVersion).toBeNull();
	});

	it("caches a failure so a rate-limited server stops hammering GitHub", async () => {
		const probe = serve("99.0.0", { status: 403 });

		await getUpdateCheck();
		await getUpdateCheck();
		await getUpdateCheck();

		expect(probe.hits()).toBe(1);
	});

	it("always reports the current version and install kind, even when offline", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const port = dead.port;
		dead.stop(true);
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${port}`;

		const result = await getUpdateCheck();

		expect(result.currentVersion.length).toBeGreaterThan(0);
		expect(result.installKind.length).toBeGreaterThan(0);
		// Dev builds cannot self-update, but the verdict is still served — the
		// badge must keep working on every install kind.
		expect(typeof result.canSelfUpdate).toBe("boolean");
	});

	it("reports no-asset-for-platform, not offline, when the release has no archive for this machine", async () => {
		// A release that ships only an .apk and sums: reachable, well-formed,
		// and uninstallable here. Reporting "offline" would send the user
		// looking for a network problem that does not exist.
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({
				tag_name: "v99.0.0",
				body: "android only",
				assets: [
					{ name: "Vibe-Tavern-v99.0.0-android.apk", browser_download_url: "http://x.test/a", size: 10 },
					{ name: "SHA256SUMS.txt", browser_download_url: "http://x.test/s", size: 10 },
				],
			}),
		});
		servers.push(server);
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${server.port}`;

		const result = await getUpdateCheck();

		expect(result.reason).toBe("no-asset-for-platform");
		expect(result.available).toBe(false);
		// It still says WHICH release, so the UI can point at the right page.
		expect(result.latestVersion).toBe("99.0.0");
		expect(result.latestTag).toBe("v99.0.0");
		expect(result.releaseUrl).not.toBeNull();
	});

	it("never throws, whatever the server returns", async () => {
		serve("99.0.0", { status: 500 });
		await expect(getUpdateCheck()).resolves.toBeDefined();

		clearUpdateCheckCache();
		const garbage = Bun.serve({ port: 0, fetch: () => new Response("<html>not json</html>") });
		servers.push(garbage);
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${garbage.port}`;
		await expect(getUpdateCheck()).resolves.toBeDefined();
	});
});
