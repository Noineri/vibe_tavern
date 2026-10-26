/**
 * @module imagegen/backends/comfyui-errors
 *
 * The ComfyUI backend's typed error classes — moved out of comfyui.ts
 * (IG-R2) so every sibling module (workflow builders, second passes,
 * listing walkers) throws them without importing the adapter module.
 */

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport / execution failure of a generation or listing request. */
export class ComfyImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures and graph rejections). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ComfyImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint, or a key on a keyless backend). */
export class ComfyImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenConfigError";
  }
}

/** A width/height that is not a positive integer — the free-size fail
 *  closed error (the a1111 twin). */
export class ComfyImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenSizeError";
  }
}
