/**
 * @module imagegen/backends/a1111-errors
 *
 * The A1111 dialect's typed error classes — moved out of a1111.ts
 * (IG-R4) so the response parsers (a1111-response-parsing.ts) throw
 * them without importing the adapter module.
 */

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport failure of a generation or listing request. */
export class A1111ImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, aborts that
   *  are not the caller's own signal). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "A1111ImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint). */
export class A1111ImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A1111ImageGenConfigError";
  }
}

/** A width/height that is not a positive integer — the free-size fail
 *  closed error (the dialect takes free W×H, but only well-formed ones). */
export class A1111ImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A1111ImageGenSizeError";
  }
}
