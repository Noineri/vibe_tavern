/**
 * VibeExperience SDK — loop diagnostics channel tests (RM-13).
 *
 * The observability channel: the loop's life (views, round-log events,
 * errors, the frame console) happens INSIDE the frame; the SDK samples it
 * and posts bounded `loop_diag` bridge messages to the host. This suite
 * evals the real SDK string against a fake window (same harness as the
 * RM-5 loop tests) wired to a REAL MessageChannel + ExperienceHostBridge,
 * then drives vt-loop:* events and console calls and asserts what the host
 * receives. Pins the contract the playground diagnostics panel and the
 * realtime copilot digest are built on.
 *
 * The RM-12c lesson, encoded: a loop that dies WITHOUT ever posting a view
 * must still reach the host (arm on the first vt-loop:* event; a boot
 * error surfaces through the errors tail).
 *
 * Deterministic time (owner ruling 2026-11-12, the TQ12-F04 follow-up): the
 * flush cadence is driven by jest fake timers. The harness/handshake is built
 * under REAL timers (its settle rides a real 0ms macrotask); each test then
 * installs fakes, dispatches its vt-loop:* events (arming the SDK's own
 * setTimeout), and advances past DIAG_FLUSH_MS. Port delivery is settled
 * with setImmediate turns — a macrotask OUTSIDE the faked timer queue,
 * probe-verified to deliver under fake timers (microtasks alone do not).
 * The POSITIVE tests prove delivery works in this regime, so the negative
 * test's empty-samples assert is not vacuous. This killed the wall-clock
 * race class wholesale: CI linux run 34665657469 once forced a 100ms poll
 * loop here (up-to-5s tail under load); the poll is gone.
 */
import { describe, expect, jest, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { ExperienceHostBridge } from "./experience-bridge.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "./experience-sdk.js";

useDomEnv();

const DIAG_FLUSH_MS = 750;

interface SdkHarness {
  connect(onView: (v: unknown) => void): unknown;
  dispatchLoop(type: string, detail: unknown): void;
  deliverWindowMessage(data: unknown): void;
  console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  samples: unknown[];
}

/** Build the SDK against a fake window + a REAL port pair into a bridge that
 *  collects loop_diag samples. Wires the handshake so `nonce` is bound. */
async function createHarness(): Promise<SdkHarness> {
  const target = new EventTarget();
  const samples: unknown[] = [];
  const con = {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
  const fakeWindow = {
    addEventListener: ((type: string, fn: EventListener) => target.addEventListener(type, fn)),
    dispatchEvent: ((e: Event) => target.dispatchEvent(e)),
    crypto: globalThis.crypto,
    console: con,
    VibeExperience: undefined as unknown,
  };
  new Function("window", VIBE_EXPERIENCE_SDK_SOURCE)(fakeWindow);
  const sdk = (fakeWindow as { VibeExperience?: { connect: SdkHarness["connect"] } }).VibeExperience;
  if (sdk === undefined) throw new Error("SDK did not publish VibeExperience");

  const bridge = new ExperienceHostBridge({
    sessionId: "test-session",
    initialRevision: 0,
    onAction: () => {},
    onLoopDiag: (diag) => samples.push(diag),
  });
  // Real MessageChannel, wired the way ExperienceFrame.attach does: the host
  // binds port1, the frame receives port2 as a window message, hello rides
  // the port, the SDK replies ready. Handshake completes before any dispatch.
  const channel = new MessageChannel();
  bridge.bindHostPort(channel.port1);

  const harness: SdkHarness = {
    connect: sdk.connect,
    dispatchLoop(type, detail) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
    deliverWindowMessage(data) {
      target.dispatchEvent(new MessageEvent("message", { data }));
    },
    console: {
      log: (...args: unknown[]) => (con.log as (...a: unknown[]) => void)(...args),
      warn: (...args: unknown[]) => (con.warn as (...a: unknown[]) => void)(...args),
      error: (...args: unknown[]) => (con.error as (...a: unknown[]) => void)(...args),
    },
    samples,
  };
  sdk.connect(() => {});
  harness.deliverWindowMessage({ kind: "port", port: channel.port2 });
  bridge.sendHello();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return harness;
}

/** Fire the SDK's flush window under fake timers (one DIAG_FLUSH_MS cadence;
 * the re-armed next cadence lands outside this window — one sample per test). */
function advanceFlushWindow(): void {
  jest.advanceTimersByTime(DIAG_FLUSH_MS + 60);
}

/** Settle MessageChannel port delivery while timers stay faked: port delivery
 * rides a macrotask OUTSIDE the faked timer queue (setImmediate is not faked
 * by bun's jest shim — probe-verified 2026-11-12; microtasks alone do not
 * deliver). Two turns: diagFlush posts synchronously, the second is
 * insurance — both deterministic, no wall clock involved. */
async function settlePort(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("SDK loop diagnostics channel (RM-13)", () => {
  test("samples the latest view + event/error/console tails in one loop_diag message", async () => {
    const h = await createHarness();
    jest.useFakeTimers();
    try {
      h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 7 });
      h.dispatchLoop("vt-loop:view", { score: 1 });
      h.dispatchLoop("vt-loop:view", { score: 2 }); // latest wins in the sample
      h.console.error("boom", { x: 1 });
      advanceFlushWindow();
      await settlePort();
      expect(h.samples.length).toBeGreaterThanOrEqual(1);
    const last = h.samples[h.samples.length - 1] as {
      view?: unknown;
      events: unknown[];
      errors: unknown[];
      console: Array<{ level: string; text: string }>;
      final: boolean;
    };
    expect(last.view).toEqual({ score: 2 });
    expect(last.events.some((e) => (e as { kind: string }).kind === "round_started")).toBe(true);
    expect(last.console.some((c) => c.level === "error" && c.text.includes("boom"))).toBe(true);
    expect(last.final).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a dead loop still reports: arm on the first event, boot errors reach the host", async () => {
    const h = await createHarness();
    jest.useFakeTimers();
    try {
      // The RM-12c signature: the loop emits round_started, then dies with an
      // error. No view EVER flows.
      h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 1 });
      h.dispatchLoop("vt-loop:error", { kind: "boot_failed", message: "no config tag" });
      advanceFlushWindow();
      await settlePort();
      expect(h.samples.length).toBeGreaterThanOrEqual(1);
      const last = h.samples[h.samples.length - 1] as { errors: unknown[]; view?: unknown };
      expect(last.errors.some((e) => (e as { kind: string }).kind === "boot_failed")).toBe(true);
      expect(last.view).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("round finish posts a final sample (final: true) with the last view", async () => {
    const h = await createHarness();
    h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 3 });
    h.dispatchLoop("vt-loop:view", { score: 5 });
    h.dispatchLoop("vt-loop:finish", { status: "completed", finalState: { score: 5 }, log: [] });
    // The final flush is synchronous inside the finish listener — settle the
    // macrotask so the port delivery lands.
    await settlePort();
    const finals = h.samples.filter((s) => (s as { final: boolean }).final === true);
    expect(finals.length).toBe(1);
    const f = finals[0] as { view?: unknown; final: boolean };
    expect(f.view).toEqual({ score: 5 });
  });

  test("a turn-based frame (no vt-loop:* events) never sends loop_diag", async () => {
    const h = await createHarness();
    jest.useFakeTimers();
    try {
      h.console.log("turn-mode noise"); // collected into the ring, never sent
      advanceFlushWindow();
      await settlePort();
      expect(h.samples).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
