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
 *  A delegating adapter over the real socket: the seam's narrow handler
 *  types (`{ data: unknown }` payloads) and the socket's own
 *  `this`-typed MessageEvent properties do not line up for the checker as a
 *  whole object, so each assignment forwards individually and the assigned
 *  handlers are kept verbatim for read-back. No cast, no behavior change:
 *  handlers fire on the real socket, close() forwards its arguments. */
function defaultOpenWebSocket(url: string): ImageGenWebSocketLike {
  const ws = new WebSocket(url);
  let onmessage: ((event: { data: unknown }) => void) | null = null;
  let onclose: ((event: unknown) => void) | null = null;
  let onerror: ((event: unknown) => void) | null = null;
  return {
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
      ws.onmessage = handler;
    },
    get onclose() {
      return onclose;
    },
    set onclose(handler) {
      onclose = handler;
      ws.onclose = handler;
    },
    get onerror() {
      return onerror;
    },
    set onerror(handler) {
      onerror = handler;
      ws.onerror = handler;
    },
    close(code?: number, reason?: string) {
      // The DOM socket's close is overloaded (no-arg vs code+reason); branch
      // instead of asserting — an absent code is the default close handshake.
      if (code === undefined) ws.close();
      else ws.close(code, reason);
    },
  };
}

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
