import { afterEach, describe, expect, it } from "bun:test";
import { installPackageVersion, isVersionPublished, packageSpec } from "../src/domain/update/npm-update.js";

/**
 * The registry probe is the guard against the one ordering hazard the npm
 * channel has: a GitHub release is visible immediately, the npm publish job
 * finishes later. These tests pin that a 404 is reported as "not published"
 * rather than collapsed into a generic failure — the two lead to different
 * messages, and telling an offline user their release is missing is wrong.
 */

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const previousBase = process.env.VT_NPM_REGISTRY_BASE;

function startRegistry(handler: (req: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	if (previousBase === undefined) delete process.env.VT_NPM_REGISTRY_BASE;
	else process.env.VT_NPM_REGISTRY_BASE = previousBase;
	delete process.env.VT_NPM_INSTALL_TIMEOUT_MS;
	delete process.env.BUN_CONFIG_REGISTRY;
});

describe("packageSpec", () => {
	it("builds the exact spec bun is asked to install", () => {
		// Pinned to a version, never a range or dist-tag: the modal shows the
		// notes for one version, so that is the version that must be installed.
		expect(packageSpec("1.2.3")).toBe("vibe-tavern@1.2.3");
	});
});

describe("isVersionPublished", () => {
	it("reports 'published' when the registry has the version", async () => {
		process.env.VT_NPM_REGISTRY_BASE = startRegistry(() =>
			Response.json({ name: "vibe-tavern", version: "1.2.3" }),
		);
		expect(await isVersionPublished("1.2.3")).toEqual({ kind: "published" });
	});

	it("reports 'not-published' on 404 — the release-is-still-rolling-out case", async () => {
		process.env.VT_NPM_REGISTRY_BASE = startRegistry(() => new Response("Not found", { status: 404 }));
		expect(await isVersionPublished("9.9.9")).toEqual({ kind: "not-published" });
	});

	it("distinguishes a registry error from a missing version", async () => {
		process.env.VT_NPM_REGISTRY_BASE = startRegistry(() => new Response("nope", { status: 503 }));
		const result = await isVersionPublished("1.2.3");
		expect(result.kind).toBe("lookup-failed");
	});

	it("reports 'lookup-failed' when the registry is unreachable, never 'not-published'", async () => {
		// Port 1 on loopback: nothing listens, so fetch rejects. An offline user
		// must not be told their version was never published.
		process.env.VT_NPM_REGISTRY_BASE = "http://127.0.0.1:1";
		const result = await isVersionPublished("1.2.3");
		expect(result.kind).toBe("lookup-failed");
	});

	it("requests the version path so a dist-tag can never be mistaken for a version", async () => {
		let seenPath = "";
		process.env.VT_NPM_REGISTRY_BASE = startRegistry((req) => {
			seenPath = new URL(req.url).pathname;
			return Response.json({ version: "1.2.3" });
		});
		await isVersionPublished("1.2.3");
		expect(seenPath).toBe("/vibe-tavern/1.2.3");
	});
});

describe("installPackageVersion", () => {
	it("fails loudly, and says the install is intact, when the package manager exits non-zero", async () => {
		// The spawned command is `${process.execPath} add -g <spec>`. Under
		// bun:test process.execPath IS bun, so this really runs bun with an
		// unresolvable package name rather than mocking the spawn away.
		await expect(installPackageVersion("0.0.0-does-not-exist-vt-test")).rejects.toThrow(
			/still installed/,
		);
	}, 120_000);

	it("reports a hung package manager as a timeout, not as an exit code", async () => {
		// The deadline is the only thing that can end this install: the child
		// bun is pointed at a registry that accepts the connection and never
		// answers, so it waits instead of failing fast. Without the signal
		// check the user would read "exited with code 137" — 137 is what a
		// SIGKILL looks like from the outside — instead of "timed out".
		process.env.BUN_CONFIG_REGISTRY = startRegistry(() => new Promise<Response>(() => {}));
		process.env.VT_NPM_INSTALL_TIMEOUT_MS = "1000";

		const started = Bun.nanoseconds();
		await expect(installPackageVersion("9.9.9-vt-hang-test")).rejects.toThrow(
			/timed out.*still installed/s,
		);
		expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(20_000);
	}, 60_000);
});
