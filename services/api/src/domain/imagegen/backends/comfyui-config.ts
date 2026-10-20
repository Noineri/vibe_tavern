/**
 * @module imagegen/backends/comfyui-config
 *
 * The ComfyUI adapter config — moved out of comfyui.ts (IG-R3b): the
 * default socket opener, the parsed config shape, and the parser that
 * normalizes the endpoint and fails closed on an API key (ComfyUI core
 * has no auth). The factory calls parseConfig; the catalog listing
 * walkers take the parsed shape as their cfg parameter.
 */

import type { ImageGenAdapterConfig, ImageGenWebSocketLike } from "../imagegen-backend.js";
import { setOrUndefined } from "./backend-helpers.js";
import { ComfyImageGenConfigError } from "./comfyui-errors.js";
import { normalizeComfyBaseUrl } from "./comfyui-history.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** The default socket opener — the global WebSocket (Bun's does NOT read
 *  env proxies, so a localhost socket is always direct; correct here).
 *  Cast: the global satisfies the seam structurally, but its overloaded
 *  close() and `this`-typed handlers don't line up with the narrow
 *  interface for the checker — one documented boundary cast. */
const defaultOpenWebSocket = (url: string): ImageGenWebSocketLike =>
  new WebSocket(url) as unknown as ImageGenWebSocketLike;

export interface ComfyImageGenConfig {
  endpoint: string;
  model: string | undefined;
  fetch: typeof fetch;
  openWebSocket: (url: string) => ImageGenWebSocketLike;
}

export function parseConfig(config: ImageGenAdapterConfig): ComfyImageGenConfig {
  const endpoint = normalizeComfyBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: `endpoint` is required (the local server's base URL, e.g. http://127.0.0.1:8188)",
    );
  }
  if (config.apiKey !== undefined && config.apiKey.trim() !== "") {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: ComfyUI core has no authentication — clear the API key field",
    );
  }
  return {
    endpoint,
    model: setOrUndefined(config.model),
    fetch: config.fetch ?? fetch,
    openWebSocket: config.openWebSocket ?? defaultOpenWebSocket,
  };
}
