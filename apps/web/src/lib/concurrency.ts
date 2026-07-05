/**
 * Minimal concurrency pool — runs an async mapper over `items` with at most
 * `concurrency` in flight, calling `onSettled(oneResult)` as each item resolves
 * (in settlement order, not input order). No p-limit dependency (15 lines, §4:
 * don't add a dep for trivial control flow).
 *
 * Between settlements the pool does NOT yield to the event loop beyond the
 * natural await points of `fn` — callers that need React to paint progress
 * should await a `scheduler.yield?.()` / setTimeout(0) inside their `onSettled`,
 * which is what ImportModals Phase 1 does so the progress bar repaints between
 * batches instead of freezing (the stop-and-go pattern seen in the user's video).
 *
 * Errors are NOT thrown: `fn` is expected to catch its own errors and encode
 * them in its return value. A throw aborts the whole pool (re-thrown to caller).
 */
export async function runPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	onSettled?: (result: R, index: number) => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	let active = 0;

	await new Promise<void>((resolve, reject) => {
		const launch = () => {
			while (active < concurrency && cursor < items.length) {
				const myIndex = cursor++;
				active++;
				fn(items[myIndex], myIndex)
					.then((r) => {
						results[myIndex] = r;
						onSettled?.(r, myIndex);
					})
					.catch(reject)
					.finally(() => {
						active--;
						if (cursor >= items.length && active === 0) resolve();
						else launch();
					});
			}
		};
		launch();
	});

	return results;
}

/**
 * Yield to the event loop so React can paint. Prefers `scheduler.yield()` when
 * available (Chromium, non-blocking), falls back to a 0ms MessageChannel task
 * (also non-blocking, faster than setTimeout). Used by ImportModals Phase 1 to
 * repaint the progress bar between import batches.
 */
export function yieldToEventLoop(): Promise<void> {
	const scheduler = globalThis.scheduler as { yield?: () => Promise<void> } | undefined;
	if (typeof scheduler?.yield === "function") return scheduler.yield();
	return new Promise((resolve) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => resolve();
		ch.port2.postMessage(undefined);
	});
}
