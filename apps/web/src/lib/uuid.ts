/**
 * Secure-context-proof RFC 4122 v4 UUID.
 *
 * `crypto.randomUUID` exists ONLY in secure contexts. The app is routinely
 * opened from other devices over plain http on the LAN (the server binds
 * 0.0.0.0), where the bare call throws TypeError — on a phone this silently
 * killed experience actions, dice rolls, gallery attachments and pending
 * draft-attachment ids: the throw fires before the request, so nothing
 * reaches the server and nothing is surfaced in the UI. `crypto.getRandomValues`
 * IS available in insecure contexts, so the fallback builds the same v4
 * shape from raw bytes — the same pattern the experience SDK uses inside
 * untrusted visuals.
 */

/** Build the v4 UUID string from 16 random bytes (the insecure-context path). */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError("uuidFromBytes needs exactly 16 bytes");
  const b = Uint8Array.from(bytes); // never mutate the caller's buffer
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/** Prefer native `crypto.randomUUID`; fall back to `getRandomValues` when absent. */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
}
