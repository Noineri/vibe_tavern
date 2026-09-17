/**
 * Shared form helpers for the image-gen profile editor surfaces
 * (IMAGE_GENERATION_PLAN IG-21) — the stt-form-helpers.ts twin, trimmed to
 * the ONE piece the image-gen editor needs: the client-side mirror of the
 * server auto-key cascade (image-gen-adapter.ts autoMatchImageGenKey).
 *
 * The STT discipline — two mirrors, one rule: this pure function must stay
 * in lockstep with the server matcher. Rule order (owner decision
 * 2026-09-15): a keyless image-gen profile auto-matches the FIRST keyful
 * LLM provider in list order — openrouter by VENDOR HOST (any path under
 * openrouter.ai), openai-images by EXACT normalized endpoint (the
 * openai-compat rule). a1111 is local/keyless and never matches.
 */

import { IMAGE_GEN_BACKENDS, type ImageGenBackendType } from "@vibe-tavern/domain";

/** LLM provider profile as seen by the client-side auto-key mirror — the
 *  hint-only projection of the wire record (no key material). */
export interface ImageGenAutoKeyProviderCandidate {
  endpoint: string;
  hasStoredApiKey: boolean;
  name: string;
}

/** Client-side mirror of the server normalizeEndpoint (image-gen-adapter.ts
 *  — kept local there, mirrored here exactly like stt-form-helpers does for
 *  the stt-adapter one): trim → default https:// scheme → strip trailing
 *  slashes → lowercase. */
export function normalizeImageGenEndpoint(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "").toLowerCase();
}

/** Vendor host for the OpenRouter backend — mirror of the server
 *  OPENROUTER_API_HOST (image-gen-adapter.ts). */
const IMAGEGEN_OPENROUTER_API_HOST = "https://openrouter.ai";

/** Client-side mirror of the server HINT rule (decorateAutoKey in
 *  image-gen-adapter.ts — deliberately NOT the runtime cascade):
 *  - openrouter: the FIRST keyful provider whose endpoint lives on the
 *    vendor host wins (the STT fixed-vendor rule);
 *  - openai-images: exact normalized-endpoint match over keyful providers;
 *  - a1111 (and anything else): null — local/keyless, never matches.
 *  Pure: the hook feeds wire lists, the editor feeds the live draft form.
 *  The active-flag never participates — the server rule ignores it too. */
export function matchImageGenAutoKeyProviderName(
  backend: ImageGenBackendType,
  endpoint: string,
  providers: ImageGenAutoKeyProviderCandidate[],
): string | null {
  if (backend !== IMAGE_GEN_BACKENDS.OpenRouter && backend !== IMAGE_GEN_BACKENDS.OpenAiImages) {
    return null;
  }
  const keyful = providers.filter((p) => p.hasStoredApiKey);
  if (backend === IMAGE_GEN_BACKENDS.OpenRouter) {
    return (
      keyful.find((p) => normalizeImageGenEndpoint(p.endpoint).startsWith(IMAGEGEN_OPENROUTER_API_HOST))?.name ?? null
    );
  }
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  if (raw === "") return null;
  const target = normalizeImageGenEndpoint(raw);
  return keyful.find((p) => normalizeImageGenEndpoint(p.endpoint) === target)?.name ?? null;
}
