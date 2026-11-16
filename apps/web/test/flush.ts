import "./dom-env.js";

// Load @testing-library/react after dom-env has evaluated (registration precedes
// RTL evaluation) while binding `act` before any test runs so `flush()` enters
// React's act scope synchronously on invocation.
const { act } = await import("@testing-library/react");

/**
 * Flush pending React state updates, effects, and macrotask-scheduled UI work
 * inside `act()` over a single 10ms timer tick.
 *
 * Unifies the per-file `flush()` / `settle()` / 10ms poll helpers that were
 * duplicated across `apps/web` tests (FW-9).
 */
export async function flush(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	});
}
