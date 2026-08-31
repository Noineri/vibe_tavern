import type { ClientTtsProfileRecord } from "@vibe-tavern/api-contracts";
import type { DraftTtsPreviewInput, DraftTtsVoicesInput, GenerateTtsInput } from "@vibe-tavern/api-contracts";
import type { CreateTtsProfileData, UpdateTtsProfileData } from "@vibe-tavern/db";
import type { TtsProfile } from "@vibe-tavern/domain";
import { discoverLocalTtsServers } from "@vibe-tavern/domain";
import type { FetchLike } from "@vibe-tavern/domain";
import type { TtsRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";

// Import backend modules for their side-effect registrations (protocol-registry
// pattern): importing the module makes its slug creatable via the registry.
import "../../domain/tts/backends/openai-tts.js";
import "../../domain/tts/backends/gemini-tts.js";
import "../../domain/tts/backends/elevenlabs-tts.js";
import "../../domain/tts/backends/cartesia-tts.js";
import "../../domain/tts/backends/inworld-tts.js";
import "../../domain/tts/backends/lmnt-tts.js";
import "../../domain/tts/backends/minimax-tts.js";

import { createTtsBackend } from "../../domain/tts/tts-registry.js";
import { probeDockerAvailability } from "../../domain/tts/docker-probe.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";

/** Wire projection (TE2-16): the secret lives in the typed `apiKey` column
 *  and is reported as `hasStoredApiKey` — exactly like
 *  `ClientProviderProfileRecord`. `config` comes back exactly as stored: the
 *  store's strip-on-write invariant means the blob NEVER carried a key in the
 *  first place, so there is nothing to strip here (the F2b strip-on-read
 *  projection is gone with the blob keys). */
function toClientTtsProfile(profile: TtsProfile): ClientTtsProfileRecord {
	return {
		id: profile.id,
		name: profile.name,
		backend: profile.backend,
		config: profile.config,
		hasStoredApiKey: typeof profile.apiKey === "string" && profile.apiKey !== "",
		providerRef: profile.providerRef,
		autoKeyProviderName: null,
		voiceId: profile.voiceId,
		narratorVoiceId: profile.narratorVoiceId,
		lang: profile.lang,
		sortOrder: profile.sortOrder,
		isDefault: profile.isDefault,
		createdAt: profile.createdAt,
		updatedAt: profile.updatedAt,
	};
}

/** Extract a config bag's apiKey as a trimmed string ("" when absent/
 *  non-string) without mutating the bag. */
function configApiKey(config: Record<string, unknown>): string {
	const value = config.apiKey;
	return typeof value === "string" ? value.trim() : "";
}

/** Endpoint normalization for auto-matching: scheme-tolerant (a bare host
 *  gets https://), trailing slashes collapsed, case-insensitive host. */
function normalizeEndpoint(raw: string): string {
	let value = raw.trim();
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
	return value.replace(/\/+$/, "").toLowerCase();
}

/** Owner decision (2026-08-28): an LLM provider profile's key is used
 *  AUTOMATICALLY when a TTS profile's endpoint matches the provider's
 *  endpoint — that is the DEFAULT path; the user overrides by typing an own
 *  key (own key beats the provider key in resolveSynthesisConfig). Scope:
 *  endpoint-bearing OpenAI-compatible profiles only (gemini/elevenlabs have
 *  no endpoint in the bag to match on). Deterministic when several
 *  providers share the endpoint: the first in list (sort) order wins. */
async function autoMatchProviderKey(
	stores: Pick<StoreContainer, "tts" | "providers">,
	backend: TtsProfile["backend"] | DraftTtsVoicesInput["backend"],
	config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (backend !== TTS_BACKEND.OpenAiCompatible) return config;
	const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
	if (endpoint === "") return config;
	const target = normalizeEndpoint(endpoint);
	const providers = await stores.providers.listAll();
	for (const provider of providers) {
		if (!provider.apiKey) continue;
		if (normalizeEndpoint(provider.endpoint) === target) {
			return { ...config, apiKey: provider.apiKey };
		}
	}
	return config;
}

/** Resolve the SYNTHESIS config for a saved profile (TE2-16): the typed
 *  `apiKey` column and — via `providerRef` — the linked provider's key +
 *  baseUrl are injected SERVER-SIDE, so neither secret ever crosses the API
 *  boundary. Precedence: an own key beats the provider's key; an explicit
 *  `config.endpoint` beats the provider's endpoint (only endpoint-bearing
 *  backends get one injected — gemini/elevenlabs read no endpoint). A broken
 *  providerRef (missing row / no key) degrades to the plain config and lets
 *  the backend factory surface the auth error. */
async function resolveSynthesisConfig(
	stores: Pick<StoreContainer, "tts" | "providers">,
	profile: TtsProfile,
): Promise<Record<string, unknown>> {
	const config: Record<string, unknown> = { ...profile.config };
	const ownKey = profile.apiKey ?? "";
	if (ownKey !== "") {
		config.apiKey = ownKey;
		return config;
	}
	if (profile.providerRef !== null) {
		const provider = await stores.providers.getById(profile.providerRef);
		if (provider === null || !provider.apiKey) return config;
		config.apiKey = provider.apiKey;
		if (profile.backend === TTS_BACKEND.OpenAiCompatible && typeof config.endpoint !== "string") {
			config.endpoint = provider.endpoint;
		}
		return config;
	}
	// No own key, no explicit link — auto-match the endpoint against the
	// provider profiles (default-on key reuse).
	return await autoMatchProviderKey(stores, profile.backend, config);
}

/** Draft (transient) stored-key resolution — the LLM branch's test-draft
 *  pattern: the form sends NO apiKey back (reads never carried one, TE2-16);
 *  when the draft names its saved profile and the identity matches (same
 *  backend; for endpoint backends also the same endpoint — a stored key may
 *  only be reused where it was saved), the server injects the stored key for
 *  this ONE request. The key comes from the typed column (own) or, via
 *  providerRef, from the provider store — never from the config blob. Unknown
 *  profileId / mismatched identity → the config passes through untouched (the
 *  backend factory will surface an auth error if any). */
async function resolveDraftConfig(
	stores: Pick<StoreContainer, "tts" | "providers">,
	backend: DraftTtsVoicesInput["backend"],
	config: Record<string, unknown>,
	profileId: string | undefined,
): Promise<Record<string, unknown>> {
	if (configApiKey(config) !== "") return config;
	if (profileId !== undefined) {
		const profile = await stores.tts.getById(profileId);
		if (
			profile !== null &&
			profile.backend === backend &&
			!(profile.apiKey === null && profile.providerRef === null)
		) {
			// Endpoint-bearing backend: a stored key may only be reused for the
			// endpoint it was saved with (write-only key UX without letting a
			// caller aim the secret at an arbitrary replacement URL). A
			// providerRef profile resolves its endpoint from the provider, so
			// the guard compares against the effective synthesis endpoint, not
			// the raw blob.
			if (backend === TTS_BACKEND.OpenAiCompatible) {
				const incomingEndpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
				if (incomingEndpoint !== "") {
					const effective = await resolveSynthesisConfig(stores, profile);
					const storedEndpoint = typeof effective.endpoint === "string" ? effective.endpoint.trim() : "";
					if (incomingEndpoint === storedEndpoint && configApiKey(effective) !== "") return effective;
				}
			} else {
				const effective = await resolveSynthesisConfig(stores, profile);
				if (configApiKey(effective) !== "") return effective;
			}
		}
	}
	// No own key and no matching stored profile — auto-match the endpoint
	// against the provider profiles (default-on key reuse; works for an
	// unsaved draft too — a freshly typed endpoint immediately gets the
	// provider key without any linking step).
	return await autoMatchProviderKey(stores, backend, config);
}

export class TtsAdapter implements TtsRuntimeApi {
  constructor(private readonly stores: Pick<StoreContainer, "tts" | "providers">) {}

  /** Owner decision (2026-08-28): the wire record reports WHICH provider
   *  profile's key auto-matches the profile's endpoint, so the UI can show
   *  "key from «X» in use" instead of silently borrowing it. Same matching
   *  rule as autoMatchProviderKey (first provider with a key, sort order). */
  private async decorateAutoKey(records: ClientTtsProfileRecord[]): Promise<ClientTtsProfileRecord[]> {
    const providers = await this.stores.providers.listAll();
    const keyful = providers.filter((p) => p.apiKey);
    if (keyful.length === 0) return records;
    const byEndpoint = new Map(keyful.map((p) => [normalizeEndpoint(p.endpoint), p.name]));
    for (const record of records) {
      if (record.hasStoredApiKey || record.providerRef !== null) continue;
      if (record.backend !== TTS_BACKEND.OpenAiCompatible) continue;
      const endpoint = typeof record.config.endpoint === "string" ? record.config.endpoint.trim() : "";
      if (endpoint === "") continue;
      const name = byEndpoint.get(normalizeEndpoint(endpoint));
      record.autoKeyProviderName = name ?? null;
    }
    return records;
  }

  listTtsProfiles = async () => await this.decorateAutoKey((await this.stores.tts.listAll()).map(toClientTtsProfile));

  getTtsProfile = async (id: string) => {
    const profile = await this.stores.tts.getById(id);
    return profile ? (await this.decorateAutoKey([toClientTtsProfile(profile)]))[0] : null;
  };

  createTtsProfile: TtsRuntimeApi["createTtsProfile"] = async (body) => {
    // Zod-inferred input and the store input are structurally the same shape;
    // fields are mapped explicitly (no casts — house rule). The secret rides
    // the top-level write-only field (TE2-16), never the config bag.
    const input: CreateTtsProfileData = {
      name: body.name,
      backend: body.backend,
      config: body.config,
      apiKey: body.apiKey && body.apiKey !== "" ? body.apiKey : null,
      providerRef: body.providerRef && body.providerRef !== "" ? body.providerRef : null,
      voiceId: body.voiceId,
      narratorVoiceId: body.narratorVoiceId ?? null,
      lang: body.lang,
      sortOrder: body.sortOrder,
      isDefault: body.isDefault,
    };
    const created = await this.stores.tts.create(input);
    return (await this.decorateAutoKey([toClientTtsProfile(created)]))[0];
  };

  updateTtsProfile: TtsRuntimeApi["updateTtsProfile"] = async (id, body) => {
    // TE2-16 tri-state: apiKey/providerRef are `undefined` = untouched,
    // `""` = cleared, non-empty = set — the store maps them onto the typed
    // columns; the old F2b merge-on-read dance is gone.
    const updated = await this.stores.tts.update(id, { ...body });
    return updated ? (await this.decorateAutoKey([toClientTtsProfile(updated)]))[0] : null;
  };

  deleteTtsProfile = async (id: string): Promise<void> => {
    await this.stores.tts.delete(id);
  };

  setTtsDefault: TtsRuntimeApi["setTtsDefault"] = async (id) => {
    const updated = await this.stores.tts.setDefault(id);
    return updated ? (await this.decorateAutoKey([toClientTtsProfile(updated)]))[0] : null;
  };

  getDefaultTtsProfile = async () => {
    const profile = await this.stores.tts.getDefault();
    return profile ? toClientTtsProfile(profile) : null;
  };

  getTtsLinks = (id: string) => this.stores.tts.getLinks(id);

  setTtsLinks: TtsRuntimeApi["setTtsLinks"] = (id, links) => this.stores.tts.setLinks(id, links);

  listAllTtsLinks = () => this.stores.tts.listAllLinks();

  generateTtsSpeech: TtsRuntimeApi["generateTtsSpeech"] = async (body) => {
    const profile = await this.stores.tts.getById(body.profileId);
    if (!profile) return null;
    // Kokoro in-browser bypasses the route layer — the client synthesizes locally.
    if (profile.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const backend = createTtsBackend(profile.backend, await resolveSynthesisConfig(this.stores, profile));
    const result = await backend.generate({
      text: body.text,
      voiceId: body.voiceId ?? profile.voiceId,
      speed: body.speed,
      instructions: body.instructions,
    });
    return { audio: await bufferTtsAudio(result.audio), mime: result.mime };
  };

  listTtsVoices: TtsRuntimeApi["listTtsVoices"] = async (profileId) => {
    const profile = await this.stores.tts.getById(profileId);
    if (!profile) return null;
    // Kokoro runs in-browser (Web Worker) — the server registry has no
    // factory for it and never will; the web client uses its static English
    // roster. Mirror the generate path: KokoroClientSideError → the route
    // maps it to 400 instead of an unhandled TtsBackendNotRegisteredError.
    if (profile.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const backend = createTtsBackend(profile.backend, await resolveSynthesisConfig(this.stores, profile));
    return backend.listVoices();
  };

  draftListTtsVoices: TtsRuntimeApi["draftListTtsVoices"] = async (body) => {
    // Same browser-only guard as the saved-profile paths.
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    // Transient config: validated by the registry factory, used once for this
    // request, never stored. With profileId + no transient key the stored key
    // is injected server-side for this request only (write-only key UX).
    const config = await resolveDraftConfig(this.stores, body.backend, body.config, body.profileId);
    const backend = createTtsBackend(body.backend, config);
    const voices = await backend.listVoices();
    // Capabilities are read AFTER listVoices: the openai-compat backend
    // learns clone support from which voices route answered (the /voices
    // library fallback = chatterbox-style upload endpoint). voices may be
    // null (empty library / manual floor) while cloning is still available.
    return { voices, capabilities: backend.capabilities() };
  };

  cloneTtsVoiceDraft: TtsRuntimeApi["cloneTtsVoiceDraft"] = async (body) => {
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const config = await resolveDraftConfig(this.stores, body.backend, body.config, body.profileId);
    const backend = createTtsBackend(body.backend, config);
    // Gate on the capability BEFORE calling the seam (TtsBackend contract).
    // The openai-compat backend reports cloning only after listVoices saw
    // the library route — an editor that never loaded voices gets a clean
    // "not supported" here; the UI flow always loads voices first.
    if (!backend.capabilities().supportsCloning || backend.cloneVoice === undefined) {
      throw new TtsCloneUnsupportedError();
    }
    // Audio passes through memory — never persisted (plan constraint).
    return backend.cloneVoice({
      name: body.name,
      referenceAudio: body.referenceAudio,
      mimeType: body.mimeType,
    });
  };

  draftPreviewTts: TtsRuntimeApi["draftPreviewTts"] = async (body) => {
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const config = await resolveDraftConfig(this.stores, body.backend, body.config, body.profileId);
    const backend = createTtsBackend(body.backend, config);
    const result = await backend.generate({
      text: body.text,
      voiceId: body.voiceId,
      speed: body.speed,
      instructions: body.instructions,
    });
    return { audio: await bufferTtsAudio(result.audio), mime: result.mime };
  };

  draftListTtsModels: TtsRuntimeApi["draftListTtsModels"] = async (body) => {
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const baseConfig = await resolveDraftConfig(this.stores, body.backend, body.config, body.profileId);
    const config: Record<string, unknown> = { ...baseConfig };
    if (body.modelFilter !== undefined) {
      config.modelFilter = body.modelFilter;
    }
    const backend = createTtsBackend(body.backend, config);
    if (typeof backend.listModels !== "function") return null;
    return backend.listModels();
  };

  probeLocalDocker = () => probeDockerAvailability();

  discoverLocalTts = () => {
    // Server-side fetch satisfies the pure prober's FetchLike seam (the
    // method/headers/signal subset of RequestInit); discovery runs in the API
    // process so CORS-less local servers stay reachable.
    const serverFetch: FetchLike = discoveryFetchOverride ?? ((input, init) => fetch(input, init));
    return discoverLocalTtsServers(serverFetch);
  };
}

/** Test seam for the discovery route — swaps the network fetch the pure
 *  prober runs against (the docker-probe runner seam is the precedent).
 *  Null restores the real server-side fetch. */
let discoveryFetchOverride: FetchLike | null = null;

export function __setDiscoveryFetchForTests(fetch: FetchLike | null): void {
  discoveryFetchOverride = fetch;
}

/** Normalize a backend audio result (Buffer or chunk stream) to a single
 *  buffer — paragraph-level buffering is the v1 design; byte-level SSE is
 *  unnecessary. Shared by the saved-profile and draft preview paths. */
async function bufferTtsAudio(audio: Buffer | AsyncIterable<Buffer>): Promise<Buffer> {
  if (Buffer.isBuffer(audio)) return audio;
  const chunks: Buffer[] = [];
  for await (const chunk of audio) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class KokoroClientSideError extends Error {
  constructor() {
    super("kokoro runs client-side");
    this.name = "KokoroClientSideError";
  }
}

/** The backend declared no clone capability (or the seam is absent) — the
 *  route maps this to a clean 400, not an upstream-flavored 500. */
export class TtsCloneUnsupportedError extends Error {
  constructor() {
    super("this TTS backend does not support voice cloning");
    this.name = "TtsCloneUnsupportedError";
  }
}
