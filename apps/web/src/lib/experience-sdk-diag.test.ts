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
 */
import { describe, expect, test } from "bun:test";
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
    addEventListener: ((type: string, fn: EventListener) => target.addEventListener(type, fn)) as never,
    dispatchEvent: ((e: Event) => target.dispatchEvent(e)) as never,
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
  bridge.bindHostPort(channel.port1 as unknown as Parameters<ExperienceHostBridge["bindHostPort"]>[0]);

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

/** Advance past the SDK's flush window (750ms) and settle the macrotask. */
async function flushDiag(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DIAG_FLUSH_MS + 60));
}

describe("SDK loop diagnostics channel (RM-13)", () => {
  test("samples the latest view + event/error/console tails in one loop_diag message", async () => {
    const h = await createHarness();
    h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 7 });
    h.dispatchLoop("vt-loop:view", { score: 1 });
    h.dispatchLoop("vt-loop:view", { score: 2 }); // latest wins in the sample
    h.console.error("boom", { x: 1 });
    await flushDiag();
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
  });

  test("a dead loop still reports: arm on the first event, boot errors reach the host", async () => {
    const h = await createHarness();
    // The RM-12c signature: the loop emits round_started, then dies with an
    // error. No view EVER flows.
    h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 1 });
    h.dispatchLoop("vt-loop:error", { kind: "boot_failed", message: "no config tag" });
    await flushDiag();
    expect(h.samples.length).toBeGreaterThanOrEqual(1);
    const last = h.samples[h.samples.length - 1] as { errors: unknown[]; view?: unknown };
    expect(last.errors.some((e) => (e as { kind: string }).kind === "boot_failed")).toBe(true);
    expect(last.view).toBeUndefined();
  });

  test("round finish posts a final sample (final: true) with the last view", async () => {
    const h = await createHarness();
    h.dispatchLoop("vt-loop:event", { kind: "round_started", seed: 3 });
    h.dispatchLoop("vt-loop:view", { score: 5 });
    h.dispatchLoop("vt-loop:finish", { status: "completed", finalState: { score: 5 }, log: [] });
    // The final flush is synchronous inside the finish listener — settle the
    // macrotask so the port delivery lands.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const finals = h.samples.filter((s) => (s as { final: boolean }).final === true);
    expect(finals.length).toBe(1);
    const f = finals[0] as { view?: unknown; final: boolean };
    expect(f.view).toEqual({ score: 5 });
  });

  test("a turn-based frame (no vt-loop:* events) never sends loop_diag", async () => {
    const h = await createHarness();
    h.console.log("turn-mode noise"); // collected into the ring, never sent
    await flushDiag();
    expect(h.samples).toEqual([]);
  });
});
