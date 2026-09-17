/**
 * @module adapters/image-gen-adapter
 *
 * Wire adapter for image-gen profiles (IMAGE_GENERATION_PLAN IG-8): CRUD
 * projection over the ImageGenStore + the probe/models/samplers/generate/
 * gallery arms. Mirrors `stt-adapter.ts` in structure — same hasStoredApiKey
 * projection semantics (the secret lives in the typed `apiKey` column, never
 * in a JSON blob), same write-only tri-state on update.
 *
 * KEY RESOLUTION (IG-21, owner decision 2026-09-15 — the STT/TTS auto-key
 * mechanism reused): a profile WITHOUT its own stored key auto-matches at
 * the execution seam — **openrouter**: the first keyful LLM provider whose
 * endpoint lives on the OpenRouter vendor host; **openai-images (Custom
 * cloud)**: exact normalized-endpoint match over keyful LLM providers (the
 * openai-compat rule). a1111 is local/keyless (out of scope). The profile's
 * OWN typed key always overrides; a keyless no-match profile passes through
 * to the backend factory which surfaces whatever auth error applies. The
 * wire records carry the same hint the STT editor shows ("key will be taken
 * from profile X") via decorateAutoKey — two mirrors, one rule (the STT
 * discipline: the client mirror in imagegen-form-helpers.ts must stay in
 * lockstep with autoMatchImageGenKey below).
 *
 * The three backend adapters self-register via side-effect imports here
 * (protocol-registry pattern, the stt-adapter twin) — importing this module
 * makes every v1 slug creatable through the image-gen registry.
 *
 * GENERATE (the image message slot, design-locked semantics): resolve the
 * chat + profile, merge the profile's per-mode size presets and default
 * params with the request's fine-tuning overrides, build the prompt via the
 * IG-14 mode module (Images-tab template → MacroEngine → chat context; free
 * wraps the caller text), call the backend with the route's AbortSignal (NO
 * timeout constants — the owner's ban), persist each returned image as a
 * FLAT asset (the bytes never leave the server; the cloud-URL-expiry rule),
 * and append one message carrying the attachment + slot provenance
 * (role/authorType `assistant`, empty content — the slot renders from its
 * attachment and never enters the RP prompt; context participation is the
 * IG-18 include-in-prompt opt-in only).
 */

import { conflict, validation } from "../../shared/errors.js";
import type {
  CreateImageGenProfileInput,
  DraftImageGenModelsInput,
  FavoriteImageGenModelInput,
  GenerateImageGenInput,
  ImageGenGenerateResponseValue,
  ImageGenGalleryPromoteResponseValue,
  ImageGenModelFavoriteValue,
  ImageGenModelInfoValue,
  ImageGenModelSettingsOverlayValue,
  ImageGenModelSettingsValue,
  ImageGenProbeResultValue,
  ImageGenProfileValue,
  ImageGenSamplerInfoValue,
  ImageGenSchedulerInfoValue,
  ImageGenSamplerSet,
  ImageGenSamplerSetCreate,
  ImageGenSamplerSetImport,
  ImageGenSamplerSetList,
  ImageGenSamplerSetUpdate,
  UpdateImageGenProfileInput,
} from "@vibe-tavern/api-contracts";
import { imageGenSamplerSetPayloadSchema } from "@vibe-tavern/api-contracts";
import type {
  CreateImageGenProfileData,
  StoreContainer,
  UpdateImageGenProfileData,
} from "@vibe-tavern/db";
import type { Attachment, ImageGenModelSettings, ImageGenProfile, ImageGenSlotProvenance } from "@vibe-tavern/domain";
import { parseStoredAttachments, IMAGE_GEN_ADETAILER_DEFAULT_MODEL, IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type { AssetService } from "../../domain/asset/asset-service.js";
import {
  buildImageGenPrompts,
  ImageGenModeValidationError,
  type ImageGenAssistRunner,
} from "../../domain/chat/imagegen-modes.js";
import type {
  ImageGenAdapterConfig,
  ImageGenGenerateRequest,
} from "../../domain/imagegen/imagegen-backend.js";
import { IMAGE_GENERATION_CLOUD_TIMEOUT_MS, withImageGenTimeoutMs } from "../../domain/imagegen/imagegen-backend.js";
import { TEST_CHAT_TIMEOUT_MS } from "../../domain/providers/provider-transport.js";
import { createImageGenBackend } from "../../domain/imagegen/imagegen-registry.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import {
  providerRequiresApiKey,
  resolveEffectiveSummaryProfile,
} from "../../domain/chat/summary-generation-seam.js";
import type { AssemblePromptResponse, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ImageGenRuntimeApi } from "../contract/runtime-api.js";

// Import backend modules for their side-effect registrations (the
// stt-adapter twin): importing the module makes its slug creatable via the
// registry; the route layer reaches every backend through this file.
import "../../domain/imagegen/backends/openrouter.js";
import "../../domain/imagegen/backends/openai-images.js";
import "../../domain/imagegen/backends/a1111.js";
import "../../domain/imagegen/backends/comfyui.js";

// ─── Route-ladder errors ─────────────────────────────────────────────────────

/** A profile / chat / asset the request names does not exist (route → 404). */
export class ImageGenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenNotFoundError";
  }
}

/** A timed-out CLOUD call (route → 504) — re-exported for the route ladder
 *  (definition lives with the timeout helper in the domain module). */
export { ImageGenTimeoutError } from "../../domain/imagegen/imagegen-backend.js";

/** A well-formed request that names an inconsistent state (route → 400). */
export class ImageGenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenValidationError";
  }
}

// ─── IG-15 LLM-assist quiet-call seam ───────────────────────────────────────

/** The provider surface the assist runner needs — the narrow slice of
 *  ProviderProfileService (duck-typed so tests inject a stub, tier T1). */
export interface ImageGenAssistProviderLookup {
  getProviderProfile(id: string): Promise<StoredProviderProfileRecord | null>;
  getProviderModelSettings(
    providerProfileId: string,
    modelId: string,
  ): Promise<{ settings: Record<string, unknown> | null } | null>;
}

/** Quiet-call dependencies (constructor DI seam): the provider lookup + the
 *  executor (defaulting to the real nonstreamingProviderExecute — the
 *  chat-summary constructor pattern). */
export interface ImageGenAssistDeps {
  providerProfiles: ImageGenAssistProviderLookup;
  execute?: (input: ProviderExecutionInput) => ReturnType<typeof nonstreamingProviderExecute>;
}

// ─── Wire projections ────────────────────────────────────────────────────────

/** IG-1 key rule (the TE2-16/ST-1 projection): the secret lives in the typed
 *  `apiKey` column and is reported as `hasStoredApiKey` — it never crosses
 *  the boundary on a read; every JSON blob was strip-on-write in the store. */
function toClientProfile(profile: ImageGenProfile): ImageGenProfileValue {
  const record: ImageGenProfileValue = {
    id: profile.id,
    name: profile.name,
    backend: profile.backend,
    endpoint: profile.endpoint,
    hasStoredApiKey: typeof profile.apiKey === "string" && profile.apiKey !== "",
    autoKeyProviderName: null,
    defaultParams: profile.defaultParams,
    modeSizePresets: profile.modeSizePresets,
    ...(profile.userSizes !== undefined && profile.userSizes.length > 0 ? { userSizes: profile.userSizes } : {}),
    llmAssistEnabled: profile.llmAssistEnabled,
    capabilities: profile.capabilities,
    sortOrder: profile.sortOrder,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
  if (profile.presetId !== undefined) record.presetId = profile.presetId;
  if (profile.modelId !== undefined) record.modelId = profile.modelId;
  if (profile.llmProviderProfileId !== undefined) record.llmProviderProfileId = profile.llmProviderProfileId;
  if (profile.llmModelId !== undefined) record.llmModelId = profile.llmModelId;
  return record;
}

/** Per-model overlay row → wire record (the branded FK flattens to
 *  `profileId`, timestamps pass through as strings — toClientProfile's
 *  shape for the IG-12b rows). */
function toClientModelSettings(row: ImageGenModelSettings): ImageGenModelSettingsValue {
  return {
    id: row.id,
    profileId: row.imageGenProfileId,
    modelId: row.modelId,
    settings: row.settings,
    samplerSetId: row.samplerSetId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Map a store row onto the image-gen sampler-set wire shape (payload is a
 *  parsed record; the store-row type is structurally compatible). */
function imageGenSamplerSetRowToWire(row: {
  id: string;
  name: string;
  sortOrder: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}): ImageGenSamplerSet {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    payload: row.payload as ImageGenSamplerSet["payload"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Case-insensitive name-collision probe shared by create / rename / import
 *  — the SamplerSetAdapter rule verbatim (trim + lowercase, excluding self). */
async function assertImageGenSetNameAvailable(
  stores: ImageGenAdapterStores,
  name: string,
  selfId: string | null,
): Promise<void> {
  const trimmed = name.trim().toLowerCase();
  const rows = await stores.imageGenSamplerSets.list();
  const existing = rows.find((row) => row.name.trim().toLowerCase() === trimmed && row.id !== selfId);
  if (existing) {
    throw conflict(`An image-gen sampler set named '${name.trim()}' already exists.`, {
      samplerSetId: existing.id,
    });
  }
}

/** Adapter config from a stored profile: the typed key is injected
 *  SERVER-SIDE (own-key resolution) — the secret never crosses the API
 *  boundary. */
function configFromProfile(
  profile: ImageGenProfile,
  transport?: typeof fetch,
): ImageGenAdapterConfig {
  const config: ImageGenAdapterConfig = {
    endpoint: profile.endpoint,
    ...(profile.apiKey !== undefined && profile.apiKey !== "" ? { apiKey: profile.apiKey } : {}),
    ...(profile.modelId !== undefined && profile.modelId !== "" ? { model: profile.modelId } : {}),
    ...(profile.userSizes !== undefined && profile.userSizes.length > 0 ? { userSizes: profile.userSizes } : {}),
    ...(transport !== undefined ? { fetch: transport } : {}),
  };
  return config;
}

// ─── IG-21 auto-key cascade (the stt-adapter twin) ──────────────────────

/** Endpoint normalization for auto-matching: scheme-tolerant (a bare host
 *  gets https://), trailing slashes collapsed, case-insensitive host. Copy
 *  of the stt-adapter/tts-adapter helper (kept local; not exported from
 *  there). Client mirror: normalizeImageGenEndpoint in
 *  apps/web/…/imagegen/imagegen-form-helpers.ts — keep in lockstep. */
function normalizeEndpoint(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "").toLowerCase();
}

/** Vendor host for the OpenRouter backend — the auto-key match key: the
 *  profile's endpoint may carry any OpenRouter path shape, so the match is
 *  prefix-based on the host (the STT fixed-vendor rule), not exact. */
const OPENROUTER_API_HOST = "https://openrouter.ai";

/** Auto-match an image-gen profile's key against the LLM provider profiles
 *  (IG-21, the autoMatchSttKey twin). Deterministic: first keyful provider
 *  in list (sort) order wins. Rules per backend:
 *  - openrouter: first keyful provider whose endpoint lives on the OpenRouter
 *    vendor host (any path under openrouter.ai);
 *  - openai-images: exact normalized-endpoint match (the openai-compat rule —
 *    a Custom-cloud row shares the key only with the exact same endpoint);
 *  - a1111: local/keyless — never matches.
 *  Own-key configs short-circuit BEFORE this runs (resolveAdapterConfig). */
async function autoMatchImageGenKey(
  stores: Pick<StoreContainer, "providers">,
  backend: ImageGenProfile["backend"],
  endpoint: string,
): Promise<{ apiKey: string; matchedName: string } | null> {
  if (backend !== IMAGE_GEN_BACKENDS.OpenRouter && backend !== IMAGE_GEN_BACKENDS.OpenAiImages) {
    return null;
  }
  const target = normalizeEndpoint(endpoint);
  if (target === "") return null;
  const providers = await stores.providers.listAll();
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    const normalized = normalizeEndpoint(provider.endpoint);
    const matched =
      backend === IMAGE_GEN_BACKENDS.OpenRouter
        ? normalized.startsWith(OPENROUTER_API_HOST)
        : normalized === target;
    if (matched) return { apiKey: provider.apiKey, matchedName: provider.name };
  }
  return null;
}

/** Resolve the ADAPTER config for a saved profile (the resolveSynthesisConfig
 *  / resolveTranscriptionConfig twin): own typed key wins, then the IG-21
 *  auto-match, then the plain config (the backend factory surfaces the auth
 *  error). The matched key is injected SERVER-SIDE — it never crosses the API
 *  boundary. */
async function resolveAdapterConfig(
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

// ─── Adapter ─────────────────────────────────────────────────────────────────

type ImageGenAdapterStores = Pick<
  StoreContainer,
  "imageGen" | "imageGenSamplerSets" | "chats" | "messages" | "characterAssets" | "db" | "characters" | "personas" | "providers"
>;

export class ImageGenAdapter implements ImageGenRuntimeApi {
  constructor(
    private readonly stores: ImageGenAdapterStores,
    private readonly assetService: AssetService,
    /** Transport DI seam (tier T1): tests inject a fetch double here and every
     *  backend HTTP call (probe/models/samplers/generate + the server-side
     *  image download inside the adapters) goes through it; production passes
     *  nothing and the adapters' global-fetch default applies. */
    private readonly fetchOverride?: typeof fetch,
    /** IG-15 quiet-call seam (tier T1): the LLM profile lookup + executor the
     *  assist pre-pass uses. Absent = assist never fires (the generate path
     *  treats an enabled assist with no deps as a configuration error). */
    private readonly assistDeps?: ImageGenAssistDeps,
  ) {}

  /** Auto-key HINT (UI display only, IG-21 — the stt-adapter twin): which
   *  provider profile's key auto-matches for a keyless profile. The SAME
   *  rule as autoMatchImageGenKey (first keyful provider in sort order;
   *  openrouter by vendor host, openai-images by exact endpoint, a1111
   *  never). Records with a stored key stay null — an own key overrides. */
  private async decorateAutoKey(records: ImageGenProfileValue[]): Promise<ImageGenProfileValue[]> {
    if (records.length === 0) return records;
    const providers = await this.stores.providers.listAll();
    const keyful = providers.filter((p) => p.apiKey);
    if (keyful.length === 0) return records;
    const byEndpoint = new Map(keyful.map((p) => [normalizeEndpoint(p.endpoint), p.name]));
    const openrouterName = keyful.find((p) =>
      normalizeEndpoint(p.endpoint).startsWith(OPENROUTER_API_HOST),
    )?.name;
    for (const record of records) {
      if (record.hasStoredApiKey) continue;
      if (record.backend === IMAGE_GEN_BACKENDS.OpenRouter) {
        record.autoKeyProviderName = openrouterName ?? null;
      } else if (record.backend === IMAGE_GEN_BACKENDS.OpenAiImages) {
        const endpoint = record.endpoint.trim();
        if (endpoint === "") continue;
        record.autoKeyProviderName = byEndpoint.get(normalizeEndpoint(endpoint)) ?? null;
      }
    }
    return records;
  }

  // ── Profile CRUD ────────────────────────────────────────────────────────

  listImageGenProfiles = async () =>
    await this.decorateAutoKey((await this.stores.imageGen.listAll()).map(toClientProfile));

  getImageGenProfile = async (id: string) => {
    const profile = await this.stores.imageGen.getById(id);
    return profile ? (await this.decorateAutoKey([toClientProfile(profile)]))[0] : null;
  };

  createImageGenProfile: ImageGenRuntimeApi["createImageGenProfile"] = async (body) => {
    // Zod-inferred input and the store input are structurally the same shape;
    // fields are mapped explicitly (no casts — house rule). The secret rides
    // the top-level write-only field, never a JSON blob.
    const input: CreateImageGenProfileData = {
      name: body.name,
      backend: body.backend,
      presetId: body.presetId,
      endpoint: body.endpoint,
      apiKey: body.apiKey && body.apiKey !== "" ? body.apiKey : undefined,
      modelId: body.modelId,
      defaultParams: body.defaultParams,
      modeSizePresets: body.modeSizePresets,
      userSizes: body.userSizes,
      llmAssistEnabled: body.llmAssistEnabled,
      llmProviderProfileId: body.llmProviderProfileId,
      llmModelId: body.llmModelId,
      capabilities: body.capabilities,
      sortOrder: body.sortOrder,
    };
    return (await this.decorateAutoKey([toClientProfile(await this.stores.imageGen.create(input))]))[0];
  };

  updateImageGenProfile: ImageGenRuntimeApi["updateImageGenProfile"] = async (id, body) => {
    // Tri-state apiKey (`undefined` = keep, `""` = clear, non-empty = set) and
    // the backend-flip key hygiene are the STORE's rules — the patch maps
    // field-by-field onto UpdateImageGenProfileData.
    const patch: UpdateImageGenProfileData = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.backend !== undefined) patch.backend = body.backend;
    if (body.presetId !== undefined) patch.presetId = body.presetId;
    if (body.endpoint !== undefined) patch.endpoint = body.endpoint;
    if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
    if (body.modelId !== undefined) patch.modelId = body.modelId;
    if (body.defaultParams !== undefined) patch.defaultParams = body.defaultParams;
    if (body.modeSizePresets !== undefined) patch.modeSizePresets = body.modeSizePresets;
    if (body.userSizes !== undefined) patch.userSizes = body.userSizes;
    if (body.llmAssistEnabled !== undefined) patch.llmAssistEnabled = body.llmAssistEnabled;
    if (body.llmProviderProfileId !== undefined) patch.llmProviderProfileId = body.llmProviderProfileId;
    if (body.llmModelId !== undefined) patch.llmModelId = body.llmModelId;
    if (body.capabilities !== undefined) patch.capabilities = body.capabilities;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    const updated = await this.stores.imageGen.update(id, patch);
    return updated ? (await this.decorateAutoKey([toClientProfile(updated)]))[0] : null;
  };

  deleteImageGenProfile = async (id: string): Promise<void> => {
    await this.stores.imageGen.delete(id);
  };

  // ── Probe / models / samplers ───────────────────────────────────────────

  probeImageGenProfile = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Probe rides the SAME timeout budget as the LLM provider test
    // (TEST_CHAT_TIMEOUT_MS, owner 2026-09-14) — one budget for "is this
    // endpoint alive" across surfaces.
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "probe", (inner) => backend.probe(inner));
  };

  listImageGenProfileModels = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "model list", (inner) =>
      backend.listModels(inner),
    );
  };

  listImageGenProfileSamplers = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static capability gate FIRST — the profile's registry snapshot answers
    // "does this backend have a sampler surface" WITHOUT constructing the
    // backend: the factories eagerly validate config (a keyless cloud profile
    // would throw ConfigError before the interface gate could answer), and a
    // capability question must not depend on live config validity.
    if (!profile.capabilities.supportsSamplers) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate (the STT `typeof backend.listModels`
    // twin): a backend without the sampler method reports "not supported",
    // not an empty catalog.
    if (typeof backend.listSamplers !== "function") return null;
    const listSamplers = backend.listSamplers.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "sampler list", (inner) =>
      listSamplers(inner),
    );
  };

  listImageGenProfileSchedulers = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the extensions-arm twin, PG-3): the
    // schedule-type surface exists ONLY on the A1111 dialect — schedulers
    // are not a cross-vendor capability, so no capability flag exists for
    // them; the dialect check answers without live config validity.
    if (profile.backend !== IMAGE_GEN_BACKENDS.A1111) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the scheduler method
    // reports "not supported", not an empty list.
    if (typeof backend.listSchedulers !== "function") return null;
    const listSchedulers = backend.listSchedulers.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "scheduler list", (inner) =>
      listSchedulers(inner),
    );
  };

  listImageGenProfileExtensions = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the samplers capability-gate twin): the
    // extension surface exists ONLY on the A1111 dialect — factories eagerly
    // validate config, and a capability question must not depend on live
    // config validity.
    if (profile.backend !== IMAGE_GEN_BACKENDS.A1111) return null;
    // Interface-driven second gate: a backend without the extension-listing
    // method reports "not supported", not an empty list.
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    if (typeof backend.listExtensions !== "function") return null;
    const listExtensions = backend.listExtensions.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "extension list", (inner) =>
      listExtensions(inner),
    );
  };

  getImageGenProfileProgress: ImageGenRuntimeApi["getImageGenProfileProgress"] = async (id, signal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static capability gate FIRST (the samplers capability-gate twin): a
    // live-progress question must not depend on live config validity, and
    // cloud dialects have no progress surface at all.
    if (!profile.capabilities.supportsLiveProgress) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the progress method
    // reports "not supported", not an error.
    if (typeof backend.progress !== "function") return null;
    const progress = backend.progress.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "progress", (inner) => progress(inner));
  };

  interruptImageGenProfile: ImageGenRuntimeApi["interruptImageGenProfile"] = async (id, signal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // The same two-gate discipline as progress (the interrupt surface is
    // the same A1111 dialect).
    if (!profile.capabilities.supportsLiveProgress) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    if (typeof backend.interrupt !== "function") return null;
    const interrupt = backend.interrupt.bind(backend);
    await withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "interrupt", (inner) => interrupt(inner));
    return true;
  };

  draftListImageGenModels: ImageGenRuntimeApi["draftListImageGenModels"] = async (body: DraftImageGenModelsInput) => {
    const config: Record<string, unknown> = { ...body.config };
    const formKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (formKey === "") {
      delete config.apiKey;
      if (body.profileId !== undefined) {
        const profile = await this.stores.imageGen.getById(body.profileId);
        if (profile !== null && profile.backend === body.backend) {
          const storedKey = profile.apiKey ?? "";
          if (storedKey !== "") {
            // Endpoint-guarded reuse (the STT/TTS draft rule): a saved key may
            // only serve the endpoint it was saved with. Every v1 image-gen
            // backend is endpoint-based (no fixed-host vendor arm), so the
            // guard is unconditional.
            const incomingEndpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
            const storedEndpoint = profile.endpoint.trim();
            if (incomingEndpoint !== "" && incomingEndpoint === storedEndpoint) {
              config.apiKey = storedKey;
            }
          }
        }
      }
      // Still keyless after the stored-key arm — IG-21 auto-match (the
      // resolveDraftConfig tail twin): a freshly typed OpenRouter/Custom
      // endpoint immediately gets the provider key without any linking
      // step; the backend list mirrors what generate would do. a1111 never
      // matches (local/keyless).
      if (typeof config.apiKey !== "string" || config.apiKey === "") {
        const draftEndpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
        const match = await autoMatchImageGenKey(this.stores, body.backend, draftEndpoint);
        if (match !== null) config.apiKey = match.apiKey;
      }
    }
    // The typed config is BUILT from the bag (no cast — the bag is
    // `Record<string, unknown>` and does not overlap the typed shape):
    // endpoint is required by every v1 factory (a missing/mistyped one
    // surfaces the backend's own ConfigError → the route's 400 ladder), the
    // key/model ride only when present and non-empty.
    const backend = createImageGenBackend(body.backend, {
      endpoint: typeof config.endpoint === "string" ? config.endpoint : "",
      ...(typeof config.apiKey === "string" && config.apiKey !== "" ? { apiKey: config.apiKey } : {}),
      ...(typeof config.model === "string" && config.model !== "" ? { model: config.model } : {}),
      ...(this.fetchOverride !== undefined ? { fetch: this.fetchOverride } : {}),
    });
    if (typeof backend.listModels !== "function") return null;
    return backend.listModels();
  };

  // ── Generate (image message slot) ───────────────────────────────────────

  generateImageGen: ImageGenRuntimeApi["generateImageGen"] = async (
    chatId: string,
    body: GenerateImageGenInput,
    signal?: AbortSignal,
  ) => {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) throw new ImageGenNotFoundError(`Chat ${chatId} not found`);
    const profile = await this.stores.imageGen.getById(body.profileId);
    if (!profile) throw new ImageGenNotFoundError(`Image-gen profile ${body.profileId} not found`);

    // The anchor message is provenance (the design's slot contract); it must
    // exist and belong to this chat — anything else is a client inconsistency.
    if (body.anchorMessageId !== undefined) {
      const anchor = await this.stores.messages.getMessageById(body.anchorMessageId);
      if (!anchor || anchor.chatId !== chat.id) {
        throw new ImageGenValidationError(`Anchor message ${body.anchorMessageId} not found in chat ${chatId}`);
      }
    }

    // IG-18a regenerate-as-variant: the target is the SLOT being
    // regenerated. It must exist, belong to this chat, and BE an image-gen
    // slot (the message's attachments carry imageGen provenance — otherwise
    // a client could variant-attach onto an ordinary message and break its
    // projection). The result lands as a VARIANT of this message below.
    let targetSlot: Awaited<ReturnType<typeof this.stores.messages.getMessageById>> = null;
    if (body.targetMessageId !== undefined) {
      targetSlot = await this.stores.messages.getMessageById(body.targetMessageId);
      const targetAttachments = parseStoredAttachments(targetSlot?.attachmentsJson ?? null) ?? [];
      const isImageGenSlot =
        targetSlot !== null &&
        targetSlot.chatId === chat.id &&
        targetAttachments.some((a) => a.imageGen !== undefined);
      if (!isImageGenSlot) {
        throw new ImageGenValidationError(
          `Target message ${body.targetMessageId} is not an image-gen slot of chat ${chatId}`,
        );
      }
    }

    // Effective params (IG-CF15): request overrides WIN, then the ACTIVE
    // MODEL's overlay row (the per-model layer — applied at generation when
    // the resolved model matches, per the owner's "the layer applies at
    // generation when that model is active"), then the profile's per-mode size
    // preset (width/height) and default params (steps/cfg/sampler/seed/
    // clipSkip), then the vendor default (field simply not sent). No value is
    // ever invented here (owner's hardcoded-parameters ban).
    const overrides = body.overrides ?? {};
    const model = overrides.model ?? profile.modelId;
    const overlayRow = model !== undefined && model !== ""
      ? await this.stores.imageGen.getModelSettings(body.profileId, model)
      : null;
    const overlay = overlayRow?.settings ?? {};
    const overlayModePreset = overlay.modeSizePresets?.[body.mode];
    const modePreset = profile.modeSizePresets[body.mode];
    const defaults = profile.defaultParams;
    const width = overrides.width ?? overlayModePreset?.width ?? modePreset?.width;
    const height = overrides.height ?? overlayModePreset?.height ?? modePreset?.height;
    const steps = overrides.steps ?? overlay.steps ?? defaults.steps;
    const cfgScale = overrides.cfgScale ?? overlay.cfgScale ?? defaults.cfgScale;
    const sampler = overrides.sampler ?? overlay.sampler ?? defaults.sampler;
    // Schedule type (PG-3): the sampler's ladder MINUS the overrides rung —
    // the chip's scheduler is an overlay field (the advanced-panel dropdown),
    // no one-shot draft row ships in v1.
    const scheduler = overlay.scheduler ?? defaults.scheduler;
    const seed = overrides.seed ?? overlay.seed ?? defaults.seed;
    const clipSkip = overrides.clipSkip ?? overlay.clipSkip ?? defaults.clipSkip;
    // ADetailer (IG-CF15/PG-4 v1): OVERLAY-ONLY — the face-fix flag rides the
    // per-model layer (no request-level override and no profile-base field
    // in v1); enabled = the overlay's boolean, the model preset falls back
    // to the domain default. Only the a1111 dialect consumes it; other
    // backends ignore the field.
    const adetailerModel =
      overlay.adetailer === true
        ? overlay.adetailerModel?.trim() || IMAGE_GEN_ADETAILER_DEFAULT_MODEL
        : undefined;

    // IG-15 assist runner: built when the profile's assist is ENABLED and
    // BOTH picks exist (absent picks = assist inert — bit-identical legacy
    // behavior, zero extra calls). Resolution is LAZY inside the runner so a
    // free-mode or chip-edit generation (assist exempt by design) never
    // touches the LLM profile.
    let assist: ImageGenAssistRunner | undefined;
    const assistProfileId = profile.llmProviderProfileId ?? "";
    const assistModelId = profile.llmModelId ?? "";
    if (profile.llmAssistEnabled && assistProfileId !== "" && assistModelId !== "") {
      if (this.assistDeps === undefined) {
        throw new ImageGenValidationError("LLM assist is enabled but the assistant seam is unavailable");
      }
      assist = this.makeAssistRunner(this.assistDeps, assistProfileId, assistModelId, signal);
    }

    // IG-14 mode assembly: the prompt the design's generation flow builds —
    // Images-tab template + chat-context macros (free mode wraps the caller
    // text; a caller prompt on non-free modes is the chip's verbatim edit).
    // The shared negative default resolves alongside; the capability gate
    // decides whether it is SENT at all, and the chip's negative edit wins
    // when present (trimmed-empty = the user cleared it — send nothing).
    let prompts: { prompt: string; negativePrompt: string };
    try {
      prompts = await buildImageGenPrompts(this.stores, chat, body.mode, body.prompt, assist);
    } catch (error) {
      if (error instanceof ImageGenModeValidationError) {
        throw new ImageGenValidationError(error.message);
      }
      throw error;
    }
    const chipNegative = overrides.negativePrompt?.trim() ?? "";
    const negativePrompt = profile.capabilities.supportsNegativePrompt
      ? chipNegative !== "" ? chipNegative : prompts.negativePrompt
      : undefined;

    const request: ImageGenGenerateRequest = {
      prompt: prompts.prompt,
      ...(negativePrompt !== undefined && negativePrompt !== "" ? { negativePrompt } : {}),
      ...(model !== undefined && model !== "" ? { model } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(steps !== undefined ? { steps } : {}),
      ...(cfgScale !== undefined ? { cfgScale } : {}),
      ...(sampler !== undefined ? { sampler } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(clipSkip !== undefined ? { clipSkip } : {}),
      ...(adetailerModel !== undefined ? { adetailerModel } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };

    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Owner 2026-09-14: LOCAL backends have NO generation timeout (explicit
    // cancel only); CLOUD backends carry the 3-minute budget.
    const result = profile.capabilities.localExecution
      ? await backend.generate(request)
      : await withImageGenTimeoutMs(
          signal,
          IMAGE_GENERATION_CLOUD_TIMEOUT_MS,
          "generation",
          (inner) => backend.generate({ ...request, ...(inner !== undefined ? { signal: inner } : {}) }),
        );

    // Persist every image as a FLAT asset (bytes server-side, immutable) and
    // build the slot's attachment entries — the same shape a client upload
    // produces, so rendering/vision-describe/promote all work unchanged —
    // plus the design's slot provenance (mode, profileId, model, effective
    // params, backend-reported seed) stamped on every entry (IG-14; the
    // regeneration path in IG-18 rebuilds its request from it). IG-CF6 also
    // stamps the FINAL assembled prompt (`prompts.prompt` = the exact wire
    // text, verbatim chip edits included) so the slot can render it — the
    // same provenance object serves the sibling-append and the
    // regenerate-as-variant path below.
    const provenance: ImageGenSlotProvenance = {
      mode: body.mode,
      profileId: profile.id,
      ...(model !== undefined && model !== "" ? { model } : {}),
      prompt: prompts.prompt,
      params: {
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(cfgScale !== undefined ? { cfgScale } : {}),
        ...(sampler !== undefined ? { sampler } : {}),
        ...(scheduler !== undefined ? { scheduler } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(clipSkip !== undefined ? { clipSkip } : {}),
      },
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
    };
    const attachments: Attachment[] = [];
    for (const image of result.images) {
      const file = new File([new Uint8Array(image.data)], "imagegen", { type: image.mimeType });
      const { assetId } = await this.assetService.upload(file);
      attachments.push({
        id: crypto.randomUUID(),
        assetId,
        type: "image",
        name: `imagegen-${assetId}`,
        mimeType: image.mimeType,
        sizeBytes: image.data.length,
        imageGen: provenance,
      });
    }

    // The image message slot: one message carrying the generated attachment(s)
    // on the chat's active branch, appended at the feed tail (MessageStore has
    // no mid-history insert; the anchor is recorded in the response for the
    // client + IG-14's context-aware regeneration).
    // IG-18a: with targetMessageId the generation lands as a VARIANT of that
    // slot instead — the addVariant transaction deselects the previous
    // variant and syncs messages.content (the text-regenerate mechanism,
    // mirrored); the variant carries the attachments, and the DTO merge point
    // resolves the selected variant's set onto the wire.
    let messageId: string;
    if (targetSlot !== null) {
      await this.stores.messages.addVariant(
        targetSlot.id,
        "",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        JSON.stringify(attachments),
      );
      messageId = targetSlot.id;
    } else {
      const message = await this.stores.messages.addMessage({
        chatId: chat.id,
        branchId: chat.activeBranchId,
        role: "assistant",
        authorType: "assistant",
        content: "",
        attachmentsJson: JSON.stringify(attachments),
      });
      messageId = message.id;
    }

    return {
      messageId,
      mode: body.mode,
      profileId: profile.id,
      ...(model !== undefined && model !== "" ? { model } : {}),
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
      ...(result.width !== undefined ? { width: result.width } : {}),
      ...(result.height !== undefined ? { height: result.height } : {}),
      attachments: attachments.map((a) => ({
        id: a.id,
        assetId: a.assetId,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
    };
  };

  /** IG-15: the quiet single-shot runner for one generation. Mirrors the
   *  chat-summary resolution ladder (profile → API-key check → effective
   *  profile with the bound-model overlay merge → execute with the route
   *  signal); failures PROPAGATE — the generation fails with the normalized
   *  provider error rather than silently skipping the assist. */
  private makeAssistRunner(
    deps: ImageGenAssistDeps,
    providerProfileId: string,
    model: string,
    signal: AbortSignal | undefined,
  ): ImageGenAssistRunner {
    const providerProfiles = deps.providerProfiles;
    const execute = deps.execute ?? nonstreamingProviderExecute;
    return async (system, user) => {
      const profile = await providerProfiles.getProviderProfile(providerProfileId);
      if (!profile) {
        throw new ImageGenNotFoundError(`LLM provider profile '${providerProfileId}' not found`);
      }
      if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
        throw new ImageGenValidationError("The LLM assist provider has no saved API key.");
      }
      const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, providerProfiles);
      const result = await execute({
        profile: effectiveProfile,
        model,
        prompt: assistPromptPayload(system, user),
        ...(signal !== undefined ? { signal } : {}),
      });
      return result.text;
    };
  }

  // ── Gallery promotion (attachment → character gallery) ──────────────────

  promoteImageGenAttachmentToGallery = async (
    assetId: string,
    characterId: string,
  ): Promise<ImageGenGalleryPromoteResponseValue> => {
    // The reversed mirror of promoteGalleryAssetToAttachment: load the FLAT
    // asset bytes, write them into the character's gallery folder, and add
    // the gallery row. The sent message's attachment is never touched.
    const buffer = await this.assetService.loadBuffer(assetId);
    if (!buffer) throw new ImageGenNotFoundError(`Attachment ${assetId} not found`);
    const existing = await this.stores.characterAssets.listByCharacter(characterId);
    const order = existing.length === 0 ? 0 : existing[existing.length - 1]!.order + 1;
    const rowId = this.stores.characterAssets.nextId();
    const file = new File([new Uint8Array(buffer)], rowId, { type: sniffMime(buffer) ?? "image/png" });
    const { ext, mimeType } = await this.assetService.writeGalleryImage(characterId, rowId, file);
    const created = await this.stores.characterAssets.create({
      id: rowId,
      characterId,
      ext,
      mimeType,
      order,
    });
    return { assetRowId: created.id, characterId, ext: created.ext, mimeType: created.mimeType, order: created.order };
  };

  // ─── Model favorites + per-model overlay (IG-12b — pure store passes; the
  //     wire projection flattens the branded FK to `profileId` and timestamps
  //     to strings, matching toClientProfile's shape)

  listImageGenModelFavorites = async (id: string): Promise<ImageGenModelFavoriteValue[] | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    const rows = await this.stores.imageGen.listModelFavorites(id);
    return rows.map((row) => ({
      id: row.id,
      profileId: row.imageGenProfileId,
      modelId: row.modelId,
      label: row.label,
      createdAt: row.createdAt,
    }));
  };

  addImageGenModelFavorite = async (
    id: string,
    body: FavoriteImageGenModelInput,
  ): Promise<ImageGenModelFavoriteValue | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    const row = await this.stores.imageGen.addModelFavorite(id, body);
    return {
      id: row.id,
      profileId: row.imageGenProfileId,
      modelId: row.modelId,
      label: row.label,
      createdAt: row.createdAt,
    };
  };

  removeImageGenModelFavorite = async (id: string, modelId: string): Promise<void | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    await this.stores.imageGen.removeModelFavorite(id, modelId);
  };

  listImageGenModelSettings = async (id: string): Promise<ImageGenModelSettingsValue[] | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    const rows = await this.stores.imageGen.listModelSettings(id);
    return rows.map(toClientModelSettings);
  };

  getImageGenModelSettings = async (
    id: string,
    modelId: string,
  ): Promise<ImageGenModelSettingsValue | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    const row = await this.stores.imageGen.getModelSettings(id, modelId);
    return row ? toClientModelSettings(row) : null;
  };

  upsertImageGenModelSettings = async (
    id: string,
    modelId: string,
    overlay: ImageGenModelSettingsOverlayValue,
    samplerSetId?: string | null,
  ): Promise<ImageGenModelSettingsValue | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    const row = await this.stores.imageGen.upsertModelSettings(id, modelId, overlay, samplerSetId);
    return toClientModelSettings(row);
  };

  deleteImageGenModelSettings = async (id: string, modelId: string): Promise<void | null> => {
    if ((await this.stores.imageGen.getById(id)) === null) return null;
    await this.stores.imageGen.deleteModelSettings(id, modelId);
  };

  // ─── Named image-gen sampler sets (IG-CF15 — the SamplerSetAdapter fork;
  //     global library, image-gen payload dialect) ───────────────────────────

  listImageGenSamplerSets = async (): Promise<ImageGenSamplerSetList> => {
    const rows = await this.stores.imageGenSamplerSets.list();
    return rows.map(imageGenSamplerSetRowToWire);
  };

  createImageGenSamplerSet = async (input: ImageGenSamplerSetCreate): Promise<ImageGenSamplerSet> => {
    await assertImageGenSetNameAvailable(this.stores, input.name, null);
    return imageGenSamplerSetRowToWire(
      await this.stores.imageGenSamplerSets.create({ name: input.name, payload: input.payload }),
    );
  };

  updateImageGenSamplerSet = async (
    setId: string,
    input: ImageGenSamplerSetUpdate,
  ): Promise<ImageGenSamplerSet> => {
    const existing = await this.stores.imageGenSamplerSets.getById(setId);
    if (!existing) {
      throw validation(`Image-gen sampler set '${setId}' was not found.`);
    }
    if (input.name !== undefined && input.name !== existing.name) {
      await assertImageGenSetNameAvailable(this.stores, input.name, setId);
    }
    return imageGenSamplerSetRowToWire(await this.stores.imageGenSamplerSets.update(setId, input));
  };

  deleteImageGenSamplerSet = async (setId: string): Promise<void> => {
    // Clear dangling overlay pointers BEFORE the row disappears (LS-5e twin:
    // deleting a set never leaves model layers pointing at a ghost; the
    // values they applied stay — copy-on-select, sets are inert templates).
    await this.stores.imageGen.clearSamplerSetReferences(setId);
    await this.stores.imageGenSamplerSets.delete(setId);
  };

  importImageGenSamplerSet = async (
    input: ImageGenSamplerSetImport,
  ): Promise<{ set: ImageGenSamplerSet; notes: string[] }> => {
    await assertImageGenSetNameAvailable(this.stores, input.name, null);
    // VT-native set JSON only — no ST TextGen target exists for image-gen.
    // The all-optional payload schema would accept ANY object as an (empty)
    // set, so an empty parse must fail loudly (the SamplerSetAdapter rule).
    const vt = imageGenSamplerSetPayloadSchema.safeParse(input.raw);
    if (!vt.success || Object.keys(vt.data).length === 0) {
      throw validation("The file does not contain a valid image-gen sampler set.");
    }
    const created = await this.stores.imageGenSamplerSets.create({ name: input.name, payload: vt.data });
    return { set: imageGenSamplerSetRowToWire(created), notes: [] };
  };
}

/** Minimal executor prompt for the IG-15 quiet call: a system+user pair in
 *  the AssemblePromptResponse shape `nonstreamingProviderExecute` consumes
 *  (toSdkMessages reads finalPayload.messages). All the pipeline-only
 *  fields carry their empty shapes — this is a single-shot prompt-writing
 *  call, not a chat turn. */
function assistPromptPayload(system: string, user: string): AssemblePromptResponse {
  return {
    layers: [],
    tokenAccounting: {},
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  };
}

// ─── MIME recovery for asset → gallery copy ──────────────────────────────

/** `AssetService.loadBuffer` returns raw bytes with no MIME memory; the flat
 *  asset file carries its type only in the filename extension the loader
 *  already consumed. Sniff by format signature (the openai-images adapter's
 *  parser set — PNG/JPEG/WebP; null → the caller's PNG fallback, which the
 *  gallery writer's ALLOWED_MIMES gate accepts). */
function sniffMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
