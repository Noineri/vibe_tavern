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
  /** Per-key dirty flags for `runExclusiveTrailing` — set by a call that was
   *  dropped because the lock was held, consumed by the running task before it
   *  releases (see `runExclusiveTrailing`). */
  private readonly dirty = new Set<string>();

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

  /**
   * Run `task` under `key`'s lock with **trailing-edge** semantics.
   *
   * Unlike `runExclusive` (drop-if-busy), a trigger that arrives while a task is
   * already running for `key` is not silently lost: it marks `key` dirty, and
   * the running task re-runs once before releasing the lock if dirty —
   * guaranteeing the latest event is always evaluated. Use this for
   * forward-injected background tasks (objective check, scene generate) where a
   * one-event detection lag would steer the next reply off stale state.
   * `ChatSummaryService` (retrospective — lag harmless) stays on `runExclusive`.
   *
   * Mechanics (correctness rests on JS single-threading): the dirty flag is set
   * synchronously when a call is dropped, and the running task only resumes via
   * `await` after the microtask that set dirty has landed — so the loop always
   * observes a dirty flag that was set during its in-flight run. Worst case: one
   * redundant re-run (harmless); never a missed evaluation.
   *
   * The re-run invokes the SAME `task` closure, so `task` must re-read fresh
   * state on each invocation (it must not close over a snapshot taken at
   * trigger time) — e.g. re-load the chat's recent messages inside the closure.
   *
   * Errors thrown by `task` are swallowed (background tasks must never crash the
   * event-bus caller) and forwarded to `onError`; a failed run still proceeds to
   * the dirty check, so a trigger that arrived during a failed run still causes
   * a re-run.
   *
   * Returns `true` if the task ran at least once; `false` if it was dropped
   * because the lock was already held (the in-flight run will pick up the
   * latest event via the dirty flag before it releases).
   */
  async runExclusiveTrailing(
    key: string,
    task: () => Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (this.active.has(key)) {
      this.dirty.add(key);
      return false;
    }
    this.active.add(key);
    try {
      for (;;) {
        this.dirty.delete(key);
        try {
          await task();
        } catch (err) {
          onError?.(err);
        }
        if (!this.dirty.has(key)) break;
      }
      return true;
    } finally {
      this.active.delete(key);
      this.dirty.delete(key);
    }
  }
}
