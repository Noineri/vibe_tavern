/**
 * Single source of truth for how every shipped server binary is compiled.
 *
 * Four release channels compile the same standalone entrypoint — the local
 * standalone build, the Windows/Linux distributions, and the Android native
 * server — and they must agree on the compile options. Two of them go through
 * the Bun.build API, two through the CLI, so the shared settings exist in both
 * shapes; nothing channel-specific lives here.
 *
 * `bytecode` precompiles the bundle to AOT bytecode: measured on the real
 * entrypoint (Bun 1.4.2, 30 runs), the binary starts in 46ms median instead of
 * 147ms. `format: "esm"` is load-bearing next to it: with the default CJS
 * output, bytecode rejects top-level await, so one TLA anywhere in the
 * dependency graph would fail the whole build. Bytecode depth is left at the
 * default — measured, depth 0/1 give back half the startup win (91ms/71ms) to
 * save only a third of the bytecode size.
 */

/** Options object spread into `Bun.build()` (standalone, windows-dist). */
export const serverCompileBuildOptions = {
	target: "bun",
	minify: true,
	bytecode: true,
	format: "esm",
} as const;

/** Equivalent CLI flags spliced into the `bun build --compile` argv
 *  (linux-dist, android-native). */
export const SERVER_COMPILE_CLI_FLAGS = ["--bytecode", "--format=esm"] as const;
