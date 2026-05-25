const STORAGE_KEY = "rp_mobile_token";

/** Extract token from URL hash (#token=...) if present.
 *  Returns the token if found (and removes hash from URL), or null. */
export function extractTokenFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#token=")) return null;
  const token = hash.slice(7); // after "#token="
  if (!token) return null;

  // Clean up URL hash without triggering navigation
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", url.pathname + url.search);

  return token;
}

/** Persist token to localStorage */
export function saveMobileToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

/** Read persisted token from localStorage */
export function getMobileToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/** Remove persisted token */
export function clearMobileToken(): void {
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
