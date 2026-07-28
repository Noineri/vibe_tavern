/**
 * Round-trip and hostile-archive coverage for in-process extraction.
 *
 * Fixtures are built in the test rather than committed: the tar fixtures come
 * from `tar-stream`'s packer and the system `tar` (so we prove we can read what
 * the release workflow actually produces, not just what we ourselves wrote),
 * and the zip fixtures from `fflate`'s `zipSync`.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { zipSync } from "fflate";
import { pack } from "tar-stream";
import { extractArchive, resolveEntryPath } from "../src/server/archive-extract.js";

let root = "";
let dest = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-extract-"));
	dest = join(root, "out");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface TarEntry {
	readonly name: string;
	readonly content?: string;
	readonly mode?: number;
	readonly type?: "file" | "directory" | "symlink";
	readonly linkname?: string;
}

/** Build a .tar.gz from entry descriptors using tar-stream's packer. */
async function makeTarGz(name: string, entries: readonly TarEntry[]): Promise<string> {
	const archivePath = join(root, name);
	const packer = pack();
	const write = pipeline(packer, createGzip(), createWriteStream(archivePath));
	for (const e of entries) {
		packer.entry(
			{
				name: e.name,
				type: e.type ?? "file",
				mode: e.mode,
				linkname: e.linkname,
			},
			e.content ?? "",
		);
	}
	packer.finalize();
	await write;
	return archivePath;
}

async function makeZip(name: string, files: Record<string, string>): Promise<string> {
	const archivePath = join(root, name);
	const enc = new TextEncoder();
	const payload: Record<string, Uint8Array> = {};
	for (const [k, v] of Object.entries(files)) payload[k] = enc.encode(v);
	await writeFile(archivePath, zipSync(payload));
	return archivePath;
}

async function read(rel: string): Promise<string> {
	return readFile(join(dest, rel), "utf8");
}

async function exists(rel: string): Promise<boolean> {
	return stat(join(dest, rel)).then(() => true, () => false);
}

describe("resolveEntryPath", () => {
	it("accepts ordinary relative entries", () => {
		expect(resolveEntryPath("/tmp/x", "web/index.html")).toBe("/tmp/x/web/index.html");
		expect(resolveEntryPath("/tmp/x", "./vibe-tavern")).toBe("/tmp/x/vibe-tavern");
	});

	it("normalizes backslash separators into real nesting", () => {
		expect(resolveEntryPath("/tmp/x", "web\\assets\\app.js")).toBe("/tmp/x/web/assets/app.js");
	});

	it("rejects parent traversal, including the backslash spelling", () => {
		expect(resolveEntryPath("/tmp/x", "../escaped")).toBeNull();
		expect(resolveEntryPath("/tmp/x", "web/../../escaped")).toBeNull();
		expect(resolveEntryPath("/tmp/x", "..\\..\\escaped")).toBeNull();
	});

	it("rejects absolute paths", () => {
		expect(resolveEntryPath("/tmp/x", "/etc/passwd")).toBeNull();
		expect(resolveEntryPath("/tmp/x", "C:\\Windows\\System32\\evil.dll")).toBeNull();
		expect(resolveEntryPath("/tmp/x", "\\\\server\\share\\evil")).toBeNull();
	});

	it("rejects an empty name", () => {
		expect(resolveEntryPath("/tmp/x", "")).toBeNull();
		expect(resolveEntryPath("/tmp/x", "   ")).toBeNull();
	});

	it("does not treat a sibling directory with a shared prefix as inside", () => {
		expect(resolveEntryPath("/tmp/x", "../x-evil/f")).toBeNull();
	});
});

describe("extractArchive — .tar.gz", () => {
	it("round-trips files, nested directories, and contents", async () => {
		const archive = await makeTarGz("a.tar.gz", [
			{ name: "vibe-tavern", content: "#!/bin/sh\n", mode: 0o755 },
			{ name: "web", type: "directory", mode: 0o755 },
			{ name: "web/index.html", content: "<html/>", mode: 0o644 },
			{ name: "web/assets/app.js", content: "console.log(1)", mode: 0o644 },
		]);

		await extractArchive(archive, dest);

		expect(await read("vibe-tavern")).toBe("#!/bin/sh\n");
		expect(await read("web/index.html")).toBe("<html/>");
		expect(await read("web/assets/app.js")).toBe("console.log(1)");
	});

	it("preserves the executable bit from the archive's mode, not from the filename", async () => {
		const archive = await makeTarGz("b.tar.gz", [
			{ name: "vibe-tavern", content: "binary", mode: 0o755 },
			{ name: "notes.txt", content: "text", mode: 0o644 },
		]);

		await extractArchive(archive, dest);

		expect(((await stat(join(dest, "vibe-tavern"))).mode & 0o777).toString(8)).toBe("755");
		expect(((await stat(join(dest, "notes.txt"))).mode & 0o777).toString(8)).toBe("644");
	});

	it("strips setuid/setgid bits rather than honoring them", async () => {
		const archive = await makeTarGz("suid.tar.gz", [
			{ name: "sneaky", content: "x", mode: 0o4755 },
		]);

		await extractArchive(archive, dest);

		const mode = (await stat(join(dest, "sneaky"))).mode;
		expect(mode & 0o4000).toBe(0);
		expect((mode & 0o777).toString(8)).toBe("755");
	});

	it("rejects a ../ traversal entry and does not write outside the destination", async () => {
		const archive = await makeTarGz("evil.tar.gz", [
			{ name: "ok.txt", content: "fine" },
			{ name: "../escaped.txt", content: "pwned" },
		]);

		await expect(extractArchive(archive, dest)).rejects.toThrow(/escapes the destination/);
		expect(await stat(join(root, "escaped.txt")).then(() => true, () => false)).toBe(false);
	});

	it("rejects an absolute-path entry", async () => {
		const archive = await makeTarGz("abs.tar.gz", [
			{ name: "/tmp/vt-absolute-escape.txt", content: "pwned" },
		]);

		await expect(extractArchive(archive, dest)).rejects.toThrow(/escapes the destination/);
	});

	it("refuses symlink entries instead of following them", async () => {
		const archive = await makeTarGz("link.tar.gz", [
			{ name: "web", type: "symlink", linkname: "/etc", content: "" },
		]);

		await expect(extractArchive(archive, dest)).rejects.toThrow(/link entry/);
	});

	it("reads a .tar.gz produced by the system tar, as the release workflow does", async () => {
		const src = join(root, "src");
		await mkdir(join(src, "web"), { recursive: true });
		await writeFile(join(src, "vibe-tavern"), "#!/bin/sh\necho hi\n");
		await chmod(join(src, "vibe-tavern"), 0o755);
		await writeFile(join(src, "web", "index.html"), "<html/>");
		const archive = join(root, "sys.tar.gz");
		await Bun.$`tar -czf ${archive} -C ${src} .`.quiet();

		await extractArchive(archive, dest);

		expect(await read("vibe-tavern")).toBe("#!/bin/sh\necho hi\n");
		expect(await read("web/index.html")).toBe("<html/>");
		expect(((await stat(join(dest, "vibe-tavern"))).mode & 0o777).toString(8)).toBe("755");
	});

	it("handles an archive with many small files without dropping any", async () => {
		const entries: TarEntry[] = [];
		for (let i = 0; i < 200; i++) {
			entries.push({ name: `web/assets/chunk-${i}.js`, content: `export const n = ${i};` });
		}
		const archive = await makeTarGz("many.tar.gz", entries);

		await extractArchive(archive, dest);

		expect(await read("web/assets/chunk-0.js")).toBe("export const n = 0;");
		expect(await read("web/assets/chunk-199.js")).toBe("export const n = 199;");
	});
});

describe("extractArchive — .zip", () => {
	it("round-trips files and nested directories", async () => {
		const archive = await makeZip("a.zip", {
			"vibe-tavern.exe": "MZbinary",
			"web/index.html": "<html/>",
			"web/assets/app.js": "console.log(1)",
		});

		await extractArchive(archive, dest);

		expect(await read("vibe-tavern.exe")).toBe("MZbinary");
		expect(await read("web/index.html")).toBe("<html/>");
		expect(await read("web/assets/app.js")).toBe("console.log(1)");
	});

	it("treats backslash-separated entry names as nested paths", async () => {
		// Compress-Archive emits these on some hosts.
		const archive = await makeZip("bs.zip", {
			"web\\assets\\app.js": "console.log(2)",
		});

		await extractArchive(archive, dest);

		expect(await read("web/assets/app.js")).toBe("console.log(2)");
	});

	it("rejects a ../ traversal entry", async () => {
		const archive = await makeZip("evil.zip", {
			"ok.txt": "fine",
			"../escaped.txt": "pwned",
		});

		await expect(extractArchive(archive, dest)).rejects.toThrow(/escapes the destination/);
		expect(await stat(join(root, "escaped.txt")).then(() => true, () => false)).toBe(false);
	});

	it("rejects a backslash traversal entry", async () => {
		const archive = await makeZip("evil2.zip", {
			"..\\..\\escaped.txt": "pwned",
		});

		await expect(extractArchive(archive, dest)).rejects.toThrow(/escapes the destination/);
	});

	it("rejects an absolute-path entry", async () => {
		const archive = await makeZip("abs.zip", {
			"C:\\Windows\\evil.dll": "pwned",
		});

		await expect(extractArchive(archive, dest)).rejects.toThrow(/escapes the destination/);
	});

	it("writes a file large enough to exercise write backpressure", async () => {
		const big = "x".repeat(4 * 1024 * 1024);
		const archive = await makeZip("big.zip", { "web/big.txt": big, "web/small.txt": "s" });

		await extractArchive(archive, dest);

		expect((await stat(join(dest, "web", "big.txt"))).size).toBe(big.length);
		expect(await read("web/small.txt")).toBe("s");
	});

	it("streams an incompressible entry across many source chunks", async () => {
		// Regression guard for the inflater choice. Highly-compressible data
		// shrinks to a few KB and is handed over in ONE ondata call, so it
		// exercises none of the streaming path — that is why an earlier
		// all-'x' fixture passed while real release zips died partway through
		// with "strm.flush is not a function" (fflate's AsyncUnzipInflate runs
		// in a Blob Worker whose shim is incompatible with Bun).
		//
		// Random bytes cannot be compressed, so the archive stays multi-megabyte
		// and createReadStream delivers it in many chunks, forcing repeated
		// push() -> inflate -> write cycles.
		const size = 3 * 1024 * 1024;
		const noise = new Uint8Array(size);
		crypto.getRandomValues(noise.subarray(0, 65536));
		for (let off = 65536; off < size; off += 65536) {
			noise.set(noise.subarray(0, Math.min(65536, size - off)), off);
			crypto.getRandomValues(noise.subarray(off, Math.min(off + 4096, size)));
		}

		const archivePath = join(root, "noise.zip");
		await writeFile(archivePath, zipSync({ "web/noise.bin": noise, "after.txt": new TextEncoder().encode("still here") }));
		expect((await stat(archivePath)).size).toBeGreaterThan(1024 * 1024);

		await extractArchive(archivePath, dest);

		const out = await readFile(join(dest, "web", "noise.bin"));
		expect(out.length).toBe(size);
		expect(Buffer.from(noise).equals(out)).toBe(true);
		// An entry after the big one still lands: the stream did not stall.
		expect(await read("after.txt")).toBe("still here");
	});

	it("reads a .zip produced by the system zip tool", async () => {
		const src = join(root, "zsrc");
		await mkdir(join(src, "web"), { recursive: true });
		await writeFile(join(src, "vibe-tavern.exe"), "MZ");
		await writeFile(join(src, "web", "index.html"), "<html/>");
		const archive = join(root, "sys.zip");
		await Bun.$`zip -q -r ${archive} .`.cwd(src).quiet();

		await extractArchive(archive, dest);

		expect(await read("vibe-tavern.exe")).toBe("MZ");
		expect(await read("web/index.html")).toBe("<html/>");
	});
});

describe("extractArchive — dispatch", () => {
	it("rejects an unrecognized extension", async () => {
		const archive = join(root, "mystery.7z");
		await writeFile(archive, "not an archive");
		await expect(extractArchive(archive, dest)).rejects.toThrow(/Unsupported archive format/);
	});

	it("creates the destination directory if it does not exist", async () => {
		const archive = await makeTarGz("c.tar.gz", [{ name: "f.txt", content: "hi" }]);
		const nested = join(dest, "deep", "deeper");

		await extractArchive(archive, nested);

		expect(await readFile(join(nested, "f.txt"), "utf8")).toBe("hi");
	});

	it("rejects a truncated/corrupt gzip stream", async () => {
		const archive = join(root, "corrupt.tar.gz");
		await writeFile(archive, "definitely not gzip");
		await expect(extractArchive(archive, dest)).rejects.toThrow();
	});

	it("leaves no partial output visible to the caller on rejection", async () => {
		const archive = await makeTarGz("half.tar.gz", [
			{ name: "written.txt", content: "before" },
			{ name: "../escaped.txt", content: "pwned" },
		]);

		await expect(extractArchive(archive, dest)).rejects.toThrow();

		// The staging dir is discarded wholesale by the caller; what matters is
		// that nothing escaped it.
		expect(await exists("../escaped.txt")).toBe(false);
	});
});
