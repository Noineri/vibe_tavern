/**
 * @module tts/kokoro-mirror (web)
 *
 * URL rewriter routing the in-browser Kokoro model download through the
 * app's server-side mirror (TTS defects report, F4 / defect D4).
 *
 * Why a global-fetch rewrite instead of transformers.js env knobs: the model
 * files go through transformers.js `hub.js` (built from `env.remoteHost` /
 * `env.remotePathTemplate`), BUT kokoro-js 1.2.1 dist hardcodes a second
 * download path — the per-voice blobs are fetched straight from
 * `https://huggingface.co/<repo>/resolve/main/voices/*.bin` with a raw
 * `fetch`, invisible to any transformers.js setting (and transformers.js
 * 3.8.1 has no `env.customFetch`). Wrapping `fetch` inside the Web Worker
 * catches BOTH paths — and any other stray HF fetch — at one seam. The
 * browser CacheStorage keeps working (it caches the rewritten mirror URLs).
 */

/** HF base the Kokoro worker downloads from (must match the server mirror's
 *  fixed repository). */
export const KOKORO_HF_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";

/** Mirror route served by the API server (same origin as the app). */
export const KOKORO_MIRROR_PATH = "/api/tts/kokoro/model/";

/**
 * Rewrite one fetch URL to the mirror. Returns the mirror URL when `url`
 * targets the fixed Kokoro repository on huggingface.co, otherwise null
 * (leave the request untouched). Query strings are preserved verbatim.
 */
export function rewriteHfUrl(url: string): string | null {
	if (!url.startsWith(KOKORO_HF_BASE)) return null;
	const suffix = url.slice(KOKORO_HF_BASE.length);
	if (suffix.length === 0) return null;
	return `${KOKORO_MIRROR_PATH}${suffix}`;
}
