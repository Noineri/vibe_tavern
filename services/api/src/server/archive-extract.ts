/**
 * In-process release-archive extraction.
 *
 * The updater must never depend on a tool being present on the user's machine.
 * Shelling out to `tar` broke Windows installs in the wild (tar.exe only ships
 * on Windows 10 17063+ and is stripped from some managed images), and the
 * PowerShell fallback that replaced it was itself removed. Both formats are
 * therefore read by this process, streaming, with no external command.
 *
 * `.tar.gz` — node:zlib's native gunzip into `tar-stream`.
 * `.zip`    — fflate's streaming `Unzip` + `UnzipInflate` (see extractZip for
 *             why the synchronous inflater and not the async one).
 *
 * Both are streamed to disk entry by entry, so peak memory is a few buffers
 * regardless of archive size. Measured against the real artifacts: the 65 MB
 * linux tarball extracts 192 MB across 115 files for +37 MB RSS, and the 79 MB
 * windows zip extracts 215 MB across 108 files for +31 MB RSS.
 *
 * Hostile-archive handling is the same on both paths: entry names are
 * normalized, absolute paths and anything escaping the destination are
 * rejected, and link entries are refused outright rather than followed.
 */

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { extract, type Headers as TarHeaders } from "tar-stream";

/** Thrown for anything the archive itself is at fault for. */
export class ArchiveExtractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveExtractError";
	}
}

/**
 * Extract `archivePath` into `destDir`, dispatching on the file extension.
 * `destDir` is created if it does not exist.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const lower = archivePath.toLowerCase();
	if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
		await extractTarGz(archivePath, destDir);
		return;
	}
	if (lower.endsWith(".zip")) {
		await extractZip(archivePath, destDir);
		return;
	}
	throw new ArchiveExtractError(`Unsupported archive format: ${archivePath}`);
}

// ─── Path safety ────────────────────────────────────────────────────────────

/**
 * Resolve an archive entry name to an absolute path inside `destDir`, or null
 * if the entry is not safe to write.
 *
 * Backslashes are normalized first because `Compress-Archive` emits them as
 * separators on some hosts — without that, `web\index.html` would be treated
 * as a single filename containing backslashes rather than a nested path, and a
 * `..\..\` traversal would sail straight past a forward-slash-only check.
 */
export function resolveEntryPath(destDir: string, rawName: string): string | null {
	const normalized = rawName.replace(/\\/g, "/").trim();
	if (normalized.length === 0) return null;
	// POSIX-absolute, or a Windows drive letter that survived normalization.
	if (isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) return null;
	// A UNC path also starts with separators, which the normalization above
	// turns into leading slashes; isAbsolute catches those on POSIX too.
	if (normalized.startsWith("/")) return null;

	const root = resolve(destDir);
	const full = resolve(root, normalized);
	if (full !== root && !full.startsWith(root + sep)) return null;
	return full;
}

function unsafeEntry(name: string): ArchiveExtractError {
	return new ArchiveExtractError(`Refusing archive entry that escapes the destination: ${name}`);
}

// ─── tar.gz ─────────────────────────────────────────────────────────────────

/** Strip setuid/setgid/sticky; keep only the permission bits we intend to set. */
function safeMode(mode: number | undefined, fallback: number): number {
	if (mode === undefined || !Number.isFinite(mode)) return fallback;
	return mode & 0o777;
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	const tar = extract();

	tar.on("entry", (header: TarHeaders, stream: Readable, next: () => void) => {
		void handleTarEntry(header, stream, destDir).then(
			() => next(),
			(err: unknown) => {
				// Drain so the underlying stream is not left half-read, then tear
				// the extractor down so `pipeline` below rejects with this error.
				stream.resume();
				tar.destroy(err instanceof Error ? err : new ArchiveExtractError(String(err)));
			},
		);
	});

	await pipeline(createReadStream(archivePath), createGunzip(), tar);
}

async function handleTarEntry(header: TarHeaders, stream: Readable, destDir: string): Promise<void> {
	const name = header.name;
	const type = header.type;

	if (type === "symlink" || type === "link") {
		// Never recreate links: a symlink pointing outside the destination turns
		// every later entry written "through" it into an arbitrary-file write.
		await drain(stream);
		throw new ArchiveExtractError(`Refusing link entry in release archive: ${name}`);
	}

	const target = resolveEntryPath(destDir, name);
	if (target === null) {
		await drain(stream);
		throw unsafeEntry(name);
	}

	if (type === "directory") {
		await drain(stream);
		await mkdir(target, { recursive: true });
		return;
	}

	if (type !== "file" && type !== undefined) {
		// Character/block devices, FIFOs — nothing a release archive should carry.
		await drain(stream);
		throw new ArchiveExtractError(`Refusing ${type} entry in release archive: ${name}`);
	}

	await mkdir(dirname(target), { recursive: true });
	// header.mode carries the real permission bits, so the binary's exec bit is
	// restored by honoring the archive rather than by special-casing a filename.
	await pipeline(stream, createWriteStream(target, { mode: safeMode(header.mode, 0o644) }));
}

/** Consume an entry stream to completion — tar-stream stalls otherwise. */
function drain(stream: Readable): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		stream.on("end", resolvePromise);
		stream.on("error", reject);
		stream.resume();
	});
}

// ─── zip ────────────────────────────────────────────────────────────────────

async function extractZip(archivePath: string, destDir: string): Promise<void> {
	const unzip = new Unzip();
	// UnzipInflate, NOT AsyncUnzipInflate: fflate's async inflater runs in a
	// Web Worker built from a Blob, and its worker shim calls `strm.flush`,
	// which does not exist under Bun — extraction dies with "strm.flush is not
	// a function" partway through. Small archives never reach the worker path,
	// so this only shows up on real release-sized zips.
	//
	// The synchronous inflater keeps everything on this thread and delivers
	// entries during `push()`. Memory stays bounded either way because each
	// chunk is written straight to disk as it arrives.
	unzip.register(UnzipInflate);

	const source = createReadStream(archivePath);
	const entries: Array<Promise<void>> = [];
	let failure: Error | null = null;

	const fail = (err: Error): void => {
		failure ??= err;
		source.destroy();
	};

	// fflate can have several inflations in flight, so backpressure is tracked
	// across all of them: while any write stream is saturated, stop feeding.
	//
	// Each sink holds the source AT MOST once and must release it on ANY
	// terminal outcome, not just on "drain". fflate often hands over a whole
	// entry in a single ondata call, so `write()` returns false and `end()` is
	// called in the same tick — the stream then finishes without ever emitting
	// "drain", and a drain-only release would leave the source paused forever.
	let saturated = 0;
	const makeBackpressureHandle = (): { hold: () => void; release: () => void } => {
		let held = false;
		return {
			hold: () => {
				if (held) return;
				held = true;
				saturated += 1;
				source.pause();
			},
			release: () => {
				if (!held) return;
				held = false;
				saturated -= 1;
				if (saturated <= 0) source.resume();
			},
		};
	};

	unzip.onfile = (file) => {
		if (failure) return;
		const name = file.name;

		// fflate reports directories as zero-length entries whose name ends in a
		// separator; it does not surface Unix mode bits at all, which is fine —
		// the .zip is the Windows-only asset and Windows has no exec bit.
		if (name.endsWith("/") || name.endsWith("\\")) {
			const dir = resolveEntryPath(destDir, name);
			if (dir === null) {
				fail(unsafeEntry(name));
				return;
			}
			entries.push(mkdir(dir, { recursive: true }).then(() => undefined));
			return;
		}

		const target = resolveEntryPath(destDir, name);
		if (target === null) {
			fail(unsafeEntry(name));
			return;
		}

		// Synchronous so `ondata`/`start()` are wired before control returns to
		// fflate; the directory count is small and this keeps entry ordering
		// impossible to get wrong.
		try {
			mkdirSync(dirname(target), { recursive: true });
		} catch (err) {
			fail(err instanceof Error ? err : new ArchiveExtractError(String(err)));
			return;
		}

		const sink = createWriteStream(target);
		const backpressure = makeBackpressureHandle();
		entries.push(
			new Promise<void>((resolvePromise, reject) => {
				sink.on("error", (err) => {
					backpressure.release();
					reject(err);
				});
				file.ondata = (err, chunk, final) => {
					if (err) {
						backpressure.release();
						sink.destroy();
						reject(err);
						return;
					}
					if (chunk.length > 0 && !sink.write(chunk)) {
						backpressure.hold();
						sink.once("drain", backpressure.release);
					}
					if (final) {
						sink.end(() => {
							backpressure.release();
							resolvePromise();
						});
					}
				};
				file.start();
			}),
		);
	};

	await new Promise<void>((resolvePromise, reject) => {
		source.on("data", (chunk: Buffer) => {
			// Copy: Buffer memory is pooled and fflate keeps the reference.
			try {
				unzip.push(Uint8Array.from(chunk));
			} catch (err) {
				fail(err instanceof Error ? err : new ArchiveExtractError(String(err)));
			}
		});
		source.on("error", (err) => reject(failure ?? err));
		source.on("close", () => {
			if (failure) {
				reject(failure);
				return;
			}
			try {
				// Final empty push tells fflate the stream is complete.
				unzip.push(new Uint8Array(0), true);
			} catch (err) {
				reject(err instanceof Error ? err : new ArchiveExtractError(String(err)));
				return;
			}
			resolvePromise();
		});
	});

	await Promise.all(entries);
	if (failure) throw failure;
}
