const STORAGE_KEY = "vibe_mobile_token";

// Bun's test env has no DOM, so localStorage is undefined there. Without this
// guard, avatar.test.ts crashes (resolveEntityAvatarUrl now appends ?token=
// via appendTokenQuery) — matches the typeof window check in gateway-client.
const hasLocalStorage = typeof localStorage !== "undefined";

/** Extract token from URL hash (#token=...) if present.
 *  Returns the token if found (and removes hash from URL), or null. */
export function extractTokenFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;

  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("token")?.trim();
  if (!token) return null;

  // Clean up URL hash without triggering navigation
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", url.pathname + url.search);

  return token;
}

/** Persist token to localStorage */
export function saveMobileToken(token: string): void {
  if (!hasLocalStorage) return;
  localStorage.setItem(STORAGE_KEY, token);
}

/** Read persisted token from localStorage */
export function getMobileToken(): string | null {
  return hasLocalStorage ? localStorage.getItem(STORAGE_KEY) : null;
}

/** Remove persisted token */
export function clearMobileToken(): void {
  if (!hasLocalStorage) return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Append ?token= query param to a URL if a mobile token is stored.
 *  Used for SSE/streaming connections that cannot send Authorization headers. */
export function appendTokenQuery(url: string): string {
  const token = getMobileToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
