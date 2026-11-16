/**
 * Drain React 19's scheduler macrotask queue over a bounded number of ticks.
 *
 * React's `commitRoot` schedules `flushPassiveEffects()` via
 * `scheduleCallback(NormalPriority)` on a `MessageChannel` macrotask (see
 * `react-dom-client.development.js` `scheduleCallback$1` in `commitRoot`).
 * RTL's `cleanup()` flushes microtasks and synchronous work via `act()`, but
 * does not drain that macrotask queue, and chained async effects can schedule
 * further macrotasks (`ticks = 5` is a safe bounded drain with no public
 * scheduler-idle signal to spin against).
 *
 * Shared by `dom-env.ts` (between-files passive-effect drain in `afterAll`,
 * bare outside `act()`) and `agent-shell-harness.ts` (`flushSessionLoad()`,
 * `act()`-wrapped mid-test) (FW-10). Keeping this helper dependency-free
 * preserves `agent-shell-harness.ts`'s no-registration co-load contract and
 * keeps `dom-env.ts` from pulling app stores into every DOM suite.
 */
export async function flushSchedulerQueue(ticks = 5): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}
