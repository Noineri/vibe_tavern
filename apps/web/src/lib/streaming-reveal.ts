/**
 * Streaming reveal — gradually reveals streaming text.
 *
 * Providers deliver tokens in bursts: one character at a time from a cloud
 * model, a whole paragraph at once from a fast local one. This class smooths
 * out the difference: it accumulates the received text as the target and
 * reveals it evenly, stopping at word boundaries so a word is never split
 * mid-way.
 *
 * It runs on requestAnimationFrame rather than setTimeout: the reveal is an
 * animation, so it should sync with the browser's frames and freeze in a
 * hidden tab. The scheduler is injected so tests can step through frames
 * deterministically.
 */

import { useChatStore } from "../stores/chat-store.js";

/**
 * Schedules `callback` for the next frame and returns a cancel function.
 * Defaults to requestAnimationFrame; tests substitute a manual stepper.
 */
export type RevealScheduler = (callback: () => void) => () => void;

const rafScheduler: RevealScheduler = (callback) => {
  const id = requestAnimationFrame(() => callback());
  return () => cancelAnimationFrame(id);
};

/**
 * Fraction of the hidden remainder revealed per frame. At 60 frames per
 * second the remainder shrinks by roughly an order of magnitude within half
 * a second, so a local model that dumped a whole paragraph catches up quickly
 * but not instantly. A single number instead of the previous four-tier table:
 * the rule is self-correcting — the larger the backlog, the larger the step.
 */
const CATCH_UP_PER_FRAME = 0.08;

/**
 * Minimum characters per frame, so a rare thin trickle (one token per second)
 * still moves instead of stalling on the fraction rounding down.
 */
const MIN_CHARS_PER_FRAME = 2;

/**
 * How far past the calculated step to reach for a word boundary. On the order
 * of a long word plus punctuation: if there is no space within this window,
 * cut at the calculated step rather than stall the reveal for a perfect join.
 *
 * Exported so the "no mid-word split" test reads the same number instead of
 * keeping its own copy that would drift apart on the first edit.
 */
export const WORD_SNAP_WINDOW = 24;

export class StreamingReveal {
  private readonly chatId: string;
  private readonly schedule: RevealScheduler;
  private target = "";
  private shownLength = 0;
  private cancelFrame: (() => void) | null = null;
  private flushResolve: (() => void) | null = null;

  constructor(chatId: string, schedule: RevealScheduler = rafScheduler) {
    this.chatId = chatId;
    this.schedule = schedule;
  }

  /** Append a delta chunk to the target text and start the reveal. */
  pushDelta(delta: string): void {
    this.target += delta;
    this.ensureRunning();
  }

  /** Wait until the shown text has caught up to the full target. */
  waitForReveal(): Promise<void> {
    if (this.shownLength >= this.target.length) {
      this.commitAll();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      this.ensureRunning();
    });
  }

  /** Reset state, cancel the pending frame, release the waiter, publish "". */
  clear(): void {
    this.stop();
    this.target = "";
    this.shownLength = 0;
    this.resolveFlush();
    useChatStore.getState().setStreamingRevealed(this.chatId, "");
  }

  // -- internals --

  private ensureRunning(): void {
    if (this.cancelFrame) return;
    this.cancelFrame = this.schedule(() => this.tick());
  }

  private stop(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  private tick(): void {
    this.cancelFrame = null;

    const remaining = this.target.length - this.shownLength;
    if (remaining <= 0) {
      this.commitAll();
      this.resolveFlush();
      return;
    }

    this.shownLength += this.stepSize(remaining);
    this.publish();
    this.ensureRunning();
  }

  /**
   * How many characters to reveal this frame: a fraction of the remainder,
   * but no less than the minimum, extended forward to the nearest word
   * boundary within the snap window.
   */
  private stepSize(remaining: number): number {
    const base = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(remaining * CATCH_UP_PER_FRAME));
    if (base >= remaining) return remaining;

    const searchEnd = Math.min(this.target.length, this.shownLength + base + WORD_SNAP_WINDOW);
    for (let i = this.shownLength + base; i < searchEnd; i++) {
      const ch = this.target[i];
      if (ch === " " || ch === "\n" || ch === "\t") return i - this.shownLength + 1;
    }
    return base;
  }

  private resolveFlush(): void {
    const resolve = this.flushResolve;
    this.flushResolve = null;
    resolve?.();
  }

  private publish(): void {
    useChatStore.getState().setStreamingRevealed(this.chatId, this.target.slice(0, this.shownLength));
  }

  private commitAll(): void {
    this.shownLength = this.target.length;
    useChatStore.getState().setStreamingRevealed(this.chatId, this.target);
  }
}
