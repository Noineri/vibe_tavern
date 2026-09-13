import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface RunningDevServer {
	readonly baseUrl: string;
	stop(): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

const ROOT = resolve(import.meta.dir, "..", "..", "..");

async function reservePort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("port probe"),
	});
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("Bun did not assign an ephemeral port");
	return port;
}

async function startDevServer(): Promise<RunningDevServer> {
	const port = await reservePort();
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "vibe-tavern-dev-server-test-"));
	const preload = join(temporaryDirectory, "block-self-fetch.ts");
	await Bun.write(preload, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if ((target.hostname === "127.0.0.1" || target.hostname === "localhost") && target.port === process.env.VIBE_TAVERN_WEB_DEV_PORT) {
    return Promise.resolve(new Response("self-fetch blocked", { status: 599 }));
  }
  return nativeFetch(input, init);
};
`);

	const child = Bun.spawn(
		[process.execPath, "--preload", preload, "apps/web/dev-server.ts", "--no-api"],
		{
			cwd: ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...Bun.env,
				VIBE_TAVERN_WEB_DEV_PORT: String(port),
				VIBE_TAVERN_OPEN_BROWSER: "0",
				FORCE_COLOR: "0",
				NO_COLOR: "1",
			},
		},
	);
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			await rm(temporaryDirectory, { recursive: true, force: true });
			throw new Error(`dev server exited before it became ready\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}
		try {
			const response = await fetch(`${baseUrl}/`);
			if (response.ok) break;
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
		await Bun.sleep(25);
	}

	if (Date.now() >= deadline) {
		child.kill();
		await child.exited;
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		await rm(temporaryDirectory, { recursive: true, force: true });
		throw new Error(`dev server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}

	return {
		baseUrl,
		async stop() {
			child.kill();
			await child.exited;
			const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			await rm(temporaryDirectory, { recursive: true, force: true });
			return { stdout, stderr };
		},
	};
}

test("a deep link reaches the HMR document without a loopback fetch", async () => {
	const server = await startDevServer();
	try {
		const response = await fetch(`${server.baseUrl}/chats/task-26`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("<title>Vibe Tavern</title>");
	} finally {
		await server.stop();
	}
}, 35_000);

test("a public directory response carries Bun's file validators", async () => {
	const server = await startDevServer();
	try {
		const response = await fetch(`${server.baseUrl}/fonts/OFL.txt`);
		const etag = response.headers.get("etag");
		expect(response.status).toBe(200);
		expect(etag).toMatch(/^W\//);
		expect(response.headers.get("last-modified")).not.toBeNull();
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(await response.text()).toContain("SIL OPEN FONT LICENSE");
		if (etag === null) throw new Error("directory response did not provide an ETag");

		const conditional = await fetch(`${server.baseUrl}/fonts/OFL.txt`, {
			headers: { "If-None-Match": etag },
		});
		expect(conditional.status).toBe(304);
		expect(await conditional.text()).toBe("");
	} finally {
		await server.stop();
	}
}, 35_000);

test("root public files remain available beside directory routes", async () => {
	const server = await startDevServer();
	try {
		const response = await fetch(`${server.baseUrl}/logo.svg`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(await response.text()).toContain("<svg ");
	} finally {
		await server.stop();
	}
}, 35_000);

test("a missing file under a public directory stays a 404", async () => {
	const server = await startDevServer();
	try {
		const response = await fetch(`${server.baseUrl}/fonts/missing.txt`);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	} finally {
		await server.stop();
	}
}, 35_000);

test("piped startup output honors NO_COLOR", async () => {
	const server = await startDevServer();
	const { stdout } = await server.stop();
	expect(stdout).toContain("Vibe Tavern — Dev Server");
	expect(stdout).not.toContain("\u001b[");
}, 35_000);
