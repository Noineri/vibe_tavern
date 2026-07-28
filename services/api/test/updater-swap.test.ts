/**
 * Characterization pins for the updater's on-disk swap.
 *
 * `performSwap` moves each top-level staging entry into the install dir, backing
 * the previous entry up first, and rolls the completed moves back if any single
 * move fails. These pins fix that contract — protected names, rollback, the
 * new-file (ENOENT-on-backup) path — before later waves change where the backups
 * live and when the "install was modified" flag is raised.
 *
 * Mid-flight failure injection, and why it looks like this:
 *   - A permissions trick on installDir itself can only break the FIRST rename,
 *     which rolls nothing back and therefore pins nothing.
 *   - `mock.module("node:fs/promises")` deadlocks the runner on the pinned Bun
 *     (hangs with no output), so wrapping `rename` is not an option.
 *   - What works, per entry and purely on-disk: renaming a DIRECTORY requires
 *     write permission on that directory (its ".." entry has to be rewritten),
 *     so a mode-0555 directory in the install dir fails its backup rename with
 *     EACCES while every sibling entry swaps normally. readdir order is not
 *     guaranteed, so the target is whichever name the loop visits last.
 *
 * Everything runs against a real temp dir; nothing here touches a real install.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupOldInstall, performSwap } from "../src/server/updater.js";

let root = "";
let installDir = "";
let stagingDir = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-swap-"));
	installDir = join(root, "install");
	stagingDir = join(root, "staging");
	await mkdir(installDir, { recursive: true });
	await mkdir(stagingDir, { recursive: true });
});

afterEach(async () => {
	// Re-open anything the failure injection locked down so rm can clean up.
	for (const name of await readdir(installDir).catch(() => [])) {
		await chmod(join(installDir, name), 0o755).catch(() => undefined);
	}
	await rm(root, { recursive: true, force: true });
});

async function write(dir: string, rel: string, contents: string): Promise<void> {
	const full = join(dir, rel);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, contents);
}

async function read(dir: string, rel: string): Promise<string> {
	return readFile(join(dir, rel), "utf8");
}

async function exists(p: string): Promise<boolean> {
	return stat(p).then(() => true, () => false);
}

/**
 * Make the backup of whichever entry `performSwap` visits last fail with
 * EACCES, leaving all earlier entries to swap successfully.
 * The entry must already exist in the install dir as a directory.
 * Returns the sabotaged entry name.
 */
async function sabotageLastEntry(): Promise<string> {
	const entries = await readdir(stagingDir);
	const target = entries[entries.length - 1];
	if (target === undefined) throw new Error("staging dir is empty");
	await chmod(join(installDir, target), 0o555);
	return target;
}

/** The single `.old-<epoch>/` directory performSwap allocated for this attempt. */
async function backupDir(): Promise<string> {
	const found = (await readdir(installDir)).filter((n) => n.startsWith(".old-"));
	expect(found).toHaveLength(1);
	return join(installDir, found[0] ?? "");
}

describe("performSwap — happy path", () => {
	it("replaces install entries with staging entries and backs the originals up", async () => {
		await write(installDir, "vibe-tavern", "OLD BINARY");
		await write(installDir, "web/index.html", "<old/>");
		await write(stagingDir, "vibe-tavern", "NEW BINARY");
		await write(stagingDir, "web/index.html", "<new/>");

		const backup = await performSwap(installDir, stagingDir);

		expect(await read(installDir, "vibe-tavern")).toBe("NEW BINARY");
		expect(await read(installDir, "web/index.html")).toBe("<new/>");
		expect(await read(backup, "vibe-tavern")).toBe("OLD BINARY");
		expect(await read(backup, "web/index.html")).toBe("<old/>");
	});

	it("returns the backup directory it allocated, named .old-<epoch>", async () => {
		await write(installDir, "vibe-tavern", "OLD");
		await write(stagingDir, "vibe-tavern", "NEW");

		const backup = await performSwap(installDir, stagingDir);

		expect(backup).toBe(await backupDir());
		expect(join(backup, "..")).toBe(installDir);
		expect(/^\.old-\d+$/.test(backup.slice(installDir.length + 1))).toBe(true);
	});

	it("moves in a brand-new release file that has no counterpart to back up", async () => {
		await write(installDir, "vibe-tavern", "OLD");
		await write(stagingDir, "vibe-tavern", "NEW");
		await write(stagingDir, "LICENSE.txt", "MIT");

		const backup = await performSwap(installDir, stagingDir);

		expect(await read(installDir, "LICENSE.txt")).toBe("MIT");
		expect(await exists(join(backup, "LICENSE.txt"))).toBe(false);
	});

	it("leaves an install entry that the release does not ship completely alone", async () => {
		await write(installDir, "vibe-tavern", "OLD");
		await write(installDir, "user-notes.txt", "keep me");
		await write(stagingDir, "vibe-tavern", "NEW");

		await performSwap(installDir, stagingDir);

		expect(await read(installDir, "user-notes.txt")).toBe("keep me");
	});
});

describe("performSwap — protected names", () => {
	it("never moves data/, logs/, .old/ or .next/ out of the install dir", async () => {
		await write(installDir, "data/vibe-tavern.db", "USER DATA");
		await write(installDir, "logs/server.log", "LOG LINE");
		await write(installDir, "vibe-tavern", "OLD");
		// A malformed release that ships these names must not win.
		await write(stagingDir, "data/vibe-tavern.db", "EVIL");
		await write(stagingDir, "logs/server.log", "EVIL");
		await write(stagingDir, ".next/x", "EVIL");
		await write(stagingDir, ".old/x", "EVIL");
		await write(stagingDir, "vibe-tavern", "NEW");

		await performSwap(installDir, stagingDir);

		expect(await read(installDir, "data/vibe-tavern.db")).toBe("USER DATA");
		expect(await read(installDir, "logs/server.log")).toBe("LOG LINE");
		expect(await read(installDir, "vibe-tavern")).toBe("NEW");
		// The protected staging entries were skipped entirely, not consumed.
		expect(await read(stagingDir, "data/vibe-tavern.db")).toBe("EVIL");
	});
});

describe("performSwap — rollback", () => {
	it("restores every already-completed move when a later move fails, and rethrows", async () => {
		const names = ["alpha", "bravo", "charlie", "delta"];
		for (const n of names) {
			await write(installDir, `${n}/file`, `OLD ${n}`);
			await write(stagingDir, `${n}/file`, `NEW ${n}`);
		}
		await sabotageLastEntry();

		await expect(performSwap(installDir, stagingDir)).rejects.toThrow();

		// Every entry is back to its pre-swap contents — including the ones that
		// had already been swapped in before the failure hit.
		for (const n of names) {
			expect(await read(installDir, `${n}/file`)).toBe(`OLD ${n}`);
		}
	});

	it("leaves the install untouched when the very first backup fails (nothing to roll back)", async () => {
		// This is the shape that downloadAndSwap currently mis-classifies as
		// fatal: no rename ever landed, so the install is provably intact.
		await write(installDir, "solo/file", "OLD solo");
		await write(stagingDir, "solo/file", "NEW solo");
		await sabotageLastEntry();

		await expect(performSwap(installDir, stagingDir)).rejects.toThrow();

		expect(await read(installDir, "solo/file")).toBe("OLD solo");
	});
});

describe("performSwap — backup isolation", () => {
	it("leaves an earlier backup generation intact and allocates a fresh one", async () => {
		// The previous design reused a single `.old/` and wiped it first, so a
		// backup that could not be deleted (a Windows lock on the old .exe)
		// either aborted the swap or let it rename into a non-empty directory.
		await write(installDir, ".old-1700000000000/vibe-tavern", "TWO UPDATES AGO");
		await write(installDir, "vibe-tavern", "OLD");
		await write(stagingDir, "vibe-tavern", "NEW");

		const backup = await performSwap(installDir, stagingDir);

		expect(backup).not.toBe(join(installDir, ".old-1700000000000"));
		expect(await read(installDir, ".old-1700000000000/vibe-tavern")).toBe("TWO UPDATES AGO");
		expect(await read(backup, "vibe-tavern")).toBe("OLD");
		expect(await read(installDir, "vibe-tavern")).toBe("NEW");
	});

	it("is unaffected by a leftover backup whose contents cannot be deleted", async () => {
		const locked = join(installDir, ".old-1700000000001");
		await mkdir(locked, { recursive: true });
		await writeFile(join(locked, "vibe-tavern"), "LOCKED");
		await chmod(locked, 0o555);
		await write(installDir, "vibe-tavern", "OLD");
		await write(stagingDir, "vibe-tavern", "NEW");

		const backup = await performSwap(installDir, stagingDir);

		expect(await read(installDir, "vibe-tavern")).toBe("NEW");
		expect(await read(backup, "vibe-tavern")).toBe("OLD");
	});

	it("never treats a backup directory in staging as something to install", async () => {
		await write(installDir, "vibe-tavern", "OLD");
		await write(stagingDir, "vibe-tavern", "NEW");
		await write(stagingDir, ".old-1700000000002/evil", "EVIL");

		await performSwap(installDir, stagingDir);

		expect(await exists(join(installDir, ".old-1700000000002", "evil"))).toBe(false);
	});
});

describe("cleanupOldInstall", () => {
	it("removes the legacy .old/ when present", async () => {
		await write(installDir, ".old/vibe-tavern", "OLD");
		await cleanupOldInstall(installDir);
		expect(await exists(join(installDir, ".old"))).toBe(false);
	});

	it("removes every .old-<epoch>/ generation", async () => {
		await write(installDir, ".old-1700000000000/vibe-tavern", "GEN 1");
		await write(installDir, ".old-1700000000001/vibe-tavern", "GEN 2");
		await write(installDir, ".old/vibe-tavern", "LEGACY");

		await cleanupOldInstall(installDir);

		expect(await exists(join(installDir, ".old-1700000000000"))).toBe(false);
		expect(await exists(join(installDir, ".old-1700000000001"))).toBe(false);
		expect(await exists(join(installDir, ".old"))).toBe(false);
	});

	it("keeps sweeping the other generations when one is locked", async () => {
		const locked = join(installDir, ".old-1700000000000");
		await mkdir(locked, { recursive: true });
		await writeFile(join(locked, "vibe-tavern"), "LOCKED");
		await chmod(locked, 0o555);
		await write(installDir, ".old-1700000000001/vibe-tavern", "SWEEPABLE");

		await cleanupOldInstall(installDir);

		expect(await exists(locked)).toBe(true);
		expect(await exists(join(installDir, ".old-1700000000001"))).toBe(false);
	});

	it("is a silent no-op when no backup exists", async () => {
		await cleanupOldInstall(installDir);
		expect(await exists(join(installDir, ".old"))).toBe(false);
	});

	it("never touches data/ or logs/", async () => {
		await write(installDir, ".old/x", "OLD");
		await write(installDir, "data/vibe-tavern.db", "USER DATA");
		await write(installDir, "logs/server.log", "LOG");

		await cleanupOldInstall(installDir);

		expect(await read(installDir, "data/vibe-tavern.db")).toBe("USER DATA");
		expect(await read(installDir, "logs/server.log")).toBe("LOG");
	});
});
