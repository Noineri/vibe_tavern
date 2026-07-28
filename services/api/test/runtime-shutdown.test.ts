/**
 * The shutdown-hook seam the updater uses to release the port before it
 * respawns the new binary.
 *
 * This lives in its own leaf module for a structural reason worth pinning:
 * importing server-runtime.ts from update-orchestrator.ts closes the loop
 *   app-factory -> routes/runtime -> update-orchestrator -> server-runtime
 *     -> app-factory
 * and that cycle collapses Hono's AppType inference, which surfaces as
 * `Argument of type '"remoteIp"' is not assignable to parameter of type
 * 'never'` in app-factory.ts. The module must therefore stay import-free.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
	clearRuntimeShutdownHook,
	setRuntimeShutdownHook,
	stopRuntimeServer,
} from "../src/server/runtime-shutdown.js";

afterEach(() => {
	clearRuntimeShutdownHook();
});

describe("runtime shutdown hook", () => {
	it("reports false when no server is registered", () => {
		expect(stopRuntimeServer()).toBe(false);
	});

	it("invokes the registered hook and reports true", () => {
		let stopped = 0;
		setRuntimeShutdownHook(() => {
			stopped += 1;
		});

		expect(stopRuntimeServer()).toBe(true);
		expect(stopped).toBe(1);
	});

	it("keeps only the most recently registered hook", () => {
		const calls: string[] = [];
		setRuntimeShutdownHook(() => calls.push("first"));
		setRuntimeShutdownHook(() => calls.push("second"));

		stopRuntimeServer();

		expect(calls).toEqual(["second"]);
	});

	it("lets a throwing hook surface rather than swallowing it", () => {
		setRuntimeShutdownHook(() => {
			throw new Error("stop failed");
		});
		// The orchestrator wraps its own call site; the seam itself must not
		// silently pretend the server was stopped.
		expect(() => stopRuntimeServer()).toThrow("stop failed");
	});

	it("imports nothing, so it can never re-form the app-factory cycle", async () => {
		const source = await readFile(
			join(import.meta.dir, "..", "src", "server", "runtime-shutdown.ts"),
			"utf8",
		);
		const imports = source.match(/^\s*import\s.+$/gm) ?? [];
		expect(imports).toEqual([]);
	});
});
