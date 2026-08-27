import type { DraftTtsPreviewInput, DraftTtsVoicesInput, GenerateTtsInput } from "@vibe-tavern/api-contracts";
import type { CreateTtsProfileData, UpdateTtsProfileData } from "@vibe-tavern/db";
import type { TtsRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";

// Import backend modules for their side-effect registrations (protocol-registry
// pattern): importing the module makes its slug creatable via the registry.
import "../../domain/tts/backends/openai-tts.js";
import "../../domain/tts/backends/gemini-tts.js";
import "../../domain/tts/backends/elevenlabs-tts.js";

import { createTtsBackend } from "../../domain/tts/tts-registry.js";
import { TTS_BACKEND } from "@vibe-tavern/domain";

export class TtsAdapter implements TtsRuntimeApi {
  constructor(private readonly stores: Pick<StoreContainer, "tts">) {}

  listTtsProfiles = () => this.stores.tts.listAll();

  getTtsProfile = (id: string) => this.stores.tts.getById(id);

  createTtsProfile: TtsRuntimeApi["createTtsProfile"] = (body) => {
    // Zod-inferred input and the store input are structurally the same shape;
    // fields are mapped explicitly (no casts — house rule).
    const input: CreateTtsProfileData = {
      name: body.name,
      backend: body.backend,
      config: body.config,
      voiceId: body.voiceId,
      lang: body.lang,
      sortOrder: body.sortOrder,
      isDefault: body.isDefault,
    };
    return this.stores.tts.create(input);
  };

  updateTtsProfile: TtsRuntimeApi["updateTtsProfile"] = (id, body) => {
    const patch: UpdateTtsProfileData = { ...body };
    return this.stores.tts.update(id, patch);
  };

  deleteTtsProfile = async (id: string): Promise<void> => {
    await this.stores.tts.delete(id);
  };

  setTtsDefault: TtsRuntimeApi["setTtsDefault"] = (id) => this.stores.tts.setDefault(id);

  getDefaultTtsProfile = () => this.stores.tts.getDefault();

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
      voiceId: profile.voiceId,
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
    // request, never stored — the apiKey lives only inside the request body.
    const backend = createTtsBackend(body.backend, body.config);
    return backend.listVoices();
  };

  draftPreviewTts: TtsRuntimeApi["draftPreviewTts"] = async (body) => {
    if (body.backend === TTS_BACKEND.Kokoro) {
      throw new KokoroClientSideError();
    }
    const backend = createTtsBackend(body.backend, body.config);
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
    const backend = createTtsBackend(body.backend, body.config);
    if (typeof backend.listModels !== "function") return null;
    return backend.listModels();
  };
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
