/**
 * A one-slot registry for "stop serving HTTP" (and, now, drain transport-level
 * cleanup before the process exits).
 *
 * This exists as its own dependency-free module on purpose. The self-updater
 * needs to release the port before respawning the new binary, but importing
 * server-runtime.ts to get at it creates a cycle:
 *
 *   app-factory -> routes/runtime -> update-orchestrator -> server-runtime
 *     -> app-factory
 *
 * which collapses Hono's AppType inference and makes every `c.get("remoteIp")`
 * in app-factory.ts fail to typecheck. Keeping the capability in a leaf module
 * that imports nothing means both sides can depend on it without meeting.
 *
 * The hook is async-capable so a registered shutdown routine can AWAIT
 * transport teardown (e.g. closing every loopback SOCKS5 bridge) before the
 * process exits. `stopRuntimeServer` awaits the hook; callers such as the
 * updater's `shutdownAfterUpdate` await `stopRuntimeServer` in turn, so cleanup
 * is guaranteed rather than fire-and-forget ahead of a synchronous exit.
 */

type RuntimeShutdownHook = () => void | Promise<void>;

let shutdownHook: RuntimeShutdownHook | null = null;

/** Called by startServerRuntime once the server is bound. */
export function setRuntimeShutdownHook(hook: RuntimeShutdownHook): void {
	shutdownHook = hook;
}

/**
 * Stop the running server and await any registered transport teardown.
 * Returns false when no server was ever registered (dev/test contexts).
 * A throwing (or rejecting) hook surfaces through the returned promise rather
 * than being swallowed — the caller wraps its own call site.
 */
export async function stopRuntimeServer(): Promise<boolean> {
	if (!shutdownHook) return false;
	await shutdownHook();
	return true;
}

/** Test seam: forget any registered hook. */
export function clearRuntimeShutdownHook(): void {
	shutdownHook = null;
}
