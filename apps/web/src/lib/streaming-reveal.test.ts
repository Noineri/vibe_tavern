/**
 * Characterization tests for StreamingReveal — pinning the observable behavior
 * across the rAF rewrite (workspace rule: rewriting must not mean amnesia).
 *
 * Only what is visible from the outside is pinned: the shown text is always a
 * prefix of the target, the reveal runs to completion, waitForReveal resolves,
 * clear publishes an empty string and releases a pending waiter. The stepping
 * rule itself is NOT pinned — only its self-correcting property (a larger
 * backlog catches up in larger steps).
 *
 * The reveal runs on an injected scheduler, so these tests step through frames
 * deterministically — no timers, real or fake, anywhere in this file.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { StreamingReveal, WORD_SNAP_WINDOW, type RevealScheduler } from "./streaming-reveal.js";
import { useChatStore } from "../stores/chat-store.js";

const CHAT = "chat-reveal-test";

function revealedText(): string {
  return useChatStore.getState().generations[CHAT]?.streamingRevealedText ?? "";
}

/**
 * Manual frame scheduler: `step()` runs exactly one scheduled frame,
 * `runToIdle()` runs frames until the reveal stops. Deterministic and
 * timer-free, so no assertion here depends on wall-clock time.
 */
function manualFrames() {
  let pending: (() => void) | null = null;
  const schedule: RevealScheduler = (callback) => {
    pending = callback;
    return () => { if (pending === callback) pending = null; };
  };
  return {
    schedule,
    get hasPending() { return pending !== null; },
    step() {
      const run = pending;
      pending = null;
      run?.();
    },
    runToIdle(maxFrames = 2000) {
      let frames = 0;
      while (pending && frames < maxFrames) { this.step(); frames++; }
      if (frames >= maxFrames) throw new Error("reveal did not settle within maxFrames");
    },
  };
}

beforeEach(() => {
  useChatStore.setState({ generations: {} });
  useChatStore.getState().startGeneration(CHAT);
});

describe("StreamingReveal — observable contract", () => {
  it("shown text is always a prefix of the target", () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    const target = "The tavern door creaks open, and a hooded figure steps inside.";
    reveal.pushDelta(target);

    while (frames.hasPending) {
      frames.step();
      expect(target.startsWith(revealedText())).toBe(true);
    }
  });

  it("reveals the full target text", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    const target = "Short line.";
    reveal.pushDelta(target);
    frames.runToIdle();
    await reveal.waitForReveal();
    expect(revealedText()).toBe(target);
  });

  it("waitForReveal resolves immediately when there is nothing to show", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    await reveal.waitForReveal();
    expect(revealedText()).toBe("");
  });

  it("joins multiple deltas into one target text", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    reveal.pushDelta("Hello, ");
    reveal.pushDelta("traveller");
    reveal.pushDelta(". Welcome.");
    frames.runToIdle();
    await reveal.waitForReveal();
    expect(revealedText()).toBe("Hello, traveller. Welcome.");
  });

  it("clear publishes an empty string", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    reveal.pushDelta("Some streamed text that will be discarded.");
    frames.runToIdle();
    await reveal.waitForReveal();
    expect(revealedText()).not.toBe("");
    reveal.clear();
    expect(revealedText()).toBe("");
  });

  it("clear resolves a pending waitForReveal", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    reveal.pushDelta("A fairly long stretch of prose that will not finish revealing on its own.");
    const pending = reveal.waitForReveal();
    reveal.clear();
    await pending; // must not hang
    expect(revealedText()).toBe("");
  });

  it("clear cancels the scheduled frame", () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    reveal.pushDelta("Text that starts revealing and is then discarded mid-flight.");
    expect(frames.hasPending).toBe(true);
    reveal.clear();
    expect(frames.hasPending).toBe(false);
  });

  it("does not split a word mid-way", () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    const target =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliett " +
      "kilo lima mike november oscar papa quebec romeo sierra tango uniform";
    reveal.pushDelta(target);

    while (frames.hasPending) {
      frames.step();
      const shown = revealedText();
      if (shown.length === 0 || shown.length === target.length) continue;
      // Either the reveal stopped right after a space, or the next character
      // is a space, or the snap window held no boundary and the step cut
      // through — the documented fallback.
      const stoppedAfterSpace = shown.endsWith(" ");
      const nextIsSpace = target[shown.length] === " ";
      const noBoundaryInWindow = !target
        .slice(shown.length, shown.length + WORD_SNAP_WINDOW)
        .includes(" ");
      expect(stoppedAfterSpace || nextIsSpace || noBoundaryInWindow).toBe(true);
    }
  });

  it("survives a delta arriving mid-reveal", async () => {
    const frames = manualFrames();
    const reveal = new StreamingReveal(CHAT, frames.schedule);
    reveal.pushDelta("First part of the sentence ");
    frames.step();
    reveal.pushDelta("and the second part of it.");
    frames.runToIdle();
    await reveal.waitForReveal();
    expect(revealedText()).toBe("First part of the sentence and the second part of it.");
  });

  it("catches up a large backlog in larger steps than a small one", () => {
    const bigFrames = manualFrames();
    const bigReveal = new StreamingReveal(CHAT, bigFrames.schedule);
    bigReveal.pushDelta("x".repeat(2000));
    bigFrames.step();
    const bigStep = revealedText().length;

    useChatStore.setState({ generations: {} });
    useChatStore.getState().startGeneration(CHAT);

    const smallFrames = manualFrames();
    const smallReveal = new StreamingReveal(CHAT, smallFrames.schedule);
    smallReveal.pushDelta("x".repeat(50));
    smallFrames.step();
    const smallStep = revealedText().length;

    expect(bigStep).toBeGreaterThan(smallStep);
  });
});
