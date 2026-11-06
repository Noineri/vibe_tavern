import { afterAll, afterEach, beforeEach, expect } from "bun:test";

/** Fail even when the cache resolver catches a fixture's accidental discovery request. */
export function guardModelDiscovery(hostname: string): void {
  const originalFetch = globalThis.fetch;
  let attempts: string[] = [];
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    attempts = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === hostname && url.pathname.endsWith("/models")) {
        attempts.push(url.href);
        throw new Error(`Unexpected model discovery: ${url.href}`);
      }
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    expect(attempts).toEqual([]);
  });
  afterAll(() => { globalThis.fetch = originalFetch; });
}
