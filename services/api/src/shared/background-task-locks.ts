// ────────────────────────────────────────────────────────────────────────────
// BackgroundTaskLocks — dedup mutex for fire-and-forget background tasks
// ────────────────────────────────────────────────────────────────────────────
// Background LLM features (chat summary, objective checks, scene tracker,
// etc.) subscribe to chat events and may trigger a long-running async task
// scoped to a chat+branch. Without dedup, overlapping triggers (e.g. two
// messages appended in quick succession) would launch the same task twice.
//
// This owns the lock set plus the error boundary so each feature avoids
// repeating the add/try/catch/finally boilerplate. Features keep their OWN
// instance — an objective run and a summary run on the same chat are
// independent and may proceed in parallel.
//
// Why atomic check-and-acquire matters: a naive `if (set.has(k)) return; ...
// set.add(k)` has `await`s between the check and the add, so two concurrent
// callers can both pass the check before either adds. runExclusive performs
// the check and the add back-to-back with no `await` in between, closing that
// race.
// ────────────────────────────────────────────────────────────────────────────

export class BackgroundTaskLocks {
  private readonly active = new Set<string>();

  /** True iff a task is currently holding this lock. */
  has(key: string): boolean {
    return this.active.has(key);
  }

  /**
   * Run `task` under `key`'s lock.
   *
   * If a task is already running for `key`, the call is skipped and returns
   * `false` (fire-and-forget semantics — the caller does not wait on the
   * in-flight run).
   *
   * Errors thrown by `task` are swallowed: background tasks must never crash
   * the event-bus caller. They are forwarded to `onError` so the feature can
   * do its own `logSendDebug`/metrics.
   *
   * Returns `true` if the task ran (whether it succeeded or failed); `false`
   * if it was skipped because the lock was already held.
   */
  async runExclusive(
    key: string,
    task: () => Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (this.active.has(key)) return false;
    this.active.add(key);
    try {
      await task();
      return true;
    } catch (err) {
      onError?.(err);
      return true;
    } finally {
      this.active.delete(key);
    }
  }
}
