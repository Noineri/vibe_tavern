import type { ClientTtsProfileRecord } from "@vibe-tavern/api-contracts";
import type { DraftTtsPreviewInput, DraftTtsVoicesInput, GenerateTtsInput } from "@vibe-tavern/api-contracts";
import type { CreateTtsProfileData, UpdateTtsProfileData } from "@vibe-tavern/db";
import type { TtsProfile } from "@vibe-tavern/domain";
import type { TtsRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";

// Import backend modules for their side-effect registrations (protocol-registry
// pattern): importing the module makes its slug creatable via the registry.
import "../../domain/tts/backends/openai-tts.js";
import "../../domain/tts/backends/gemini-tts.js";
import "../../domain/tts/backends/elevenlabs-tts.js";

import { createTtsBackend } from "../../domain/tts/tts-registry.js";
import { probeDockerAvailability } from "../../domain/tts/docker-probe.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";

/** Strip-on-read wire projection (F2b): the secret never crosses the
 *  boundary — `config.apiKey` is removed and reported as `hasStoredApiKey`,
 *  exactly like `ClientProviderProfileRecord`. */
function toClientTtsProfile(profile: TtsProfile): ClientTtsProfileRecord {
	const config = { ...profile.config };
	const hasStoredApiKey = typeof config.apiKey === "string" && config.apiKey !== "";
	delete config.apiKey;
	return {
		id: profile.id,
		name: profile.name,
		backend: profile.backend,
		config,
		hasStoredApiKey,
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

/** Merge-on-write (F2b): an incoming config whose apiKey is empty/absent
 *  means "keep the stored key" — the form always re-sends the whole bag, so
 *  absent is expressed as empty. Guards: the stored key survives only when
 *  the backend is unchanged (never leaks across backends) and only when the
 *  stored row actually had one. */
function mergeStoredApiKey(
	existing: TtsProfile,
	incomingConfig: Record<string, unknown>,
	incomingBackend: TtsProfile["backend"] | undefined,
): Record<string, unknown> {
	const storedKey = configApiKey(existing.config);
	if (storedKey === "") return incomingConfig;
	if (incomingBackend !== undefined && incomingBackend !== existing.backend) return incomingConfig;
	if (configApiKey(incomingConfig) !== "") return incomingConfig;
	return { ...incomingConfig, apiKey: existing.config.apiKey };
}

/** Draft (transient) stored-key resolution — the LLM branch's test-draft
 *  pattern: a strip-on-read form sends NO apiKey back; when the draft names
 *  its saved profile and the identity matches (same backend; for endpoint
 *  backends also the same endpoint — a stored key may only be reused where
 *  it was saved), the server injects the stored key for this ONE request.
 *  Unknown profileId / mismatched identity → the config passes through
 *  untouched (the backend factory will surface an auth error if any). */
async function resolveDraftConfig(
	stores: Pick<StoreContainer, "tts">,
	backend: DraftTtsVoicesInput["backend"],
	config: Record<string, unknown>,
	profileId: string | undefined,
): Promise<Record<string, unknown>> {
	if (configApiKey(config) !== "") return config;
	if (profileId === undefined) return config;
	const profile = await stores.tts.getById(profileId);
	if (profile === null) return config;
	if (profile.backend !== backend) return config;
	const storedKey = configApiKey(profile.config);
	if (storedKey === "") return config;
	// Endpoint-bearing backend: a stored key may only be reused for the
	// endpoint it was saved with (write-only key UX without letting a caller
	// aim the secret at an arbitrary replacement URL).
	if (backend === TTS_BACKEND.OpenAiCompatible) {
		const incomingEndpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
		const storedEndpoint = typeof profile.config.endpoint === "string" ? profile.config.endpoint.trim() : "";
		if (incomingEndpoint !== storedEndpoint) return config;
	}
	return { ...config, apiKey: profile.config.apiKey };
}

export class TtsAdapter implements TtsRuntimeApi {
  constructor(private readonly stores: Pick<StoreContainer, "tts">) {}

  listTtsProfiles = async () => (await this.stores.tts.listAll()).map(toClientTtsProfile);

  getTtsProfile = async (id: string) => {
    const profile = await this.stores.tts.getById(id);
    return profile ? toClientTtsProfile(profile) : null;
  };

  createTtsProfile: TtsRuntimeApi["createTtsProfile"] = async (body) => {
    // Zod-inferred input and the store input are structurally the same shape;
    // fields are mapped explicitly (no casts — house rule).
    const input: CreateTtsProfileData = {
      name: body.name,
      backend: body.backend,
      config: body.config,
      voiceId: body.voiceId,
      narratorVoiceId: body.narratorVoiceId ?? null,
      lang: body.lang,
      sortOrder: body.sortOrder,
      isDefault: body.isDefault,
    };
    const created = await this.stores.tts.create(input);
    return toClientTtsProfile(created);
  };

  updateTtsProfile: TtsRuntimeApi["updateTtsProfile"] = async (id, body) => {
    // Merge-on-write first (see mergeStoredApiKey): the stored key survives
    // an empty-key update — then a plain store patch.
    let config = body.config;
    if (config !== undefined) {
      const existing = await this.stores.tts.getById(id);
      if (existing) config = mergeStoredApiKey(existing, config, body.backend);
    }
    const patch: UpdateTtsProfileData = { ...body, ...(config !== undefined ? { config } : {}) };
    const updated = await this.stores.tts.update(id, patch);
    return updated ? toClientTtsProfile(updated) : null;
  };

  deleteTtsProfile = async (id: string): Promise<void> => {
    await this.stores.tts.delete(id);
  };

  setTtsDefault: TtsRuntimeApi["setTtsDefault"] = async (id) => {
    const updated = await this.stores.tts.setDefault(id);
    return updated ? toClientTtsProfile(updated) : null;
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
    const backend = createTtsBackend(profile.backend, profile.config);
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
    const backend = createTtsBackend(profile.backend, profile.config);
    return backend.listVoices();
  };

  draftListTtsVoices: TtsRuntimeApi["draftListTtsVoices"] = async (body) => {
    // Same browser-only guard as the saved-profile paths.
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    // Transient config: validated by the registry factory, used once for this
    // request, never stored. With profileId + no transient key the stored key
    // is injected server-side for this request only (strip-on-read UX).
    const config = await resolveDraftConfig(this.stores, body.backend, body.config, body.profileId);
    const backend = createTtsBackend(body.backend, config);
    return backend.listVoices();
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
