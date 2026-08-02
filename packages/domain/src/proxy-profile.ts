/**
 * Named proxy profile — canonical domain type for persisted HTTP(S)/SOCKS5
 * proxies.
 *
 * Mirrors ProxyStore.ProxyProfile from @vibe-tavern/db exactly. The secret
 * `password` is stored but never projected to clients; the wire projection
 * replaces it with `hasStoredPassword` (see api-contracts/wire-types).
 */
export interface StoredProxyRecord {
  id: string;
  /** Display name shown in selectors and the proxy manager. */
  name: string;
  /** Bare `http://`, `https://`, or `socks5://` proxy URL WITHOUT embedded
   *  userinfo (no `user:pass@`). The username and password travel as separate
   *  columns so the URL can be safely logged. SOCKS5 is HTTPS-only at the
   *  transport layer (see provider-fetch-factory); local HTTP providers stay
   *  usable with `direct`. */
  url: string;
  /** Optional proxy username (sent via Proxy-Authorization at connect time). */
  username: string | null;
  /** Optional proxy password (stored secret — never crosses the wire boundary). */
  password: string | null;
  /** Manual list order (drag-to-reorder), like providerProfiles.sortOrder. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyData {
  name: string;
  url: string;
  username?: string | null;
  password?: string | null;
}

export type UpdateProxyData = Partial<CreateProxyData>;

/**
 * Validate a proxy URL for persistence. Rejects anything that is not a bare
 * `http://`, `https://`, or `socks5://` URL without embedded credentials,
 * path, query, or fragment. HTTP(S) URLs are fed directly to Bun's native
 * `fetch(..., { proxy })`; SOCKS5 URLs are routed through a loopback HTTP
 * bridge (see provider-fetch-factory / socks-bridge).
 *
 * The stored URL itself must be clean (no userinfo) so it can be logged
 * safely. The transport layer prepends `username:password@` from the
 * separate columns at request time. Note: for non-special schemes like
 * `socks5:` the WHATWG URL parser yields an empty pathname (not `/`) for a
 * bare host:port URL, so both forms are accepted.
 */
export function isValidProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
    if (parsed.search !== "" || parsed.hash !== "") return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}
