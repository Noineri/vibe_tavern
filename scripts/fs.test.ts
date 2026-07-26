import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "./_fs.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-path-exists-"));
	temporaryRoots.push(root);
	return root;
}

describe("pathExists", () => {
	test("returns true for a regular file", async () => {
		// Given
		const root = await makeRoot();
		const filePath = join(root, "file.txt");
		await Bun.write(filePath, "hello");

		// When
		const result = await pathExists(filePath);

		// Then
		expect(result).toBe(true);
	});

	test("returns true for a directory", async () => {
		// Given
		const root = await makeRoot();
		const dirPath = join(root, "dir");
		await mkdir(dirPath);

		// When
		const result = await pathExists(dirPath);

		// Then
		expect(result).toBe(true);
	});

	test("returns true for a symlink to an existing target", async () => {
		// Given
		const root = await makeRoot();
		const targetPath = join(root, "target.txt");
		const linkPath = join(root, "target-link.txt");
		await Bun.write(targetPath, "target");
		await symlink(targetPath, linkPath);

		// When
		const result = await pathExists(linkPath);

		// Then
		expect(result).toBe(true);
	});

	test("returns false for a dangling symlink", async () => {
		// Given
		const root = await makeRoot();
		const linkPath = join(root, "dangling-link.txt");
		await symlink(join(root, "missing-target.txt"), linkPath);

		// When
		const result = await pathExists(linkPath);

		// Then
		expect(result).toBe(false);
	});

	test("returns false for a missing path", async () => {
		// Given
		const root = await makeRoot();
		const missingPath = join(root, "missing.txt");

		// When
		const result = await pathExists(missingPath);

		// Then
		expect(result).toBe(false);
	});

	// chmod(0o000) is a no-op on Windows (no POSIX mode bits), so the
	// permission-error path can only be exercised on POSIX platforms.
	const posixOnlyTest = process.platform === "win32" ? test.skip : test;

	posixOnlyTest("returns false when stat hits a permission error", async () => {
		// Given
		const root = await makeRoot();
		const lockedDir = join(root, "locked");
		const blockedPath = join(lockedDir, "blocked.txt");
		await mkdir(lockedDir);
		await Bun.write(blockedPath, "locked");
		await chmod(lockedDir, 0o000);

		try {
			// When
			const result = await pathExists(blockedPath);

			// Then
			expect(result).toBe(false);
		} finally {
			await chmod(lockedDir, 0o755);
		}
	});
});
