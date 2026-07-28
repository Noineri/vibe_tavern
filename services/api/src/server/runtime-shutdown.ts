/**
 * A one-slot registry for "stop serving HTTP".
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
 */

type RuntimeShutdownHook = () => void;

let shutdownHook: RuntimeShutdownHook | null = null;

/** Called by startServerRuntime once the server is bound. */
export function setRuntimeShutdownHook(hook: RuntimeShutdownHook): void {
	shutdownHook = hook;
}

/**
 * Stop the running server, dropping in-flight connections.
 * Returns false when no server was ever registered (dev/test contexts).
 */
export function stopRuntimeServer(): boolean {
	if (!shutdownHook) return false;
	shutdownHook();
	return true;
}

/** Test seam: forget any registered hook. */
export function clearRuntimeShutdownHook(): void {
	shutdownHook = null;
}
