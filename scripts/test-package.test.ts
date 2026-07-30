import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("rejects an unknown suite through the root package command", async () => {
	// Given
	const root = resolve(import.meta.dir, "..");

	// When
	const child = Bun.spawn([process.execPath, "run", "test", "--", "missing-suite"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	// Then
	expect(exitCode).toBe(1);
	expect(`${stdout}\n${stderr}`).toContain("Unknown test suite: missing-suite");
});
