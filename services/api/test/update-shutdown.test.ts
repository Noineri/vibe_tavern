/**
 * Pins how a successful update ends: the process stops serving and exits for
 * good. It must never relaunch itself.
 *
 * The regression this guards against is concrete. An earlier revision ended the
 * update with `Bun.spawn([process.execPath], { detached: true, stdio: ignore })`.
 * On POSIX `detached` is setsid(): the replacement left the launching shell's
 * foreground process group and gave up the controlling terminal, so Ctrl+C no
 * longer stopped Vibe Tavern and the only way out was `pkill`. Windows
 * DETACHED_PROCESS orphans it the same way, minus a console.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { shutdownAfterUpdate } from "../src/domain/update/update-orchestrator.js";

const ORCHESTRATOR_SOURCE = join(
	import.meta.dir,
	"..",
	"src",
	"domain",
	"update",
	"update-orchestrator.ts",
);

describe("shutdownAfterUpdate", () => {
	it("stops the server before exiting, and exits zero", () => {
		const calls: string[] = [];

		shutdownAfterUpdate(
			() => {
				calls.push("stop");
				return true;
			},
			(code) => {
				calls.push(`exit:${code}`);
			},
		);

		expect(calls).toEqual(["stop", "exit:0"]);
	});

	it("still exits when no server was registered to stop", () => {
		let exitCode: number | null = null;

		shutdownAfterUpdate(
			() => false,
			(code) => {
				exitCode = code;
			},
		);

		expect(exitCode).toBe(0);
	});

	it("still exits when stopping the server throws", () => {
		// A server that refuses to stop must not keep the pre-update build
		// alive on the port the user is about to relaunch into.
		let exitCode: number | null = null;

		shutdownAfterUpdate(
			() => {
				throw new Error("stop failed");
			},
			(code) => {
				exitCode = code;
			},
		);

		expect(exitCode).toBe(0);
	});
});

describe("update orchestrator process handling", () => {
	it("never spawns a replacement process", async () => {
		const source = await readFile(ORCHESTRATOR_SOURCE, "utf8");
		// Comments explain why the respawn is gone; code must not bring it back.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

		expect(code).not.toInclude("Bun.spawn");
		expect(code).not.toInclude("detached");
		expect(code).not.toInclude("execve");
	});
});
