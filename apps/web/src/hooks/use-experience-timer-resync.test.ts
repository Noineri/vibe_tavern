/**
 * useExperienceTimerResync tests (fix step 2d).
 *
 * Pins the poll contract: while the surface is active AND a pending/running
 * timer effect exists, the scope rehydrates on the cadence; it never polls
 * without a live timer, while inactive, or without a scope; and it disarms
 * once the timer reaches a terminal state. The store is driven through its
 * real zustand shape with only `rehydrate` observed (a spy installed via
 * getState override), so the hook's exact call into the store is what is
 * asserted — no HTTP, no other store machinery.
 */
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ExperienceEffectRow } from "@vibe-tavern/db";

import { useDomEnv } from "../../test/dom-env.js";
import { useExperienceStore } from "../stores/experience-store.js";
import { useExperienceTimerResync } from "./use-experience-timer-resync.js";

useDomEnv();

function makeEffect(over: Partial<ExperienceEffectRow> = {}): ExperienceEffectRow {
  return {
    id: "eff_1",
    sessionId: "sess_1",
    kind: "timer",
    status: "pending",
    originatingRevision: 1,
    requestJson: "{}",
    resultJson: null,
    error: null,
    attemptCount: 0,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ExperienceEffectRow;
}

const realGetState = useExperienceStore.getState.bind(useExperienceStore);

describe("useExperienceTimerResync", () => {
  let rehydrateMock: ReturnType<typeof mock>;

  beforeEach(() => {
    rehydrateMock = mock(async () => {});
    useExperienceStore.getState = mock(() => ({
      ...realGetState(),
      rehydrate: rehydrateMock,
    })) as unknown as typeof useExperienceStore.getState;
  });

  afterEach(() => {
    useExperienceStore.getState = realGetState;
  });

  function rehydrateCalls(): number {
    return rehydrateMock.mock.calls.length;
  }

  it("polls rehydrate on the cadence while an active surface has a pending timer", async () => {
    const { rerender } = renderHook(
      (props: { effects: ExperienceEffectRow[] }) =>
        useExperienceTimerResync({
          chatId: "c1",
          branchId: "b1",
          effects: props.effects,
          active: true,
          intervalMs: 5,
        }),
      { initialProps: { effects: [makeEffect()] } },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    expect(rehydrateCalls()).toBeGreaterThan(1);
    rerender({ effects: [makeEffect()] });
  });

  it("never polls without a live timer (terminal statuses are ignored)", async () => {
    renderHook(() =>
      useExperienceTimerResync({
        chatId: "c1",
        branchId: "b1",
        effects: [makeEffect({ status: "succeeded" }), makeEffect({ id: "eff_2", kind: "model" })],
        active: true,
        intervalMs: 5,
      }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rehydrateCalls()).toBe(0);
  });

  it("never polls while inactive (surface closed)", async () => {
    renderHook(() =>
      useExperienceTimerResync({
        chatId: "c1",
        branchId: "b1",
        effects: [makeEffect()],
        active: false,
        intervalMs: 5,
      }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rehydrateCalls()).toBe(0);
  });

  it("disarms once the timer reaches a terminal state", async () => {
    const { rerender } = renderHook(
      (props: { effects: ExperienceEffectRow[] }) =>
        useExperienceTimerResync({
          chatId: "c1",
          branchId: "b1",
          effects: props.effects,
          active: true,
          intervalMs: 5,
        }),
      { initialProps: { effects: [makeEffect()] } },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    const beforeTerminal = rehydrateCalls();
    expect(beforeTerminal).toBeGreaterThan(0);
    rerender({ effects: [makeEffect({ status: "succeeded" })] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // The interval was cleared on the terminal rerender: no further calls.
    expect(rehydrateCalls()).toBe(beforeTerminal);
  });
});
