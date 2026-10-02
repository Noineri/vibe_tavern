import { expect, test } from "bun:test";
import { SERVER_COMPILE_CLI_FLAGS, serverCompileBuildOptions } from "./_server-compile.js";

test("every shipped server binary compiles with AOT bytecode as ESM", () => {
	// Bytecode is what makes a compiled server start fast (measured on the
	// real standalone entry: 147ms median cold start without it, 46ms with).
	// ESM is not optional next to it: with Bun's default CJS output, bytecode
	// rejects top-level await ("await" can only be used inside an "async"
	// function), so one TLA anywhere in the dependency graph would break every
	// channel that compiles. The same entry with format "esm" compiles and
	// runs. Both facts pinned by probe on Bun 1.4.2.
	expect(serverCompileBuildOptions).toMatchObject({
		target: "bun",
		minify: true,
		bytecode: true,
		format: "esm",
	});
	expect(SERVER_COMPILE_CLI_FLAGS).toContain("--bytecode");
	expect(SERVER_COMPILE_CLI_FLAGS).toContain("--format=esm");
});

test("keeps the default bytecode depth instead of truncating it", () => {
	// Measured on the real standalone entry (30 runs each): default depth
	// starts in 46ms median, depth 1 in 71ms, depth 0 in 91ms, no bytecode in
	// 147ms — the truncated depths hand back half the startup win to shave a
	// third of the bytecode size. Startup is user-visible on every launch;
	// binary size is downloaded once.
	expect(SERVER_COMPILE_CLI_FLAGS).not.toContain("--bytecode-depth");
	expect("bytecodeDepth" in serverCompileBuildOptions).toBe(false);
});
