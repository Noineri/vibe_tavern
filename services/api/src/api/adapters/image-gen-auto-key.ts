/**
 * @module adapters/image-gen-auto-key
 *
 * The image-gen IG-21 auto-key cascade — ONE server-side rule, consumed by
 * the execution seam (`resolveAdapterConfig` / `createProfileBackend`, used
 * by image-gen-adapter.ts) and by the wire hint
 * (`decorateImageGenProfileAutoKeys`, image-gen-profile-list.ts). Extracted
 * from image-gen-adapter.ts so the hint and the execution seam can no longer
 * drift (they had: the hint's endpoint Map was last-wins, the seam
 * first-wins — IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 6).
 *
 * RULE (owner ruling 2026-10-15: match by host — supersedes the
 * MR-3 exact-endpoint rule for image-gen; one host = one vendor): a profile
 * WITHOUT its own stored key takes the key of the FIRST keyful LLM provider
 * profile (list/sort order) whose endpoint is on the same HOST (hostname +
 * port) as the profile's endpoint — `host/v1`, bare `host`, `host/v1/` and
 * any other path on that host all match; a different host never does.
 * OpenRouter matches on its vendor host whatever the profile's endpoint
 * says. a1111 / comfyui (local, keyless) never match. The profile's OWN key
 * always wins (it short-circuits before the cascade). STT/TTS keep their own
 * exact rule — out of scope here.
 *
 * Client mirror: `matchImageGenAutoKeyProviderName` in
 * apps/web/src/components/settings/provider/imagegen/imagegen-form-helpers.ts
 * — keep in lockstep.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type { ImageGenProfile } from "@vibe-tavern/domain";
import { IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type { ImageGenAdapterConfig, ImageGenBackend } from "../../domain/imagegen/imagegen-backend.js";
import {
  createImageGenBackend,
  ImageGenBackendNotRegisteredError,
  ImageGenUnknownBackendError,
} from "../../domain/imagegen/imagegen-registry.js";

/** The OpenRouter vendor host — an OpenRouter profile matches a provider on
 *  this host whatever path its own endpoint carries. */
const OPENROUTER_VENDOR_HOST = "openrouter.ai";

/** The match key of an endpoint: trim → default `https://` scheme → URL
 *  host (hostname + port, lowercase). Null for an empty or unparseable
 *  endpoint — it never matches anything. */
export function imageGenEndpointHost(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const host = new URL(value).host.toLowerCase();
    return host === "" ? null : host;
  } catch {
    // An unparseable endpoint has no host — the caller treats it as no match.
    return null;
  }
}

/** The minimal LLM provider projection the matcher reads. */
export interface ImageGenAutoKeyCandidate {
  name: string;
  endpoint: string;
  apiKey?: string | null;
}

/** Pure matcher — the rule above over an already-loaded provider list.
 *  Returns the FIRST keyful provider on the target host (deterministic in
 *  list order), or null. */
export function findImageGenAutoKeyProvider<T extends ImageGenAutoKeyCandidate>(
  providers: readonly T[],
  backend: ImageGenProfile["backend"],
  endpoint: string,
): T | null {
  if (backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI) return null;
  const target = backend === IMAGE_GEN_BACKENDS.OpenRouter ? OPENROUTER_VENDOR_HOST : imageGenEndpointHost(endpoint);
  if (target === null) return null;
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    if (imageGenEndpointHost(provider.endpoint) === target) return provider;
  }
  return null;
}

/** Auto-match a key for a keyless profile/draft against the stored LLM
 *  provider profiles (the autoMatchSttKey twin). */
export async function autoMatchImageGenKey(
  stores: Pick<StoreContainer, "providers">,
  backend: ImageGenProfile["backend"],
  endpoint: string,
): Promise<{ apiKey: string; matchedName: string } | null> {
  const match = findImageGenAutoKeyProvider(await stores.providers.listAll(), backend, endpoint);
  if (match === null || !match.apiKey) return null;
  return { apiKey: match.apiKey, matchedName: match.name };
}

/** Adapter config from a stored profile: the typed key is injected
 *  SERVER-SIDE (own-key resolution) — the secret never crosses the API
 *  boundary. */
function configFromProfile(profile: ImageGenProfile, transport?: typeof fetch): ImageGenAdapterConfig {
  return {
    endpoint: profile.endpoint,
    ...(profile.apiKey !== undefined && profile.apiKey !== "" ? { apiKey: profile.apiKey } : {}),
    ...(profile.modelId !== undefined && profile.modelId !== "" ? { model: profile.modelId } : {}),
    ...(profile.userSizes !== undefined && profile.userSizes.length > 0 ? { userSizes: profile.userSizes } : {}),
    ...(transport !== undefined ? { fetch: transport } : {}),
  };
}

/** Resolve the ADAPTER config for a saved profile (the resolveSynthesisConfig
 *  / resolveTranscriptionConfig twin): own typed key wins, then the IG-21
 *  auto-match, then the plain keyless config. The matched key is injected
 *  SERVER-SIDE — it never crosses the API boundary. */
export async function resolveAdapterConfig(
  stores: Pick<StoreContainer, "providers">,
  profile: ImageGenProfile,
  transport?: typeof fetch,
): Promise<ImageGenAdapterConfig> {
  const config = configFromProfile(profile, transport);
  if (profile.apiKey !== undefined && profile.apiKey !== "") return config;
  const match = await autoMatchImageGenKey(stores, profile.backend, profile.endpoint);
  if (match === null) return config;
  return { ...config, apiKey: match.apiKey };
}

/** The keyless dead end of the cascade, named (report step 7, promoted
 *  by the owner 2026-10-15 as the key problem — even the connection check
 *  failed): the profile has no key of its own and no keyful LLM provider
 *  profile lives on its host, so the backend refused to build. Replaces the
 *  dialect's bare «`apiKey` is required» with the remedy; the dialect's own
 *  message rides along. Route ladders map it to 400 (fail-closed unchanged). */
export class ImageGenMissingKeyError extends Error {
  constructor(endpoint: string, cause: unknown) {
    const host = imageGenEndpointHost(endpoint);
    const backendMessage = cause instanceof Error ? ` (${cause.message})` : "";
    super(
      `No API key: this profile has no key of its own and no LLM provider profile on ` +
        `${host ?? "this endpoint"} has one — enter a key in the profile or check the endpoint host` +
        backendMessage,
      { cause },
    );
    this.name = "ImageGenMissingKeyError";
  }
}

/** Build a backend from a cascade-resolved config; when construction fails
 *  on a KEYLESS config for a backend that needs a key, re-throw the failure
 *  as {@link ImageGenMissingKeyError}. Registry errors (unknown/unregistered
 *  slug) and keyless-by-design backends pass through untouched. */
export function createImageGenBackendFromCascade(
  backend: ImageGenProfile["backend"],
  config: ImageGenAdapterConfig,
): ImageGenBackend {
  try {
    return createImageGenBackend(backend, config);
  } catch (error) {
    const keyless = config.apiKey === undefined || config.apiKey === "";
    const registryError = error instanceof ImageGenUnknownBackendError || error instanceof ImageGenBackendNotRegisteredError;
    const keyRequired = IMAGE_GEN_BACKEND_CAPABILITIES[backend]?.noApiKey === false;
    if (keyless && keyRequired && !registryError) throw new ImageGenMissingKeyError(config.endpoint, error);
    throw error;
  }
}

/** Saved-profile backend: {@link resolveAdapterConfig} +
 *  {@link createImageGenBackendFromCascade} — the one construction path every
 *  profile-scoped adapter arm uses. */
export async function createProfileBackend(
  stores: Pick<StoreContainer, "providers">,
  profile: ImageGenProfile,
  transport?: typeof fetch,
): Promise<ImageGenBackend> {
  return createImageGenBackendFromCascade(profile.backend, await resolveAdapterConfig(stores, profile, transport));
}
