/**
 * Named proxy profile — canonical domain type for persisted HTTP(S) proxies.
 *
 * Mirrors ProxyStore.ProxyProfile from @vibe-tavern/db exactly. The secret
 * `password` is stored but never projected to clients; the wire projection
 * replaces it with `hasStoredPassword` (see api-contracts/wire-types).
 */
export interface StoredProxyRecord {
  id: string;
  /** Display name shown in selectors and the proxy manager. */
  name: string;
  /** HTTP(S) proxy URL WITHOUT embedded userinfo (no `user:pass@`). The username
   *  and password travel as separate columns so the URL can be safely logged. */
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
 * `http://` or `https://` URL without embedded credentials, path, query, or
 * fragment. Returns `true` only for a URL the transport layer can feed
 * directly to `fetch(..., { proxy })`.
 *
 * The transport layer (later report step) may prepend `username:password@`
 * from the separate columns, but the stored URL itself must be clean so it
 * can be logged safely.
 */
export function isValidProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}
