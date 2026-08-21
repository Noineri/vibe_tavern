/**
 * Replay-relevant realtime loop limits (RM-8 / REALTIME_EXPERIENCE_MODE_PLAN).
 *
 * These two bounds are enforced on BOTH sides of the client-authoritative
 * round contract: the frame-side loop host (the producer of the round log)
 * and the server-side round-commit replay (the verifier). They live in the
 * zero-dep domain package so both import ONE source of truth — a divergent
 * copy would 422 every long honest round (a client producing logs the server
 * refuses to replay). The remaining loop-host pacing constants (input queue
 * depth, inputs per tick, catch-up ticks per frame, frame delta) are CLIENT
 * discipline only: the round log cannot express them, so the server never
 * checks them and they stay in apps/web.
 */

/**
 * Total-tick watchdog. The frame-side loop dies at this many ticks (fatal —
 * no finish, nothing committed); the server-side replay rejects a round log
 * whose total tick count EXCEEDS it (such a log can never be honest). A host
 * may LOWER the loop's watchdog via config, but never raise it above this
 * shared ceiling — a raised watchdog would produce logs the commit replay
 * refuses.
 */
export const EXPERIENCE_LOOP_MAX_ROUND_TICKS = 100_000;

/**
 * Batched-ticks flush threshold. The loop flushes its pending-tick counter
 * into a `ticks` log event at this threshold, so a single `ticks` event in an
 * honest log never carries more than this many ticks; the server-side replay
 * rejects a larger batch outright.
 */
export const EXPERIENCE_LOOP_MAX_BATCHED_TICKS = 1_000;
