/**
 * @module stt/whisper-mirror (web)
 *
 * URL rewriter routing the in-browser Whisper model downloads through the
 * app's server-side mirror (STT_PLAN ST-3; same defect class as the Kokoro
 * mirror — F4 / D4). Browser fetch can use neither the process proxy nor the
 * app's proxy registry, so huggingface.co is unreachable in geo-blocked
 * regions and the model download stalls forever with zero feedback.
 *
 * Unlike the single-repo Kokoro mirror, the Whisper roster spans SEVERAL
 * repos — the rewrite matches any roster repo and maps it onto the mirror
 * route `GET /api/stt/whisper/model/<repo>/<path>`; the server validates the
 * repo against the same roster (allowlist — never an open proxy). Wrapping
 * `fetch` inside the Web Worker catches every transformers.js download path
 * (`hub.js` file fetches included); the browser CacheStorage keeps working —
 * it caches the rewritten mirror URLs.
 */

import { whisperMirrorRepos } from "./whisper-models.js";

/** HF base every roster repo downloads from. */
const HF_ORIGIN = "https://huggingface.co/";

/** Mirror route served by the API server (same origin as the app). */
export const WHISPER_MIRROR_PATH = "/api/stt/whisper/model/";

/**
 * Rewrite one fetch URL to the mirror. Returns the mirror URL when `url`
 * targets a ROSTER repo file on huggingface.co, otherwise null (leave the
 * request untouched). Query strings are preserved verbatim.
 */
export function rewriteWhisperHfUrl(url: string): string | null {
  if (!url.startsWith(HF_ORIGIN)) return null;
  for (const repo of whisperMirrorRepos()) {
    const base = `${HF_ORIGIN}${repo}/resolve/main/`;
    if (url.startsWith(base)) {
      const suffix = url.slice(base.length);
      if (suffix.length === 0) return null;
      return `${WHISPER_MIRROR_PATH}${repo}/${suffix}`;
    }
  }
  return null;
}
