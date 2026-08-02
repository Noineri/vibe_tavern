/**
 * The shutdown-hook seam the updater uses to release the port (and now to await
 * transport teardown) before it exits.
 *
 * This lives in its own leaf module for a structural reason worth pinning:
 * importing server-runtime.ts from update-orchestrator.ts closes the loop
 *   app-factory -> routes/runtime -> update-orchestrator -> server-runtime
 *     -> app-factory
 * and that cycle collapses Hono's AppType inference, which surfaces as
 * `Argument of type '"remoteIp"' is not assignable to parameter of type
 * 'never'` in app-factory.ts. The module must therefore stay import-free.
 *
 * The hook is async-capable so a registered shutdown routine can AWAIT
 * transport teardown (e.g. closing loopback SOCKS5 bridges) before the process
 * exits; `stopRuntimeServer` awaits it.
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
	it("reports false when no server is registered", async () => {
		expect(await stopRuntimeServer()).toBe(false);
	});

	it("invokes the registered hook and reports true", async () => {
		let stopped = 0;
		setRuntimeShutdownHook(() => {
			stopped += 1;
		});

		expect(await stopRuntimeServer()).toBe(true);
		expect(stopped).toBe(1);
	});

	it("awaits an async hook before reporting true", async () => {
		let settled = false;
		setRuntimeShutdownHook(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			settled = true;
		});

		expect(await stopRuntimeServer()).toBe(true);
		// The hook's awaited microtask/setTimeout completed before reporting.
		expect(settled).toBe(true);
	});

	it("keeps only the most recently registered hook", async () => {
		const calls: string[] = [];
		setRuntimeShutdownHook(() => calls.push("first"));
		setRuntimeShutdownHook(() => calls.push("second"));

		await stopRuntimeServer();

		expect(calls).toEqual(["second"]);
	});

	it("lets a throwing hook surface rather than swallowing it", async () => {
		setRuntimeShutdownHook(() => {
			throw new Error("stop failed");
		});
		// The orchestrator wraps its own call site; the seam itself must not
		// silently pretend the server was stopped.
		await expect(stopRuntimeServer()).rejects.toThrow("stop failed");
	});

	it("surfaces a rejected async hook rather than swallowing it", async () => {
		setRuntimeShutdownHook(async () => {
			throw new Error("async stop failed");
		});
		await expect(stopRuntimeServer()).rejects.toThrow("async stop failed");
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
