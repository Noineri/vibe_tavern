/**
 * Characterization tests for StreamingReveal — pinning the observable behavior
 * BEFORE the rewrite (workspace rule: rewriting must not mean amnesia).
 *
 * Only what is visible from the outside is pinned: the shown text is always a
 * prefix of the target, the reveal runs to completion, waitForReveal resolves,
 * clear publishes an empty string and releases a pending waiter. The internal
 * speed tiers are deliberately NOT pinned — they are what gets rewritten.
 *
 * The current implementation runs on setTimeout, so these use bun:test fake
 * timers. After the rAF rewrite the same checks step through the injected
 * scheduler instead.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { StreamingReveal } from "./streaming-reveal.js";
import { useChatStore } from "../stores/chat-store.js";

const CHAT = "chat-reveal-test";

function revealedText(): string {
  return useChatStore.getState().generations[CHAT]?.streamingRevealedText ?? "";
}

beforeEach(() => {
  useChatStore.setState({ generations: {} });
  useChatStore.getState().startGeneration(CHAT);
});

// Safety net: an assertion failure inside a fake-timer test would otherwise
// skip useRealTimers(), and with fake timers left active the runner's own
// per-test timeout never fires — the whole suite hangs forever (observed).
afterEach(() => {
  jest.useRealTimers();
});

describe("StreamingReveal — observable contract", () => {
  it("shown text is always a prefix of the target", () => {
    jest.useFakeTimers();
    const reveal = new StreamingReveal(CHAT);
    const target = "The tavern door creaks open, and a hooded figure steps inside.";
    reveal.pushDelta(target);

    for (let i = 0; i < 40; i++) {
      jest.advanceTimersByTime(16);
      expect(target.startsWith(revealedText())).toBe(true);
    }
    jest.useRealTimers();
  });

  it("reveals the full target text", async () => {
    const reveal = new StreamingReveal(CHAT);
    const target = "Short line.";
    reveal.pushDelta(target);
    await reveal.waitForReveal();
    expect(revealedText()).toBe(target);
  });

  it("waitForReveal resolves immediately when there is nothing to show", async () => {
    const reveal = new StreamingReveal(CHAT);
    await reveal.waitForReveal();
    expect(revealedText()).toBe("");
  });

  it("joins multiple deltas into one target text", async () => {
    const reveal = new StreamingReveal(CHAT);
    reveal.pushDelta("Hello, ");
    reveal.pushDelta("traveller");
    reveal.pushDelta(". Welcome.");
    await reveal.waitForReveal();
    expect(revealedText()).toBe("Hello, traveller. Welcome.");
  });

  it("clear publishes an empty string", async () => {
    const reveal = new StreamingReveal(CHAT);
    reveal.pushDelta("Some streamed text that will be discarded.");
    await reveal.waitForReveal();
    expect(revealedText()).not.toBe("");
    reveal.clear();
    expect(revealedText()).toBe("");
  });

  it("clear resolves a pending waitForReveal", async () => {
    const reveal = new StreamingReveal(CHAT);
    reveal.pushDelta("A fairly long stretch of prose that will not finish revealing on its own.");
    const pending = reveal.waitForReveal();
    reveal.clear();
    await pending; // must not hang
    expect(revealedText()).toBe("");
  });

  it("stops at word boundaries while working through a large backlog", () => {
    jest.useFakeTimers();
    const reveal = new StreamingReveal(CHAT);
    const target =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliett " +
      "kilo lima mike november oscar papa quebec romeo sierra tango uniform";
    reveal.pushDelta(target);

    // Word-boundary snapping is only defined for a large remaining backlog
    // (the current implementation reveals the last <80 characters in blind
    // fixed-size steps). While in that region, every stop lands right after a
    // space in both the current and the rewritten implementation.
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(16);
      const shown = revealedText();
      const remaining = target.length - shown.length;
      if (shown.length > 0 && remaining >= 80) {
        expect(shown.endsWith(" ")).toBe(true);
      }
    }
    jest.useRealTimers();
  });

  it("survives a delta arriving mid-reveal", async () => {
    const reveal = new StreamingReveal(CHAT);
    reveal.pushDelta("First part of the sentence ");
    reveal.pushDelta("and the second part of it.");
    await reveal.waitForReveal();
    expect(revealedText()).toBe("First part of the sentence and the second part of it.");
  });
});
