/**
 * Streaming reveal — gradually reveals streaming text with adaptive modes.
 *
 * It splits visible text into:
 * - committedText: stable prefix rendered through Markdown (updated at sentence,
 *   paragraph, line, or fallback word boundaries)
 * - tailText: live suffix rendered as plain text, avoiding markdown reparse on
 *   every animation tick.
 */

import { useChatStore } from "../stores/chat-store.js";

const TICK_MS = 16;
const SMALL_BACKLOG = 80;
const MEDIUM_BACKLOG = 400;
const LARGE_BACKLOG = 1200;
const MAX_LIVE_TAIL = 360;
const PREFERRED_LIVE_TAIL = 180;

export class StreamingReveal {
  private chatId: string;
  private target = "";
  private shownLength = 0;
  private committedLength = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushResolve: (() => void) | null = null;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  /** Append a delta chunk to the target text and schedule reveal animation. */
  pushDelta(delta: string): void {
    this.target += delta;
    this.schedule();
  }

  /** Wait until the shown text catches up to the full target. */
  waitForReveal(): Promise<void> {
    if (this.shownLength >= this.target.length) {
      this.commitAll();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      this.schedule();
    });
  }

  /** Reset all state and clear any pending timers. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.target = "";
    this.shownLength = 0;
    this.committedLength = 0;
    this.timer = null;
    this.flushResolve?.();
    this.flushResolve = null;
    useChatStore.getState().setStreamingParts(this.chatId, "", "");
  }

  /** Current fully-revealed text so far. */
  getText(): string {
    return this.target.slice(0, this.shownLength);
  }

  // -- internal --

  private schedule(): void {
    if (this.timer) return;

    const tick = (): void => {
      const remaining = this.target.length - this.shownLength;
      if (remaining <= 0) {
        this.timer = null;
        this.commitAll();
        this.flushResolve?.();
        this.flushResolve = null;
        return;
      }

      this.shownLength = Math.min(this.target.length, this.shownLength + this.nextStep(remaining));
      this.updateCommittedBoundary();
      this.publish();
      this.timer = setTimeout(tick, TICK_MS);
    };

    this.timer = setTimeout(tick, TICK_MS);
  }

  private nextStep(remaining: number): number {
    if (remaining < SMALL_BACKLOG) return 4;

    if (remaining < MEDIUM_BACKLOG) {
      // Word flow: reveal roughly one short word per tick, snapping to boundary.
      return this.stepToBoundary(8, 28);
    }

    if (remaining < LARGE_BACKLOG) {
      // Phrase flow: larger chunks, still trying to stop at word boundaries.
      return this.stepToBoundary(32, 72);
    }

    // Burst flow: catch up fast for very quick local models, but avoid instant dump.
    return this.stepToBoundary(96, 220);
  }

  private stepToBoundary(minStep: number, maxStep: number): number {
    const start = this.shownLength;
    const hardEnd = Math.min(this.target.length, start + maxStep);
    const softStart = Math.min(this.target.length, start + minStep);

    for (let i = softStart; i <= hardEnd; i++) {
      const ch = this.target[i - 1];
      if (ch === " " || ch === "\n" || ch === "\t") return i - start;
    }
    return hardEnd - start;
  }

  private updateCommittedBoundary(): void {
    const boundary = findStableCommitBoundary(this.target, this.committedLength, this.shownLength);
    if (boundary > this.committedLength) {
      this.committedLength = boundary;
    }

    const liveTailLength = this.shownLength - this.committedLength;
    if (liveTailLength > MAX_LIVE_TAIL) {
      const desired = Math.max(this.committedLength, this.shownLength - PREFERRED_LIVE_TAIL);
      const fallback = findLastWhitespaceBoundary(this.target, this.committedLength, desired);
      this.committedLength = fallback > this.committedLength ? fallback : desired;
    }
  }

  private publish(): void {
    const committedText = this.target.slice(0, this.committedLength);
    const tailText = this.target.slice(this.committedLength, this.shownLength);
    useChatStore.getState().setStreamingParts(this.chatId, committedText, tailText);
  }

  private commitAll(): void {
    this.shownLength = this.target.length;
    this.committedLength = this.target.length;
    useChatStore.getState().setStreamingParts(this.chatId, this.target, "");
  }
}

function findStableCommitBoundary(text: string, from: number, to: number): number {
  let best = -1;
  const limit = Math.min(text.length, to);

  for (let i = Math.max(0, from); i < limit; i++) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    // Paragraph boundary: best for markdown stability.
    if (ch === "\n" && next === "\n") best = i + 2;

    // Single line boundary: useful for lists/code-ish output once there is some tail.
    if (ch === "\n" && i + 1 - from > 80) best = i + 1;

    // Sentence boundary followed by whitespace/end.
    if ((ch === "." || ch === "!" || ch === "?" || ch === "…") && (next === "" || /\s/.test(next))) {
      best = i + 1;
    }
  }

  return best > from ? best : from;
}

function findLastWhitespaceBoundary(text: string, from: number, to: number): number {
  const limit = Math.min(text.length, to);
  for (let i = limit; i > from; i--) {
    const ch = text[i - 1];
    if (ch === " " || ch === "\n" || ch === "\t") return i;
  }
  return from;
}
