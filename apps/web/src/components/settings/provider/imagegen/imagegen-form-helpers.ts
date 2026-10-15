/**
 * Shared form helpers for the image-gen profile editor surfaces
 * (IMAGE_GENERATION_PLAN IG-21) — the stt-form-helpers.ts twin, trimmed to
 * the ONE piece the image-gen editor needs: the client-side mirror of the
 * server auto-key cascade (image-gen-adapter.ts autoMatchImageGenKey).
 *
 * The STT discipline — two mirrors, one rule: this pure function must stay
 * in lockstep with the server matcher. Rule order (owner decision
 * 2026-09-15; MR-3 generalized the exact-endpoint arm 2026-09-18): a keyless
 * image-gen profile auto-matches the FIRST keyful LLM provider in list
 * order — openrouter by VENDOR HOST (any path under openrouter.ai), every
 * other endpoint-driven cloud backend by EXACT normalized endpoint (the
 * openai-compat rule generalized). a1111/comfyui are local/keyless and
 * never match.
 */

import { IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_BACKENDS, type ImageGenBackendType } from "@vibe-tavern/domain";
import type { ImageGenCapabilityFlagsValue } from "@vibe-tavern/api-contracts";

/** Wire-boundary normalizer: defensive against unknown backend slugs —
 *  degrades to the OpenRouter roster default (the toSttBackend rule without
 *  a blind cast). */
export function toImageGenBackend(raw: string): ImageGenBackendType {
  for (const slug of Object.values(IMAGE_GEN_BACKENDS)) {
    if (slug === raw) return slug;
  }
  return IMAGE_GEN_BACKENDS.OpenRouter;
}

/** Defensive copy of the static capability row for a backend — the form
 *  must never hold a reference into the shared registry table (a later
 *  in-place mutation would corrupt the single source of truth). */
export function capabilitySnapshot(backend: ImageGenBackendType): ImageGenCapabilityFlagsValue {
  const caps = IMAGE_GEN_BACKEND_CAPABILITIES[backend];
  return {
    ...caps,
    sizeSupport:
      caps.sizeSupport.kind === "vendor-set"
        ? { kind: "vendor-set", sizes: [...caps.sizeSupport.sizes] }
        : { ...caps.sizeSupport },
  };
}

/** LLM provider profile as seen by the client-side auto-key mirror — the
 *  hint-only projection of the wire record (no key material). */
export interface ImageGenAutoKeyProviderCandidate {
  endpoint: string;
  hasStoredApiKey: boolean;
  name: string;
}

/** Client-side mirror of the server `imageGenEndpointHost`
 *  (services/api/src/api/adapters/image-gen-auto-key.ts): trim → default
 *  https:// scheme → URL host (hostname + port, lowercase); null for an
 *  empty or unparseable endpoint. */
function imageGenEndpointHost(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const host = new URL(value).host.toLowerCase();
    return host === "" ? null : host;
  } catch {
    // An unparseable endpoint has no host — it never matches.
    return null;
  }
}

/** Vendor host for the OpenRouter backend — mirror of the server
 *  OPENROUTER_VENDOR_HOST (image-gen-auto-key.ts). */
const IMAGEGEN_OPENROUTER_VENDOR_HOST = "openrouter.ai";

/** Client-side mirror of the server auto-key rule
 *  (`findImageGenAutoKeyProvider`, image-gen-auto-key.ts — keep in
 *  lockstep). Host rule (owner ruling 2026-10-15, match by host): the
 *  FIRST keyful provider whose endpoint is on the profile's
 *  host (hostname + port) wins — `host/v1`, bare `host` and any path on it
 *  match, another host never does; openrouter matches on its vendor host
 *  whatever the profile endpoint says; a1111 / comfyui (local, keyless)
 *  never match. Pure: the hook feeds wire lists, the editor feeds the live
 *  draft form. The active-flag never participates — the server rule
 *  ignores it too. */
export function matchImageGenAutoKeyProviderName(
  backend: ImageGenBackendType,
  endpoint: string,
  providers: ImageGenAutoKeyProviderCandidate[],
): string | null {
  if (backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI) {
    return null;
  }
  const target =
    backend === IMAGE_GEN_BACKENDS.OpenRouter
      ? IMAGEGEN_OPENROUTER_VENDOR_HOST
      : imageGenEndpointHost(typeof endpoint === "string" ? endpoint : "");
  if (target === null) return null;
  return providers.find((p) => p.hasStoredApiKey && imageGenEndpointHost(p.endpoint) === target)?.name ?? null;
}
