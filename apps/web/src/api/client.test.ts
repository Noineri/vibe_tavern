import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
/**
 * apiFetch — the single API seam (2026-09-29 mobile outage).
 *
 * Out: a stored mobile token becomes `Authorization: Bearer …` on same-origin
 * /api calls that don't already carry one (bare fetches looked green on
 * desktop loopback and 401'd every LAN/mobile client — the outage).
 * In: a 401 from our API clears the token and raises the session-revoked
 * screen (the old global fetch Proxy duty, now owned by this seam).
 * Non-/api and foreign-origin calls pass through untouched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const { useSessionStore } = await import("../stores/session-store.js");
const { saveMobileToken, clearMobileToken } = await import("../lib/mobile-token.js");
const realFetch = globalThis.fetch;

type CapturedCall = { input: RequestInfo | URL; init?: RequestInit };

function installFetchMock(status: number): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const fake = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(status === 401 ? '{"error":{"kind":"Unauthorized"}}' : "{}", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fake as unknown as typeof globalThis.fetch;
  return calls;
}

let apiFetch: typeof import("./client.js").apiFetch;
beforeAll(async () => {
  ({ apiFetch } = await import("./client.js"));
});

function authOf(call: CapturedCall | undefined): string | null {
  if (!call) return null;
  const headers = new Headers(call.init?.headers);
  return headers.get("Authorization");
}

describe("apiFetch — the API seam", () => {
  let calls: CapturedCall[];

  beforeEach(() => {
    clearMobileToken();
    useSessionStore.setState({ revoked: false });
    calls = installFetchMock(200);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearMobileToken();
    useSessionStore.setState({ revoked: false });
  });

  test("stored token rides along on same-origin /api calls (the outage fix)", async () => {
    saveMobileToken("tok_123");
    await apiFetch("/api/fly/settings");
    expect(calls.length).toBe(1);
    expect(authOf(calls[0])).toBe("Bearer tok_123");
  });

  test("no stored token → no Authorization header, request passes through", async () => {
    await apiFetch("/api/bootstrap");
    expect(calls.length).toBe(1);
    expect(authOf(calls[0])).toBeNull();
  });

  test("an explicit Authorization is never overridden", async () => {
    saveMobileToken("tok_123");
    await apiFetch("/api/thing", { headers: { Authorization: "Bearer explicit" } });
    expect(authOf(calls[0])).toBe("Bearer explicit");
  });

  test("existing init headers are preserved, not clobbered", async () => {
    saveMobileToken("tok_123");
    await apiFetch("/api/tokenize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(calls[0].init?.method).toBe("POST");
  });

  test("non-/api and foreign-origin URLs are untouched", async () => {
    saveMobileToken("tok_123");
    await apiFetch("/assets/logo.svg");
    await apiFetch("https://cdn.example.com/api/whatever");
    expect(calls.length).toBe(2);
    expect(authOf(calls[0])).toBeNull();
    expect(authOf(calls[1])).toBeNull();
  });

  test("401 from our API clears the token and raises the revoked screen", async () => {
    globalThis.fetch = realFetch;
    calls = installFetchMock(401);
    saveMobileToken("tok_dead");
    const res = await apiFetch("/api/bootstrap");
    expect(res.status).toBe(401);
    expect(useSessionStore.getState().revoked).toBe(true);
    expect(localStorage.getItem("vibe_mobile_token")).toBeNull();
  });

  test("200 keeps the token and the session intact", async () => {
    saveMobileToken("tok_ok");
    await apiFetch("/api/bootstrap");
    expect(useSessionStore.getState().revoked).toBe(false);
    expect(localStorage.getItem("vibe_mobile_token")).toBe("tok_ok");
  });
});
