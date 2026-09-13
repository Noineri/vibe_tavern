/**
 * Streaming download + the whole downloadAndSwap pipeline against a local
 * mock release server.
 *
 * The unit half pins that the digest computed during the download equals a
 * digest taken over the same bytes, that progress reporting kept its shape,
 * and that the bytes reach disk while the response is still open rather than
 * being buffered whole. The pipeline half is the automated version of the
 * plan's manual verification checklist: happy path, corrupted archive, and a
 * server that dies mid-download — the last two must leave the install
 * untouched and surface as SOFT failures.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { pack } from "tar-stream";
import {
	downloadAndSwap,
	downloadToPathWithProgress,
	SoftUpdateError,
	type ParsedRelease,
	type UpdatePhase,
} from "../src/server/updater.js";

const ARCHIVE_SUFFIX = process.platform === "win32" ? "-windows.zip" : "-linux.tar.gz";

let root = "";
let installDir = "";
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-dl-"));
	installDir = join(root, "install");
	await mkdir(installDir, { recursive: true });
});

afterEach(async () => {
	for (const s of servers.splice(0)) s.stop(true);
	await rm(root, { recursive: true, force: true });
});

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A release archive shaped like the real one: a binary plus a web/ tree. */
async function buildArchive(version: string): Promise<{ path: string; bytes: Uint8Array }> {
	const archivePath = join(root, `Vibe-Tavern-v${version}${ARCHIVE_SUFFIX}`);
	if (process.platform === "win32") {
		const { zipSync } = await import("fflate");
		const enc = new TextEncoder();
		await writeFile(archivePath, zipSync({
			"vibe-tavern.exe": enc.encode(`BINARY v${version}`),
			"web/index.html": enc.encode(`<html>v${version}</html>`),
		}));
	} else {
		const packer = pack();
		const done = pipeline(packer, createGzip(), createWriteStream(archivePath));
		packer.entry({ name: "vibe-tavern", mode: 0o755 }, `BINARY v${version}`);
		packer.entry({ name: "web/index.html", mode: 0o644 }, `<html>v${version}</html>`);
		packer.finalize();
		await done;
	}
	return { path: archivePath, bytes: new Uint8Array(await readFile(archivePath)) };
}

interface MockRelease {
	readonly release: ParsedRelease;
	readonly archiveBytes: Uint8Array;
	readonly server: { stop: (force?: boolean) => void };
}

/**
 * Serve an archive + SHA256SUMS.txt and return a ParsedRelease pointing at it.
 * `corrupt` flips a byte in the served archive without changing the sums file.
 * `slow` drip-feeds the archive so the caller can kill the server mid-download.
 */
async function serveRelease(
	version: string,
	opts: { corrupt?: boolean; slow?: boolean } = {},
): Promise<MockRelease> {
	const { bytes } = await buildArchive(version);
	const archiveName = `Vibe-Tavern-v${version}${ARCHIVE_SUFFIX}`;
	const digest = createHash("sha256").update(bytes).digest("hex");
	const sums = `${digest}  ${archiveName}\n${"0".repeat(64)}  Vibe-Tavern-v${version}-android.apk\n`;

	const served = opts.corrupt ? Uint8Array.from(bytes) : bytes;
	if (opts.corrupt) served[Math.floor(served.length / 2)] ^= 0xff;

	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/SHA256SUMS.txt") return new Response(sums);
			if (url.pathname !== `/${archiveName}`) return new Response("nope", { status: 404 });

			if (opts.slow) {
				// Pad so the download lasts long enough to be interrupted, and
				// drip it out in small chunks.
				const padded = new Uint8Array(512 * 1024);
				padded.set(served.subarray(0, Math.min(served.length, padded.length)));
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						for (let off = 0; off < padded.length; off += 8192) {
							controller.enqueue(padded.subarray(off, off + 8192));
							await Bun.sleep(5);
						}
						controller.close();
					},
				});
				return new Response(body);
			}
			return new Response(served, {
				headers: { "content-length": String(served.length) },
			});
		},
	});
	servers.push(server);
	const base = `http://127.0.0.1:${server.port}`;

	return {
		server,
		archiveBytes: bytes,
		release: {
			tag: `v${version}`,
			version,
			releaseNotes: "notes",
			archiveAsset: {
				name: archiveName,
				browser_download_url: `${base}/${archiveName}`,
				size: bytes.length,
			},
			sumsAsset: {
				name: "SHA256SUMS.txt",
				browser_download_url: `${base}/SHA256SUMS.txt`,
				size: sums.length,
			},
		},
	};
}

async function seedInstall(): Promise<void> {
	await mkdir(join(installDir, "web"), { recursive: true });
	await mkdir(join(installDir, "data"), { recursive: true });
	await writeFile(join(installDir, process.platform === "win32" ? "vibe-tavern.exe" : "vibe-tavern"), "BINARY v1.0.0");
	await writeFile(join(installDir, "web", "index.html"), "<html>v1.0.0</html>");
	await writeFile(join(installDir, "data", "vibe-tavern.db"), "USER DATA");
}

const binaryName = process.platform === "win32" ? "vibe-tavern.exe" : "vibe-tavern";

// ─── streaming download ─────────────────────────────────────────────────────

describe("downloadToPathWithProgress", () => {
	it("returns a digest equal to createHash over the same bytes", async () => {
		const payload = new Uint8Array(1024 * 512);
		crypto.getRandomValues(payload.subarray(0, 4096));
		for (let i = 4096; i < payload.length; i++) payload[i] = payload[i % 4096] ?? 0;
		const expected = createHash("sha256").update(payload).digest("hex");

		const server = Bun.serve({ port: 0, fetch: () => new Response(payload) });
		servers.push(server);
		const dest = join(root, "downloaded.bin");

		const outcome = await downloadToPathWithProgress(`http://127.0.0.1:${server.port}/x`, dest);

		expect(outcome.sha256).toBe(expected);
		expect(outcome.bytes).toBe(payload.length);
		// And the file on disk is byte-identical, so the digest describes it.
		const written = new Uint8Array(await readFile(dest));
		expect(createHash("sha256").update(written).digest("hex")).toBe(expected);
	});

	it("reports progress as receivedBytes/totalBytes, ending at the full size", async () => {
		const payload = new Uint8Array(300_000).fill(7);
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(payload, { headers: { "content-length": String(payload.length) } }),
		});
		servers.push(server);

		const seen: Array<[number | undefined, number | undefined]> = [];
		await downloadToPathWithProgress(
			`http://127.0.0.1:${server.port}/x`,
			join(root, "p.bin"),
			(received, total) => seen.push([received, total]),
		);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen.at(-1)?.[0]).toBe(payload.length);
		expect(seen.at(-1)?.[1]).toBe(payload.length);
		// Monotonically non-decreasing.
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]?.[0] ?? 0).toBeGreaterThanOrEqual(seen[i - 1]?.[0] ?? 0);
		}
	});

	it("leaves totalBytes undefined on a chunked response with no content-length", async () => {
		// Bun buffers small streamed bodies and adds a content-length, so the
		// response has to be slow and multi-chunk to actually go out chunked.
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(new ReadableStream<Uint8Array>({
				async start(c) {
					for (let i = 0; i < 4; i++) {
						c.enqueue(new Uint8Array(64 * 1024).fill(i));
						await Bun.sleep(10);
					}
					c.close();
				},
			})),
		});
		servers.push(server);

		const seen: Array<number | undefined> = [];
		const outcome = await downloadToPathWithProgress(
			`http://127.0.0.1:${server.port}/x`,
			join(root, "q.bin"),
			(_received, total) => seen.push(total),
		);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((t) => t === undefined)).toBe(true);
		expect(outcome.bytes).toBe(4 * 64 * 1024);
	});

	it("treats a non-numeric content-length as unknown rather than NaN", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(new Uint8Array([1, 2, 3]), {
				headers: { "content-length": "banana" },
			}),
		});
		servers.push(server);

		const seen: Array<number | undefined> = [];
		await downloadToPathWithProgress(
			`http://127.0.0.1:${server.port}/x`,
			join(root, "nan.bin"),
			(_received, total) => seen.push(total),
		);

		expect(seen.every((t) => t === undefined || Number.isFinite(t))).toBe(true);
		expect(seen.some((t) => Number.isNaN(t))).toBe(false);
	});

	it("throws on a non-2xx response", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("gone", { status: 404 }) });
		servers.push(server);
		await expect(
			downloadToPathWithProgress(`http://127.0.0.1:${server.port}/x`, join(root, "r.bin")),
		).rejects.toThrow(/Download failed: HTTP 404/);
	});

	it("commits bytes to disk before the server has finished sending the body", async () => {
		// The old implementation kept every chunk in an array, allocated a
		// second full-size copy to concatenate them for `Bun.write`, and only
		// then read the whole file back to hash it. Whether it buffers is
		// observable without measuring memory: a buffering downloader writes
		// nothing until the response has ended, so the fixture asks the
		// filesystem what is already committed at the moment it is about to
		// produce the last chunk.
		//
		// Neither side may hold the payload, or the fixture would be what is
		// under test: the body is generated chunk-by-chunk on the fly and the
		// expected digest accumulates over the same chunks without retaining
		// them.
		const CHUNK = 64 * 1024;
		const CHUNKS = 512; // 32 MB — far past anything fetch buffers internally.
		const dest = join(root, "streamed.bin");
		const chunkAt = (i: number): Uint8Array => {
			const c = new Uint8Array(CHUNK);
			// Cheap non-constant filler so the bytes are not trivially uniform.
			for (let j = 0; j < CHUNK; j += 977) c[j] = (i * 31 + j) & 0xff;
			return c;
		};

		let bytesOnDiskBeforeLastChunk = -1;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				let next = 0;
				return new Response(new ReadableStream<Uint8Array>({
					// `pull` and not `start`: a `start` producer enqueues the
					// whole body ahead of the socket, so the client could be
					// arbitrarily far behind the fixture's own backlog. `pull`
					// is driven by the response draining, like a real server.
					async pull(controller) {
						if (next === CHUNKS - 1) {
							bytesOnDiskBeforeLastChunk = await stat(dest).then((s) => s.size, () => 0);
						}
						if (next >= CHUNKS) {
							controller.close();
							return;
						}
						controller.enqueue(chunkAt(next++));
					},
				}));
			},
		});
		servers.push(server);

		const expected = createHash("sha256");
		for (let i = 0; i < CHUNKS; i++) expected.update(chunkAt(i));

		const outcome = await downloadToPathWithProgress(`http://127.0.0.1:${server.port}/big.bin`, dest);

		const payloadSize = CHUNK * CHUNKS;
		expect(outcome.bytes).toBe(payloadSize);
		expect(outcome.sha256).toBe(expected.digest("hex"));
		expect((await stat(dest)).size).toBe(payloadSize);
		// The pin: most of the archive was already on disk while the server
		// still owed the client a chunk. A buffer-everything downloader
		// reports 0 here — the file does not exist yet.
		expect(bytesOnDiskBeforeLastChunk).toBeGreaterThan(payloadSize / 2);
	});
});

// ─── full pipeline ──────────────────────────────────────────────────────────

describe("downloadAndSwap against a mock release server", () => {
	it("downloads, verifies, extracts and swaps, leaving user data alone", async () => {
		await seedInstall();
		const { release } = await serveRelease("1.1.0");

		const phases: UpdatePhase[] = [];
		const progress: number[] = [];
		const version = await downloadAndSwap(release, installDir, {
			onPhase: (p) => phases.push(p),
			onDownloadProgress: (_url, received) => {
				if (received !== undefined) progress.push(received);
			},
		});

		expect(version).toBe("1.1.0");
		expect(await readFile(join(installDir, binaryName), "utf8")).toBe("BINARY v1.1.0");
		expect(await readFile(join(installDir, "web", "index.html"), "utf8")).toBe("<html>v1.1.0</html>");
		// User data untouched.
		expect(await readFile(join(installDir, "data", "vibe-tavern.db"), "utf8")).toBe("USER DATA");
		// Previous install preserved in a backup generation.
		const backups = (await readdir(installDir)).filter((n) => n.startsWith(".old-"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(installDir, backups[0] ?? "", binaryName), "utf8")).toBe("BINARY v1.0.0");
		// Staging is cleaned up.
		expect(await stat(join(installDir, ".next")).then(() => true, () => false)).toBe(false);

		expect(phases).toEqual([
			"preflight",
			"downloading-archive",
			"downloading-sums",
			"verifying",
			"extracting",
			"swapping",
		]);
		expect(progress.length).toBeGreaterThan(0);
	});

	it("restores the exec bit on the new binary from the archive", async () => {
		if (process.platform === "win32") return;
		await seedInstall();
		const { release } = await serveRelease("1.2.0");

		await downloadAndSwap(release, installDir);

		expect(((await stat(join(installDir, "vibe-tavern"))).mode & 0o777).toString(8)).toBe("755");
	});

	it("fails SOFT and leaves the install untouched when the archive is corrupted", async () => {
		await seedInstall();
		const { release } = await serveRelease("1.3.0", { corrupt: true });

		const err = await downloadAndSwap(release, installDir).then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(SoftUpdateError);
		expect(err instanceof Error ? err.message : "").toMatch(/Checksum mismatch/);
		expect(await readFile(join(installDir, binaryName), "utf8")).toBe("BINARY v1.0.0");
		expect(await readFile(join(installDir, "data", "vibe-tavern.db"), "utf8")).toBe("USER DATA");
		expect((await readdir(installDir)).filter((n) => n.startsWith(".old-"))).toHaveLength(0);
	});

	it("fails SOFT and leaves the install untouched when the server dies mid-download", async () => {
		// The plan's manual check #5, automated: kill the release server while
		// the archive is in flight.
		await seedInstall();
		const { release, server } = await serveRelease("1.4.0", { slow: true });

		let killed = false;
		const err = await downloadAndSwap(release, installDir, {
			onDownloadProgress: (_url, received) => {
				if (!killed && (received ?? 0) > 16384) {
					killed = true;
					server.stop(true);
				}
			},
		}).then(() => null, (e: unknown) => e);

		expect(killed).toBe(true);
		expect(err).toBeInstanceOf(SoftUpdateError);
		expect(await readFile(join(installDir, binaryName), "utf8")).toBe("BINARY v1.0.0");
		expect(await readFile(join(installDir, "data", "vibe-tavern.db"), "utf8")).toBe("USER DATA");
		expect((await readdir(installDir)).filter((n) => n.startsWith(".old-"))).toHaveLength(0);
	});

	it("refuses before downloading anything when the volume cannot hold the update", async () => {
		await seedInstall();
		const { release } = await serveRelease("1.6.0");
		// Claim an absurd asset size so the preflight cannot possibly pass.
		const huge: ParsedRelease = {
			...release,
			archiveAsset: { ...release.archiveAsset, size: 1024 ** 5 },
		};

		const phases: UpdatePhase[] = [];
		const err = await downloadAndSwap(huge, installDir, {
			onPhase: (p) => phases.push(p),
		}).then(() => null, (e: unknown) => e);

		expect(err).toBeInstanceOf(SoftUpdateError);
		expect(err instanceof Error ? err.message : "").toMatch(/Not enough free space/);
		// It named both numbers, and it never started downloading.
		expect(err instanceof Error ? err.message : "").toMatch(/Need about .*available/s);
		expect(phases).toEqual(["preflight"]);
		expect(await readFile(join(installDir, binaryName), "utf8")).toBe("BINARY v1.0.0");
	});

	it("fails SOFT when the sums file does not list the archive", async () => {
		await seedInstall();
		const { release } = await serveRelease("1.5.0");
		// Point the archive at a name the sums file does not mention.
		const renamed: ParsedRelease = {
			...release,
			archiveAsset: {
				...release.archiveAsset,
				name: `Vibe-Tavern-v9.9.9${ARCHIVE_SUFFIX}`,
			},
		};

		const err = await downloadAndSwap(renamed, installDir).then(() => null, (e: unknown) => e);

		expect(err).toBeInstanceOf(SoftUpdateError);
		expect(err instanceof Error ? err.message : "").toMatch(/No checksum entry/);
		expect(await readFile(join(installDir, binaryName), "utf8")).toBe("BINARY v1.0.0");
	});
});
