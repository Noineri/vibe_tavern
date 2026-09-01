/**
 * @module adapters/stt-adapter
 *
 * Wire adapter for STT profiles (STT_PLAN ST-5b): CRUD projection over the
 * SttStore + the server-side transcription path (`transcribeSttAudio`).
 * Mirrors `tts-adapter.ts` — same TE2-16 key rules (the secret lives in the
 * typed `api_key` column, reported to the client as `hasStoredApiKey`,
 * never in the config bag), same auto-key hint decoration, same write-only
 * tri-state on update.
 *
 * KEY RESOLUTION for a server backend (openai-compat), in precedence order:
 *  1. the profile's OWN typed key wins;
 *  2. otherwise the endpoint auto-match: first an LLM provider profile whose
 *     endpoint matches (the TTS default-on reuse, extended here), then an
 *     openai-compat TTS profile whose endpoint matches and whose typed key
 *     column is non-empty (ST-5b decision — the same vendor key often powers
 *     both TTS and STT, so linking a key twice is friction for no benefit);
 *  3. otherwise the config passes through and the backend factory surfaces
 *     whatever auth error applies.
 *
 * The openai-compat STT backend self-registers via a side-effect import here
 * (protocol-registry pattern) — this file is its home, relocated from the
 * temporary spot in `tts-adapter.ts`.
 */

import type {
  ClientSttProfileRecord,
  CreateSttProfileInput,
  UpdateSttProfileInput,
} from "@vibe-tavern/api-contracts";
import type { CreateSttProfileData, UpdateSttProfileData, StoreContainer } from "@vibe-tavern/db";
import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfile, SttProfileConfig } from "@vibe-tavern/domain";

import type { SttRuntimeApi } from "../contract/runtime-api.js";

// Import backend modules for their side-effect registrations (protocol-registry
// pattern): importing the module makes its slug creatable via the registry.
// This is the STT twin of the TTS backend import block in tts-adapter.ts;
// the STT openai-compat adapter originally landed here in a temporary spot
// (ST-5a) and now owns this file.
import "../../domain/stt/backends/openai-stt.js";

import { createSttBackend } from "../../domain/stt/stt-registry.js";
import {
  OpenAiCompatSttConfigError,
  OpenAiCompatSttError,
} from "../../domain/stt/backends/openai-stt.js";

// ─── Wire projections ────────────────────────────────────────────────────────

/** TE2-16 wire projection: the secret lives in the typed `apiKey` column and
 *  is reported as `hasStoredApiKey` — `config` comes back exactly as stored
 *  (the store's strip-on-write invariant means the blob NEVER carried a key;
 *  ST-1). `autoKeyProviderName` names the provider profile whose endpoint
 *  auto-matches (default-on reuse hint). */
function toClientSttProfile(profile: SttProfile): ClientSttProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    backend: profile.backend,
    config: profile.config,
    hasStoredApiKey: typeof profile.apiKey === "string" && profile.apiKey !== "",
    autoKeyProviderName: null,
    emotionAnnotation: profile.emotionAnnotation,
    isDefault: profile.isDefault,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/** Endpoint normalization for auto-matching: scheme-tolerant (a bare host
 *  gets https://), trailing slashes collapsed, case-insensitive host. Copy of
 *  the tts-adapter helper (kept local; not exported from there). */
function normalizeEndpoint(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "").toLowerCase();
}

// ─── Auto-key resolution ─────────────────────────────────────────────────────

/** Auto-match the transcription key by endpoint. Precedence over the LLM
 *  provider profiles AND openai-compat TTS profiles (ST-5b) —
 *  deterministic: first in list (sort) order wins. Own-key/provided-key
 *  configs short-circuit before this runs. */
async function autoMatchSttKey(
  stores: Pick<StoreContainer, "providers" | "tts">,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
  if (endpoint === "") return config;

  // LLM provider profiles (the TTS default-on reuse).
  const providers = await stores.providers.listAll();
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    if (normalizeEndpoint(provider.endpoint) === normalizeEndpoint(endpoint)) {
      return { ...config, apiKey: provider.apiKey };
    }
  }

  // openai-compat TTS profiles — same vendor key often powers both sides.
  const ttsProfiles = await stores.tts.listAll();
  for (const profile of ttsProfiles) {
    if (profile.backend !== "openai-compatible") continue;
    const key = profile.apiKey ?? "";
    if (key === "") continue;
    const ttsEndpoint = typeof profile.config.endpoint === "string" ? profile.config.endpoint.trim() : "";
    if (ttsEndpoint === "") continue;
    if (normalizeEndpoint(ttsEndpoint) === normalizeEndpoint(endpoint)) {
      return { ...config, apiKey: key };
    }
  }

  return config;
}

/** Resolve the TRANSCRIPTION config for a saved profile: the typed `apiKey`
 *  column is injected SERVER-SIDE (own key wins), then the endpoint
 *  auto-match (providers and TTS profiles) — the secret never crosses the
 *  API boundary. A profile with no key and no match degrades to the plain
 *  config and lets the backend factory surface the auth error. */
async function resolveTranscriptionConfig(
  stores: Pick<StoreContainer, "providers" | "tts">,
  profile: SttProfile,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = { ...profile.config };
  const ownKey = profile.apiKey ?? "";
  if (ownKey !== "") {
    config.apiKey = ownKey;
    return config;
  }
  return await autoMatchSttKey(stores, config);
}

// ─── Errors (route → status mapping) ─────────────────────────────────────────

/** The backend runs in the browser (whisper-browser) — the server has no
 *  factory for it and never will; the web client transcribes locally.
 *  Mirrors KokoroClientSideError in tts-adapter. */
export class SttClientSideError extends Error {
  constructor() {
    super("whisper-browser runs client-side");
    this.name = "SttClientSideError";
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

/** Deps mirror the tts adapter's store slice plus the TTS store for the
 *  cross-side auto-key reuse. */
type SttAdapterStores = Pick<StoreContainer, "stt" | "providers" | "tts">;

export class SttAdapter implements SttRuntimeApi {
  constructor(private readonly stores: SttAdapterStores) {}

  /** Auto-key HINT (UI display only): which provider profile's key
   *  auto-matches the profile's endpoint — same rule as decorateAutoKey in
   *  tts-adapter. */
  private async decorateAutoKey(records: ClientSttProfileRecord[]): Promise<ClientSttProfileRecord[]> {
    const providers = await this.stores.providers.listAll();
    const keyful = providers.filter((p) => p.apiKey);
    if (keyful.length === 0) return records;
    const byEndpoint = new Map(keyful.map((p) => [normalizeEndpoint(p.endpoint), p.name]));
    for (const record of records) {
      if (record.hasStoredApiKey) continue;
      if (record.backend !== STT_BACKENDS.OpenAiCompat) continue;
      const endpoint = typeof record.config.endpoint === "string" ? record.config.endpoint.trim() : "";
      if (endpoint === "") continue;
      const name = byEndpoint.get(normalizeEndpoint(endpoint));
      record.autoKeyProviderName = name ?? null;
    }
    return records;
  }

  listSttProfiles = async () =>
    await this.decorateAutoKey((await this.stores.stt.listAll()).map(toClientSttProfile));

  getSttProfile = async (id: string) => {
    const profile = await this.stores.stt.getById(id);
    return profile ? (await this.decorateAutoKey([toClientSttProfile(profile)]))[0] : null;
  };

  createSttProfile: SttRuntimeApi["createSttProfile"] = async (body) => {
    // Zod-inferred input and the store input are structurally the same shape;
    // fields are mapped explicitly (no casts — house rule). The secret rides
    // the top-level write-only field (ST-1), never the config bag.
    const input: CreateSttProfileData = {
      name: body.name,
      backend: body.backend,
      config: body.config,
      apiKey: body.apiKey && body.apiKey !== "" ? body.apiKey : undefined,
      emotionAnnotation: body.emotionAnnotation ?? false,
      isDefault: body.isDefault ?? false,
    };
    const created = await this.stores.stt.create(input);
    return (await this.decorateAutoKey([toClientSttProfile(created)]))[0];
  };

  updateSttProfile: SttRuntimeApi["updateSttProfile"] = async (id, body) => {
    // ST-1 tri-state: apiKey is `undefined` = untouched, `""` = cleared,
    // non-empty = set — the store maps it onto the typed column; the
    // backend-flip key clearing is the store's job too.
    const updated = await this.stores.stt.update(id, { ...body });
    return updated ? (await this.decorateAutoKey([toClientSttProfile(updated)]))[0] : null;
  };

  deleteSttProfile = async (id: string): Promise<void> => {
    await this.stores.stt.delete(id);
  };

  setSttDefault: SttRuntimeApi["setSttDefault"] = async (id) => {
    const updated = await this.stores.stt.setDefault(id);
    return updated ? (await this.decorateAutoKey([toClientSttProfile(updated)]))[0] : null;
  };

  getDefaultSttProfile = async () => {
    const profile = await this.stores.stt.getDefault();
    return profile ? toClientSttProfile(profile) : null;
  };

  transcribeSttAudio: SttRuntimeApi["transcribeSttAudio"] = async (profileId, audio, language) => {
    const profile = await this.stores.stt.getById(profileId);
    if (!profile) return null;
    // In-browser Whisper: the server has no factory — the client transcribes
    // locally (mirrors the TTS Kokoro path; the route maps this to a clean
    // 400 instead of an unhandled registry error).
    if (profile.backend === STT_BACKENDS.WhisperBrowser) {
      throw new SttClientSideError();
    }
    // The transcription key rides the loose config bag (ST-5a boundary cast:
    // the factory's parseConfig reads it off `SttProfileConfig` via its own
    // type-erased view). The stored union never carries it (ST-1). A
    // per-request language OVERRIDES the profile's config hint (the factory
    // reads language from the bag).
    const resolved = await resolveTranscriptionConfig(this.stores, profile);
    if (language !== undefined && language !== "") {
      resolved.language = language;
    }
    const resolvedConfig = resolved as SttProfileConfig;
    const backend = createSttBackend(profile.backend, resolvedConfig);
    const result = await backend.transcribe(audio.buffer, {
      mime: audio.mimeType,
    });
    return { text: result.text, ...(result.language !== undefined ? { language: result.language } : {}) };
  };
}