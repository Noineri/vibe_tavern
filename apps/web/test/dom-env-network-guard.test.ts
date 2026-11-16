import { describe, expect, test } from "bun:test";
import { createNetworkGuardAfterEach, useDomEnv } from "./dom-env.js";

/**
 * Self-test for `dom-env.ts`'s network guard (TEST_QUALITY_FIX_WAVE_REPORT #15 /
 * TQ17-F01(b)).
 *
 * If `installNetworkGuard()` regresses, DOM tests revert to happy-dom's real
 * `fetch`, silently hitting sockets/live dev server AND blinding every
 * `useDomEnv({ failOnNetwork: true })` consumer.
 *
 * L1 checklist:
 *  1. Paths: no out-of-repo path literals (closed loopback URLs only).
 *  2. Restores: no globals patched beyond `useDomEnv()`'s own process-lifetime setup.
 *  3. Determinism: pure promise rejections, zero sleeps/timers.
 *  4. Platform: platform-agnostic `fetch` + `URL` + `Request`.
 *  5. Shared pool: isolated per file under `--parallel --isolate`; safe in any order.
 *  6. Stable state: awaits settled rejections and explicit queue drains.
 *  7. Setup cost: ~1ms, zero DBs or subprocesses.
 */
useDomEnv();

const drainStrict = createNetworkGuardAfterEach({ failOnNetwork: true });
const drainDefault = createNetworkGuardAfterEach();
const drainPermissive = createNetworkGuardAfterEach({ failOnNetwork: false });

async function expectBlockedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  expectedTarget: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fetch(input, init);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  if (!(caught instanceof TypeError)) {
    throw new Error(`Expected TypeError rejection for ${expectedTarget}`);
  }
  expect(caught.message).toBe(`DOM test network access blocked: ${expectedTarget}`);
}

describe("dom-env network guard", () => {
  test("rejects bare fetch across string, URL, and Request inputs without opening sockets and preserves preconnect", async () => {
    expect(typeof globalThis.fetch.preconnect).toBe("function");
    await expectBlockedFetch("http://127.0.0.1:1/probe", undefined, "GET http://127.0.0.1:1/probe");
    await expectBlockedFetch("http://127.0.0.1:1/submit", { method: "POST" }, "POST http://127.0.0.1:1/submit");
    await expectBlockedFetch(new URL("http://127.0.0.1:1/url-probe"), undefined, "GET http://127.0.0.1:1/url-probe");
    await expectBlockedFetch(
      new Request("http://127.0.0.1:1/req-probe", { method: "DELETE" }),
      undefined,
      "DELETE http://127.0.0.1:1/req-probe",
    );
    await expectBlockedFetch(
      new Request("http://127.0.0.1:1/req-probe", { method: "DELETE" }),
      { method: "PATCH" },
      "PATCH http://127.0.0.1:1/req-probe",
    );
  });

  test("records blocked attempts, throws when failOnNetwork is true with deduplicated targets, and clears the queue", async () => {
    // Under default ordering this also proves useDomEnv()'s afterEach drained prior blocked fetches.
    expect(() => drainStrict()).not.toThrow();

    await expectBlockedFetch("http://127.0.0.1:1/alpha", undefined, "GET http://127.0.0.1:1/alpha");
    await expectBlockedFetch("http://127.0.0.1:1/alpha", undefined, "GET http://127.0.0.1:1/alpha");
    await expectBlockedFetch("http://127.0.0.1:1/beta", { method: "POST" }, "POST http://127.0.0.1:1/beta");

    expect(() => drainStrict()).toThrow(
      "This test reached for the network 3 time(s): GET http://127.0.0.1:1/alpha, POST http://127.0.0.1:1/beta.",
    );
    expect(() => drainStrict()).not.toThrow();
  });

  test("default and failOnNetwork: false drains clear recorded attempts without throwing or leaking", async () => {
    expect(() => drainStrict()).not.toThrow();
    await expectBlockedFetch("http://127.0.0.1:1/gamma", undefined, "GET http://127.0.0.1:1/gamma");
    expect(() => drainDefault()).not.toThrow();
    expect(() => drainStrict()).not.toThrow();

    await expectBlockedFetch("http://127.0.0.1:1/delta", undefined, "GET http://127.0.0.1:1/delta");
    expect(() => drainPermissive()).not.toThrow();
    expect(() => drainStrict()).not.toThrow();
  });
});
