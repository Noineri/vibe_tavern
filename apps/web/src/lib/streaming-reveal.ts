/**
 * Streaming reveal — gradually reveals streaming text character-by-character
 * with adaptive speed. Updates per-chat generation state via useChatStore.
 *
 * Usage:
 *   const reveal = new StreamingReveal(chatId);
 *   reveal.pushDelta("Hello ");
 *   reveal.pushDelta("World");
 *   await reveal.waitForReveal();
 *   reveal.clear();
 */

import { useChatStore } from "../stores/chat-store.js";

export class StreamingReveal {
  private chatId: string;
  private target = "";
  private shown = "";
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
    if (this.shown.length >= this.target.length) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      this.schedule();
    });
  }

  /** Reset all state and clear any pending timers. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.target = "";
    this.shown = "";
    this.timer = null;
    this.flushResolve?.();
    this.flushResolve = null;
    useChatStore.getState().setStreamingText(this.chatId, "");
  }

  /** Current fully-revealed text so far. */
  getText(): string {
    return this.shown;
  }

  // -- internal --

  private schedule(): void {
    if (this.timer) return;

    const tick = (): void => {
      const remaining = this.target.length - this.shown.length;
      if (remaining <= 0) {
        this.timer = null;
        this.flushResolve?.();
        this.flushResolve = null;
        return;
      }

      // Adaptive speed: reveal more characters per tick when far behind
      const step = remaining > 240 ? 8 : remaining > 120 ? 5 : 3;
      this.shown = this.target.slice(0, this.shown.length + step);
      useChatStore.getState().setStreamingText(this.chatId, this.shown);
      this.timer = setTimeout(tick, 24);
    };

    this.timer = setTimeout(tick, 16);
  }
}
