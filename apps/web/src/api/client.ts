import { hc } from "hono/client";
import type { AppType } from "@vibe-tavern/api";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { clearMobileToken, getMobileToken } from "../lib/mobile-token.js";
import { useSessionStore } from "../stores/session-store.js";

// ─── THE API SEAM ────────────────────────────────────────────────────────────
// Every web→API request must go through apiFetch (directly, or via the hono
// `client` below which is wired onto it). Two duties live here and NOWHERE
// else:
//
//   1. OUT — attach `Authorization: Bearer <mobile token>` when the call
//      heads for our API and does not already carry one. Non-loopback
//      (LAN/mobile) clients must authenticate every /api/* call; desktop
//      loopback passes without it, which is exactly why a bare `fetch("/api/…")`
//      looked green on the dev machine and 401'd on the owner's phone
//      (2026-09-29 mobile outage: the Fly Tribunal boot-time settings load
//      wiped valid tokens into a "session revoked" loop).
//
//   2. IN — a 401 from our API means the stored token is dead (revoked or
//      regenerated elsewhere): clear it and raise the "session revoked"
//      screen. This used to live in a global fetch Proxy in main.tsx; the
//      Proxy is gone — this seam is the single choke point.
//
// scripts/check-bare-api-fetch.ts blocks any new bare `fetch("/api/…")` from
// landing outside this file, so the class stays closed mechanically, not by
// convention.

/** Origins whose /api calls count as "ours". Same-origin in prod; in the dev
 *  split (vite 5173 → api 8788) the gateway base origin is ours too. */
function isOurApiUrl(rawUrl: string): boolean {
  if (typeof window === "undefined") return false;

  // Relative URLs can only resolve against the page origin — they are ours by
  // construction. Do NOT route them through `new URL(rel, location.href)`:
  // location can be "about:blank" in test/embedded contexts and the parse
  // throws, which would silently strip auth from every relative /api call.
  const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
  if (isRelative) {
    return rawUrl === "/api" || rawUrl.startsWith("/api/") || rawUrl === "api" || rawUrl.startsWith("api/");
  }

  let resolved: URL;
  try {
    resolved = new URL(rawUrl);
  } catch {
    return false;
  }
  const isApiPath = resolved.pathname === "/api" || resolved.pathname.startsWith("/api/");
  if (!isApiPath) return false;
  if (window.location.origin !== "null" && resolved.origin === window.location.origin) return true;
  const gateway = getGatewayBaseUrl();
  if (!gateway) return false;
  try {
    return resolved.origin === new URL(gateway).origin;
  } catch {
    return false;
  }
}

/** True when the request already carries an Authorization header (any shape). */
function hasAuthorization(input: RequestInfo | URL, init?: RequestInit): boolean {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!source) return false;
  if (source instanceof Headers) return source.has("Authorization");
  if (Array.isArray(source)) return source.some(([k]) => String(k).toLowerCase() === "authorization");
  return Object.keys(source).some((k) => k.toLowerCase() === "authorization");
}

/**
 * fetch-shaped seam for same-origin /api calls. Use it EXACTLY like fetch:
 * `await apiFetch("/api/foo", { method: "POST", ... })`. Streams that cannot
 * send headers use `?token=` via appendTokenQuery (lib/mobile-token.ts) —
 * they keep raw fetch and are exempted in the bare-fetch guard by marker.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else url = input.url;

  let outInit = init;
  const token = getMobileToken();
  if (token && isOurApiUrl(url) && !hasAuthorization(input, init)) {
    const headers = new Headers(init?.headers ?? undefined);
    headers.set("Authorization", `Bearer ${token}`);
    outInit = { ...init, headers };
  }

  const response = await globalThis.fetch(input, outInit);

  if (response.status === 401 && isOurApiUrl(url)) {
    clearMobileToken();
    useSessionStore.getState().markRevoked();
  }
  return response;
}

export const client = hc<AppType>(getGatewayBaseUrl(), {
  fetch: apiFetch as unknown as typeof fetch,
});

export { getGatewayBaseUrl, getMobileToken };
