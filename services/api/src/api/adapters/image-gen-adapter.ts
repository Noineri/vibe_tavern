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
 * mechanism reused; MR-3 generalized 2026-09-18): a profile WITHOUT its own
 * stored key auto-matches at the execution seam — **openrouter**: the first
 * keyful LLM provider whose endpoint lives on the OpenRouter vendor host;
 * **every other endpoint-driven cloud backend** (the whole PE roster —
 * nanogpt, electronhub, …): exact normalized-endpoint match over keyful
 * LLM providers (the
 * openai-compat rule). a1111 is local/keyless (out of scope). The profile's
 * OWN typed key always overrides; a keyless no-match profile passes through
 * to the backend factory which surfaces whatever auth error applies. The
 * wire records carry the same hint the STT editor shows ("key will be taken
 * from profile X") via decorateImageGenProfileAutoKeys — two mirrors, one rule (the STT
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
  DraftImageGenPromptInput,
  DraftImageGenPromptResponseValue,
  FavoriteImageGenModelInput,
  GenerateImageGenInput,
  ImageGenFamilyDetectionResultValue,
  ImageGenGenerateResponseValue,
  ImageGenGalleryPromoteResponseValue,
  ImageGenModelFavoriteValue,
  ImageGenModelInfoValue,
  ImageGenModelSettingsOverlayValue,
  ImageGenModelSettingsValue,
  ImageGenProbeResultValue,
  ImageGenProfileValue,
  ImageGenSamplerInfoValue,
  ImageGenSamplerSet,
  ImageGenSamplerSetCreate,
  ImageGenSamplerSetImport,
  ImageGenSamplerSetList,
  ImageGenSamplerSetUpdate,
  ImageGenPromptCapList,
  ImageGenSchedulerInfoValue,
  ImagePromptFamiliesValue,
  ImagePromptFamilyValue,
  ImagePromptTemplateCellValue,
  ImagePromptTemplateRowKeyValue,
  UpdateImageGenProfileInput,
} from "@vibe-tavern/api-contracts";
import { imageGenDitSidecarsSchema, imageGenModelInfoSchema, imageGenSamplerSetPayloadSchema } from "@vibe-tavern/api-contracts";
import { IMAGE_GEN_LISTING_SNAPSHOT_KINDS, ImagePromptVariantStore, type ImageGenListingSnapshotKind } from "@vibe-tavern/db";
import type {
  CreateImageGenProfileData,
  StoreContainer,
  UpdateImageGenProfileData,
} from "@vibe-tavern/db";
import type { Attachment, ImageGenHiresBlock, ImageGenModelSettings, ImageGenProfile, ImageGenSlotProvenance } from "@vibe-tavern/domain";
import { parseStoredAttachments, IMAGE_GEN_ADETAILER_DEFAULT_MODEL, IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES, IMAGE_GENERATION_MODES, IMAGE_PROMPT_DEFAULT_FAMILY, IMAGE_PROMPT_FAMILIES, PROXY_MODE, resolveImageGenCapabilities } from "@vibe-tavern/domain";

import type { AssetService } from "../../domain/asset/asset-service.js";
import { decorateImageGenProfileAutoKeys } from "./image-gen-profile-list.js";
import {
  buildImageGenPrompts,
  ImageGenModeValidationError,
  type ImageGenAssistRunner,
} from "../../domain/chat/imagegen-modes.js";
import { resolveImageGenPromptFamily } from "../../domain/imagegen/prompt-family-resolution.js";
import { defaultReadSidecarFile, detectImageGenFamily, type FamilyDetectionBackend } from "../../domain/imagegen/family-detection.js";
import { parsePromptCharCapFromErrorMessage } from "../../domain/imagegen/prompt-char-caps.js";
import { getProviderFetchFactory } from "../../domain/providers/provider-fetch-factory.js";
import { promptFamiliesReadModel } from "../../domain/imagegen/prompt-template-catalog.js";
import type { ImageGenAdapterConfig, ImageGenGenerateRequest } from "../../domain/imagegen/imagegen-backend.js";
import { IMAGE_GENERATION_CLOUD_TIMEOUT_MS, withImageGenTimeoutMs } from "../../domain/imagegen/imagegen-backend.js";
import { TEST_CHAT_TIMEOUT_MS } from "../../domain/providers/provider-transport.js";
import { createImageGenBackend, IMAGE_GEN_FAMILY_DETECTION_BACKENDS } from "../../domain/imagegen/imagegen-registry.js";
import { clearImageGenRunPhase, getImageGenRunPhase, setImageGenRunPhase } from "../../domain/imagegen/run-phase.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import { resolveEffectiveSummaryProfile } from "../../domain/chat/summary-generation-seam.js";
import type { AssemblePromptResponse, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ImageGenListing, ImageGenRuntimeApi } from "../contract/runtime-api.js";

// Side-effect registration of the complete backend roster (the stt-adapter
// twin) is centralized in this file-size-ratchet extraction.
import "../../domain/imagegen/backends/register-imagegen-backends.js";

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
    defaultParamsSetId: profile.defaultParamsSetId ?? null,
    modeSizePresets: profile.modeSizePresets,
    ...(profile.userSizes !== undefined && profile.userSizes.length > 0 ? { userSizes: profile.userSizes } : {}),
    llmAssistEnabled: profile.llmAssistEnabled,
    assistRetryOnRefusal: profile.assistRetryOnRefusal,
    qualityLayerEnabled: profile.qualityLayerEnabled,
    familySource: profile.familySource,
    // Graduation flags resolve at the profile-read seam: a snapshot saved
    // before a backend gained a capability inherits current vendor truth,
    // while an explicit stored value remains authoritative.
    capabilities: resolveImageGenCapabilities(profile.backend, profile.capabilities),
    isDefault: profile.isDefault,
    sortOrder: profile.sortOrder,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
  if (profile.presetId !== undefined) record.presetId = profile.presetId;
  if (profile.modelId !== undefined) record.modelId = profile.modelId;
  if (profile.llmProviderProfileId !== undefined) record.llmProviderProfileId = profile.llmProviderProfileId;
  if (profile.llmModelId !== undefined) record.llmModelId = profile.llmModelId;
  // IPT-2 family read model: the three state fields surface when present;
  // familySource always does (the derived provenance label).
  if (profile.familyOverride !== undefined) record.familyOverride = profile.familyOverride;
  if (profile.familyDetected !== undefined) record.familyDetected = profile.familyDetected;
  if (profile.familyDetectedForModel !== undefined) record.familyDetectedForModel = profile.familyDetectedForModel;
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
 *  (IG-21, the autoMatchSttKey twin; MR-3 generalized the exact-endpoint arm
 *  to the whole cloud roster — a NanoGPT draft with a NanoGPT provider
 *  profile is the owner's own case). Deterministic: first keyful provider
 *  in list (sort) order wins. Rules per backend:
 *  - openrouter: first keyful provider whose endpoint lives on the OpenRouter
 *    vendor host (any path under openrouter.ai);
 *  - every other endpoint-driven cloud backend: exact normalized-endpoint
 *    match (the openai-compat rule generalized — the image-gen roster has no
 *    fixed-host vendor arm, so the endpoint IS the vendor; a saved key
 *    serves only the endpoint it was saved with);
 *  - a1111 / comfyui: local/keyless — never match.
 *  Own-key configs short-circuit BEFORE this runs (resolveAdapterConfig). */
async function autoMatchImageGenKey(
  stores: Pick<StoreContainer, "providers">,
  backend: ImageGenProfile["backend"],
  endpoint: string,
): Promise<{ apiKey: string; matchedName: string } | null> {
  if (backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI) {
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
  "imageGen" | "imageGenSamplerSets" | "imageGenPromptCaps" | "imageGenListingSnapshots" | "chats" | "messages" | "characterAssets" | "db" | "characters" | "personas" | "providers"
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

  // ── Profile CRUD ────────────────────────────────────────────────────────

  listImageGenProfiles = async () =>
    await decorateImageGenProfileAutoKeys(this.stores, (await this.stores.imageGen.listAll()).map(toClientProfile));

  reorderImageGenProfiles: ImageGenRuntimeApi["reorderImageGenProfiles"] = async (updates) =>
    await decorateImageGenProfileAutoKeys(this.stores, (await this.stores.imageGen.reorder(updates)).map(toClientProfile));

  getImageGenProfile = async (id: string) => {
    const profile = await this.stores.imageGen.getById(id);
    return profile ? (await decorateImageGenProfileAutoKeys(this.stores, [toClientProfile(profile)]))[0] : null;
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
      defaultParamsSetId: body.defaultParamsSetId ?? undefined,
      modeSizePresets: body.modeSizePresets,
      userSizes: body.userSizes,
      llmAssistEnabled: body.llmAssistEnabled,
      llmProviderProfileId: body.llmProviderProfileId,
      llmModelId: body.llmModelId,
      assistRetryOnRefusal: body.assistRetryOnRefusal,
      // IPT-2: a fresh profile starts unpinned (no family columns from
      // create — the Wave 3 family route is the only family writer).
      qualityLayerEnabled: body.qualityLayerEnabled,
      capabilities: body.capabilities,
      sortOrder: body.sortOrder,
      isDefault: false,
    };
    return (await decorateImageGenProfileAutoKeys(this.stores, [toClientProfile(await this.stores.imageGen.create(input))]))[0];
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
    // IF-7a tri-state pointer (undefined = keep, null = clear, string = set).
    if (body.defaultParamsSetId !== undefined) patch.defaultParamsSetId = body.defaultParamsSetId;
    if (body.modeSizePresets !== undefined) patch.modeSizePresets = body.modeSizePresets;
    if (body.userSizes !== undefined) patch.userSizes = body.userSizes;
    if (body.llmAssistEnabled !== undefined) patch.llmAssistEnabled = body.llmAssistEnabled;
    if (body.llmProviderProfileId !== undefined) patch.llmProviderProfileId = body.llmProviderProfileId;
    if (body.llmModelId !== undefined) patch.llmModelId = body.llmModelId;
    if (body.assistRetryOnRefusal !== undefined) patch.assistRetryOnRefusal = body.assistRetryOnRefusal;
    if (body.qualityLayerEnabled !== undefined) patch.qualityLayerEnabled = body.qualityLayerEnabled;
    if (body.capabilities !== undefined) patch.capabilities = body.capabilities;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    const before = await this.stores.imageGen.getById(id);
    const updated = await this.stores.imageGen.update(id, patch);
    // IF-20: a different server (endpoint or backend) lists different files —
    // its predecessor's snapshots must never stand in for it.
    if (
      before !== null &&
      updated !== null &&
      (before.endpoint !== updated.endpoint || before.backend !== updated.backend)
    ) {
      await this.stores.imageGenListingSnapshots.clear(id);
    }
    return updated ? (await decorateImageGenProfileAutoKeys(this.stores, [toClientProfile(updated)]))[0] : null;
  };

  deleteImageGenProfile = async (id: string): Promise<void> => {
    await this.stores.imageGen.delete(id);
  };

  /** MR-12 (the STT `setSttDefault` twin): moves the global pointer —
   *  the store's `setDefault` transaction keeps the at-most-one invariant. */
  setImageGenDefault = async (id: string) => {
    const updated = await this.stores.imageGen.setDefault(id);
    return updated ? (await decorateImageGenProfileAutoKeys(this.stores, [toClientProfile(updated)]))[0] : null;
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

  /**
   * IF-20 (owner 2026-09-27: a restarted server must not empty the pickers):
   * run a live listing; a success overwrites the profile's last-good
   * snapshot, a failure serves that snapshot flagged with `snapshotAt` —
   * never silent freshness — and rethrows when none exists. A caller-side
   * abort always rethrows (nobody is waiting for the fallback). The stored
   * payload is re-validated on read; an unreadable one counts as none.
   */
  private async listWithSnapshot<T>(
    profileId: string,
    kind: ImageGenListingSnapshotKind,
    signal: AbortSignal | undefined,
    parse: (raw: unknown) => T | null,
    live: () => Promise<T>,
  ): Promise<ImageGenListing<T>> {
    let data: T;
    try {
      data = await live();
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const snapshot = await this.stores.imageGenListingSnapshots.get(profileId, kind);
      const stored = snapshot === null ? null : parse(snapshot.payload);
      if (snapshot === null || stored === null) throw error;
      return { data: stored, snapshotAt: snapshot.fetchedAt };
    }
    try {
      await this.stores.imageGenListingSnapshots.put(profileId, kind, data);
    } catch (error) {
      // The live listing is still correct — a failed snapshot write only
      // costs the next outage its fallback.
      console.warn(`[image-gen] ${kind} snapshot write failed for profile ${profileId}:`, error);
    }
    return { data };
  }

  listImageGenProfileModels = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    return this.listWithSnapshot(
      profile.id,
      IMAGE_GEN_LISTING_SNAPSHOT_KINDS.Models,
      signal,
      (raw) => {
        const parsed = imageGenModelInfoSchema.array().safeParse(raw);
        return parsed.success ? parsed.data : null;
      },
      async () => {
        const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
        return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "model list", (inner) =>
          backend.listModels(inner),
        );
      },
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
    // schedule-type surface exists on A1111 (/sdapi/v1/schedulers), ComfyUI
    // (the KSampler scheduler combo, CG-A3), and NovelAI (its documented
    // static scheduler catalog, NAI-5a). Schedulers are not a cross-vendor
    // capability, so no capability flag exists for them; the dialect check
    // answers without live config validity.
    if (
      profile.backend !== IMAGE_GEN_BACKENDS.A1111 &&
      profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI &&
      profile.backend !== IMAGE_GEN_BACKENDS.NovelAi
    ) {
      return null;
    }
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the scheduler method
    // reports "not supported", not an empty list.
    if (typeof backend.listSchedulers !== "function") return null;
    const listSchedulers = backend.listSchedulers.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "scheduler list", (inner) =>
      listSchedulers(inner),
    );
  };

  listImageGenProfileDitSidecars = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the schedulers twin, CG-B1): the DiT
    // sidecar surface (text-encoder + VAE folders) exists ONLY on the
    // comfyui dialect — the check answers without live config validity.
    if (profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the sidecar method
    // reports "not supported", not an empty list.
    if (typeof backend.listDitSidecars !== "function") return null;
    const listDitSidecars = backend.listDitSidecars.bind(backend);
    // IF-20: the encoder/VAE folders ride the last-good snapshot too — the
    // lists the owner saw go empty across a Comfy restart.
    return this.listWithSnapshot(
      profile.id,
      IMAGE_GEN_LISTING_SNAPSHOT_KINDS.DitSidecars,
      signal,
      (raw) => {
        const parsed = imageGenDitSidecarsSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      },
      () => withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "DiT sidecar list", (inner) => listDitSidecars(inner)),
    );
  };

  listImageGenProfileLoras = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the sidecars twin, CG-C2/FT-A4): the two
    // dialects that ship a LoRA list source — ComfyUI (LoraLoader combo,
    // CG-C2) and A1111 (GET /sdapi/v1/loras, FT-A4) — the check answers
    // without live config validity.
    if (
      profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI &&
      profile.backend !== IMAGE_GEN_BACKENDS.A1111
    ) {
      return null;
    }
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the lora-listing
    // method reports "not supported", not an empty list.
    if (typeof backend.listLoras !== "function") return null;
    const listLoras = backend.listLoras.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "lora list", (inner) =>
      listLoras(inner),
    );
  };

  listImageGenProfileUpscalers = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the schedulers twin, FT-A4): the upscaler
    // surface exists on the LOCAL dialects — A1111 (GET /sdapi/v1/upscalers)
    // and ComfyUI (GET /models/upscale_models, IF-6) — the check answers
    // without live config validity.
    if (
      profile.backend !== IMAGE_GEN_BACKENDS.A1111 &&
      profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI
    ) {
      return null;
    }
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the upscaler-listing
    // method reports "not supported", not an empty list.
    if (typeof backend.listUpscalers !== "function") return null;
    const listUpscalers = backend.listUpscalers.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "upscaler list", (inner) =>
      listUpscalers(inner),
    );
  };

  listImageGenProfileVae = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the upscalers twin, IF-7b): the VAE-swap
    // vocabulary exists on the LOCAL dialects — A1111 (/sdapi/v1/sd-vae)
    // and ComfyUI (/models/vae) — the check answers without live config
    // validity.
    if (
      profile.backend !== IMAGE_GEN_BACKENDS.A1111 &&
      profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI
    ) {
      return null;
    }
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the VAE-listing
    // method reports "not supported", not an empty list.
    if (typeof backend.listVae !== "function") return null;
    const listVae = backend.listVae.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "VAE list", (inner) =>
      listVae(inner),
    );
  };

  listImageGenProfileFaceDetectors = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // Static dialect gate FIRST (the extensions twin): the face-detector
    // chain probe is COMFYUI-only (IF-6 — the A1111 twin rides its static
    // preset list off the extensions probe; one code path per dialect).
    if (profile.backend !== IMAGE_GEN_BACKENDS.ComfyUI) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the method reports
    // "not supported", not an empty list.
    if (typeof backend.listFaceDetectors !== "function") return null;
    const listFaceDetectors = backend.listFaceDetectors.bind(backend);
    return withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "face detector list", (inner) =>
      listFaceDetectors(inner),
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
    // MR-11: an ACTIVE run carries its phase on every poll response —
    // cloud dialects included (prompt/starting only, the honest chip
    // timeline; they never report steps).
    const phase = getImageGenRunPhase(id);
    // Static capability gate FIRST (the samplers capability-gate twin): a
    // live-progress question must not depend on live config validity, and
    // cloud dialects have no progress surface at all. Read from the STATIC
    // table by backend, never the stored record mirror — the mirror is a
    // save-time snapshot and goes stale the moment a backend gains the
    // capability after the profile was saved (owner report 2026-09-18: a
    // swipe-regenerated run showed no progress because the gate read a
    // pre-CG-C1 mirror; the registry's current truth is the only source).
    if (!IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].supportsLiveProgress) {
      return phase === undefined ? null : { phase };
    }
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // Interface-driven second gate: a backend without the progress method
    // reports "not supported", not an error.
    if (typeof backend.progress !== "function") {
      return phase === undefined ? null : { phase };
    }
    const progress = backend.progress.bind(backend);
    const snapshot = await withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "progress", (inner) => progress(inner));
    return phase === undefined ? snapshot : { ...snapshot, phase };
  };

  interruptImageGenProfile: ImageGenRuntimeApi["interruptImageGenProfile"] = async (id, signal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // The same two-gate discipline as progress (the interrupt surface is
    // the same A1111 dialect), and the same static-table rule: the stored
    // mirror may predate the capability (see getImageGenProfileProgress).
    if (!IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].supportsLiveProgress) return null;
    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    if (typeof backend.interrupt !== "function") return null;
    const interrupt = backend.interrupt.bind(backend);
    await withImageGenTimeoutMs(signal, TEST_CHAT_TIMEOUT_MS, "interrupt", (inner) => interrupt(inner));
    return true;
  };

  /** FT-B2: draft an editable image prompt through the profile's saved
   * assist pick. This deliberately never submits an image backend request:
   * the caller receives text only and generation remains the IG-14 verbatim
   * path after the user reviews it in the chip. */
  draftImageGenPrompt: ImageGenRuntimeApi["draftImageGenPrompt"] = async (
    chatId: string,
    body: DraftImageGenPromptInput,
    signal?: AbortSignal,
  ): Promise<DraftImageGenPromptResponseValue> => {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) throw new ImageGenNotFoundError(`Chat ${chatId} not found`);
    const profile = await this.stores.imageGen.getById(body.profileId);
    if (!profile) throw new ImageGenNotFoundError(`Image-gen profile ${body.profileId} not found`);
    const assist = this.configuredAssistRunner(profile, signal);
    if (assist === undefined) {
      throw new ImageGenValidationError("AI prompt drafting needs a configured LLM assist provider and model");
    }
    const model = profile.modelId;
    const { family: promptFamily } = resolveImageGenPromptFamily(
      profile,
      model,
      IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].defaultPromptFamily,
    );
    try {
      const promptCharCap =
        model !== undefined && model !== ""
          ? (await this.stores.imageGenPromptCaps.get(profile.backend, model))?.maxPromptChars
          : undefined;
      const prompts = await buildImageGenPrompts(
        this.stores,
        chat,
        body.mode,
        undefined,
        assist,
        {
          promptFamily,
          qualityLayerEnabled: profile.qualityLayerEnabled,
          assistRetryOnRefusal: profile.assistRetryOnRefusal,
          ...(promptCharCap !== undefined ? { promptCharCap } : {}),
          // Presence (even `""`) marks this as the text-only draft path;
          // Free generation omits the option and retains IG-14's required
          // finished caller prompt.
          assistHint: body.hint ?? "",
        },
      );
      const negativePrompt = prompts.negativePrompt.trim();
      return {
        prompt: prompts.prompt,
        ...(profile.capabilities.supportsNegativePrompt && negativePrompt !== "" ? { negativePrompt } : {}),
      };
    } catch (error) {
      if (error instanceof ImageGenModeValidationError) {
        throw new ImageGenValidationError(error.message);
      }
      throw error;
    }
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

  generateImageGen: ImageGenRuntimeApi["generateImageGen"] = async (chatId, body, signal) => {
    // MR-11: the phase registry must never leak a stale phase past the
    // run's exit — every exit path (success, validation throw, abort,
    // backend error) funnels through this finally. The phase itself is set
    // inside the core once the profile resolves.
    try {
      return await this.generateImageGenCore(chatId, body, signal);
    } finally {
      clearImageGenRunPhase(body.profileId);
    }
  };

  private async generateImageGenCore(
    chatId: string,
    body: GenerateImageGenInput,
    signal?: AbortSignal,
  ): Promise<ImageGenGenerateResponseValue> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) throw new ImageGenNotFoundError(`Chat ${chatId} not found`);
    const profile = await this.stores.imageGen.getById(body.profileId);
    if (!profile) throw new ImageGenNotFoundError(`Image-gen profile ${body.profileId} not found`);
    // MR-11: the chip's honest timeline starts here — "starting" covers
    // the whole pre-submit span (validation, mode assembly, assist); the
    // assist wrapper below flips it to "prompt" while the LLM writes.
    setImageGenRunPhase(profile.id, "starting");

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
    // ComfyUI DiT sidecars (CG-A2): the scheduler precedent — overlay over
    // profile defaults, NO overrides rung (they are wiring concerns of the
    // model, not one-shot knobs). T9 (owner ruling 2026-09-27): the profile
    // base is an attribute of the PROFILE'S OWN MODEL — when the chat
    // overrides the model to a different one, the base rung drops and the
    // backend's family ladder re-resolves the switched model's own
    // sidecars; the per-model overlay row stays (it IS the active model's
    // layer). Other backends ignore the fields.
    const sidecarBaseDropped =
      model !== undefined && model !== "" && model !== profile.modelId;
    const encoderName = sidecarBaseDropped
      ? overlay.encoderName
      : overlay.encoderName ?? defaults.encoderName;
    const vaeName = sidecarBaseDropped
      ? overlay.vaeName
      : overlay.vaeName ?? defaults.vaeName;
    // Manual base-workflow selection follows the same model-local rule as
    // DiT sidecars: a chat model override drops a profile-base set, while
    // the selected model's overlay (or a one-run override) remains
    // authoritative. A1111 receives this optional field and ignores it.
    const workflowFamily =
      overrides.workflowFamily ??
      overlay.workflowFamily ??
      (sidecarBaseDropped ? undefined : defaults.workflowFamily);
    // VAE override for swappable-slot dialects (IF-7b): the same T9 rule —
    // a chat model switch drops the profile base (the swapped checkpoint
    // rides its own VAE); the per-model overlay row stays. Backends without
    // a swappable slot (DiT templates, cloud) ignore the field.
    const vae = sidecarBaseDropped ? overlay.vae : overlay.vae ?? defaults.vae;
    const seed = overrides.seed ?? overlay.seed ?? defaults.seed;
    const clipSkip = overrides.clipSkip ?? overlay.clipSkip ?? defaults.clipSkip;
    const cfgRescale = overrides.cfgRescale ?? overlay.cfgRescale ?? defaults.cfgRescale;
    // ADetailer / face-detailer (IG-CF15/PG-4 v1 → widened 2026-09-27):
    // the two-rung ladder — the per-model overlay flag over the profile
    // base (the pane row lives on BOTH arms: the bind toggle routes
    // writes, it never hides the control). The boolean rides the request;
    // the model rides ONLY when the user picked one — each DIALECT
    // resolves its own unset-model default (A1111: the extension's
    // bundled detector; ComfyUI: the live-probed list's first entry),
    // never a cross-dialect constant (the upscaler-label lesson).
    const adetailerEnabled = overlay.adetailer ?? defaults.adetailer;
    const adetailerModel =
      overlay.adetailerModel?.trim() || defaults.adetailerModel?.trim() || undefined;
    const adetailerSteps = overlay.adetailerSteps ?? defaults.adetailerSteps;
    // Krea K2 params (IF-11): the two-rung ladder — the per-model overlay
    // block over the profile base, merged PER FIELD (an absent overlay
    // field inherits the base; both absent = the policy defaults inside
    // the backend: creativity "raw", sliders unsent). Only the krea
    // dialect reads the block; other backends ignore it.
    const kreaMerged = { ...defaults.krea, ...overlay.krea };
    const krea = Object.keys(kreaMerged).length > 0 ? kreaMerged : undefined;
    // LoRAs (CG-C2): the chip-draft rung ONLY — no overlay, no profile base
    // (per-generation by design, the FT plan's draft-level ruling) — and
    // capability-gated off the CURRENT static table by backend (IF-6: the
    // progress-gate rule — the stored mirror is a save-time snapshot that
    // goes stale the moment a backend graduates; a pre-graduation profile
    // must not silently drop the lora chain a re-saved twin would send).
    const supportsLoras = IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].supportsLoras === true;
    const loras = supportsLoras ? overrides.loras : undefined;
    // Hires-fix (FT-A4 → IF-7b): THREE rungs now — the chip draft (the
    // presence-semantics override, per-run by design) over the per-model
    // overlay block over the profile base block. Stored blocks carry their
    // own `enabled` switch (stock sets ship configured-but-disabled — the
    // owner's opt-in ruling): a disabled block ships NOTHING (the ladder
    // falls through). Still gated off the CURRENT static table (the IF-6
    // staleness fix: pre-graduation profiles must not silently drop the
    // second pass a re-saved twin would send).
    const supportsHires = IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].supportsHiresFix === true;
    const storedHiresOf = (block: ImageGenHiresBlock | undefined) => {
      if (block?.enabled !== true) return undefined;
      const folded: NonNullable<ImageGenGenerateRequest["hires"]> = {};
      if (block.upscaler !== undefined && block.upscaler !== "") folded.upscaler = block.upscaler;
      if (block.steps !== undefined) folded.steps = block.steps;
      if (block.scale !== undefined) folded.scale = block.scale;
      if (block.denoisingStrength !== undefined) folded.denoisingStrength = block.denoisingStrength;
      return folded;
    };
    const hires = supportsHires
      ? (overrides.hires ?? storedHiresOf(overlay.hires) ?? storedHiresOf(defaults.hires))
      : undefined;

    // IG-15 assist runner: built when the profile's assist is ENABLED and
    // BOTH picks exist (absent picks = assist inert — bit-identical legacy
    // behavior, zero extra calls). Resolution is LAZY inside the runner so a
    // free-mode or chip-edit generation (assist exempt by design) never
    // touches the LLM profile.
    let assist = this.configuredAssistRunner(profile, signal);
    const assistModelId = profile.llmModelId ?? "";
    // C-A: flips true at the exact moment the assist call fires (lazy — a
    // free/verbatim run never touches it), so the provenance can stamp the
    // author model on assist-written prompts only.
    let assistFired = false;
    if (assist !== undefined) {
      // MR-11: the assist wrapper announces the prompt phase at the exact
      // moment the LLM call actually fires (lazy resolution — exempt runs
      // never enter "prompt") and hands the timeline back to "starting"
      // when the text is ready. C-A: the same moment is the ONLY reliable
      // "the LLM authored this prompt" signal — the wrapper records it so
      // the provenance can stamp the author model (free/verbatim runs stay
      // un-stamped; lazy resolution means the flag cannot be set upfront).
      const innerAssist = assist;
      assist = async (system, user) => {
        assistFired = true;
        setImageGenRunPhase(profile.id, "prompt");
        try {
          return await innerAssist(system, user);
        } finally {
          setImageGenRunPhase(profile.id, "starting");
        }
      };
    }

    // IPT-2 assembly: the family the prompt templates speak — manual pin,
    // else a FRESH auto detection (freshness vs the model ACTUALLY
    // generating: the chip's model override outranks the saved pick), else
    // the backend's own default (NAI-6a: NovelAI), else the universal prose
    // default. Unpinned profiles on backends without a default stay
    // byte-identical.
    const { family: promptFamily } = resolveImageGenPromptFamily(
      profile,
      model,
      IMAGE_GEN_BACKEND_CAPABILITIES[profile.backend].defaultPromptFamily,
    );

    // IG-14 mode assembly: the prompt the design's generation flow builds —
    // Images-tab template + chat-context macros (free mode wraps the caller
    // text; a caller prompt on non-free modes is the chip's verbatim edit).
    // The shared negative default resolves alongside; the capability gate
    // decides whether it is SENT at all, and the chip's negative edit wins
    // when present (trimmed-empty = the user cleared it — send nothing).
    let prompts: { prompt: string; negativePrompt: string };
    try {
      // IF-10: the learned provider cap (if any) rides the mode options so
      // the assist instruction carries a character budget; free/verbatim
      // paths ignore it. The counter-facing read is the same store.
      const promptCharCap =
        model !== undefined && model !== ""
          ? (await this.stores.imageGenPromptCaps.get(profile.backend, model))?.maxPromptChars
          : undefined;
      prompts = await buildImageGenPrompts(
        this.stores,
        { ...chat, anchorMessageId: body.anchorMessageId },
        body.mode,
        body.prompt,
        assist,
        { promptFamily, qualityLayerEnabled: profile.qualityLayerEnabled, assistRetryOnRefusal: profile.assistRetryOnRefusal, ...(promptCharCap !== undefined ? { promptCharCap } : {}) },
      );
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
      ...(cfgRescale !== undefined ? { cfgRescale } : {}),
      ...(sampler !== undefined ? { sampler } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
      ...(encoderName !== undefined ? { encoderName } : {}),
      ...(vaeName !== undefined ? { vaeName } : {}),
      ...(workflowFamily !== undefined ? { workflowFamily } : {}),
      ...(vae !== undefined ? { vae } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(clipSkip !== undefined ? { clipSkip } : {}),
      ...(adetailerEnabled === true ? { adetailer: true } : {}),
      ...(adetailerModel !== undefined ? { adetailerModel } : {}),
      ...(adetailerSteps !== undefined ? { adetailerSteps } : {}),
      ...(krea !== undefined ? { krea } : {}),
      // NAI-6a: NovelAI's server-side quality layer — the profile's quality
      // switch rides the vendor block ONLY for the novelai backend AND only
      // when the resolved family is novelai (quality tags are never doubled).
      ...(profile.backend === IMAGE_GEN_BACKENDS.NovelAi
        ? { novelai: { qualityToggle: profile.qualityLayerEnabled && promptFamily === "novelai" } }
        : {}),
      ...(loras !== undefined && loras.length > 0 ? { loras } : {}),
      ...(hires !== undefined ? { hires } : {}),
      // MR-11: the backend announces the moment its progress surface
      // reflects THIS run's job — the phase flips to "steps" exactly there
      // (no percent before real steps; no inherited stale snapshot).
      onJobStarted: () => setImageGenRunPhase(profile.id, "steps"),
      ...(signal !== undefined ? { signal } : {}),
    };

    const backend = createImageGenBackend(profile.backend, await resolveAdapterConfig(this.stores, profile, this.fetchOverride));
    // IF-10 learn/invalidate seam — wraps BOTH transport branches below:
    // a prompt_too_long rejection teaches the per-(backend, model) cap from
    // the provider's message; a SUCCESS whose composed prompt ran longer
    // than the stored cap invalidates it (the provider raised the limit —
    // advisory caps must never outlive their truth).
    const runBackend = async (): Promise<Awaited<ReturnType<typeof backend.generate>>> => {
      try {
        // Owner 2026-09-14: LOCAL backends have NO generation timeout (explicit cancel only); CLOUD backends carry the
        // 3-minute budget. PE-7a (owner 2026-09-18): aihorde joins the no-budget side — silence, not queue length, aborts it.
        const generated = profile.capabilities.localExecution || profile.backend === IMAGE_GEN_BACKENDS.Aihorde
          ? await backend.generate(request)
          : await withImageGenTimeoutMs(
              signal,
              IMAGE_GENERATION_CLOUD_TIMEOUT_MS,
              "generation",
              (inner) => backend.generate({ ...request, ...(inner !== undefined ? { signal: inner } : {}) }),
            );
        if (model !== undefined && model !== "") {
          await this.stores.imageGenPromptCaps.invalidateIfExceeded(profile.backend, model, request.prompt.length);
        }
        return generated;
      } catch (error) {
        if (model !== undefined && model !== "" && error instanceof Error) {
          const cap = parsePromptCharCapFromErrorMessage(error.message);
          if (cap !== null) {
            await this.stores.imageGenPromptCaps.upsert(profile.backend, model, cap);
          }
        }
        throw error;
      }
    };
    const result = await runBackend();

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
      // C-A: the author note rides only runs where the LLM assist actually
      // wrote the prompt (assistFired); verbatim chip edits and free-mode
      // caller text never carry it.
      ...(assistFired ? { promptBy: assistModelId } : {}),
      params: {
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(cfgScale !== undefined ? { cfgScale } : {}),
        ...(cfgRescale !== undefined ? { cfgRescale } : {}),
        ...(sampler !== undefined ? { sampler } : {}),
        ...(scheduler !== undefined ? { scheduler } : {}),
        ...(encoderName !== undefined ? { encoderName } : {}),
        ...(vaeName !== undefined ? { vaeName } : {}),
        ...(vae !== undefined ? { vae } : {}),
        ...(result.resolvedTemplate !== undefined ? { template: result.resolvedTemplate } : {}),
        ...(loras !== undefined && loras.length > 0 ? { loras } : {}),
        ...(hires !== undefined ? { hires } : {}),
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

  /** Resolve the profile's configured quiet assist runner. Generate keeps
   * this optional because non-assisted server builds remain valid; FT-B2's
   * draft endpoint requires the returned runner and rejects its absence. */
  private configuredAssistRunner(
    profile: ImageGenProfile,
    signal: AbortSignal | undefined,
  ): ImageGenAssistRunner | undefined {
    const providerProfileId = profile.llmProviderProfileId ?? "";
    const model = profile.llmModelId ?? "";
    if (!profile.llmAssistEnabled || providerProfileId === "" || model === "") return undefined;
    if (this.assistDeps === undefined) {
      throw new ImageGenValidationError("LLM assist is enabled but the assistant seam is unavailable");
    }
    return this.makeAssistRunner(this.assistDeps, providerProfileId, model, signal);
  }

  /** IG-15: the quiet single-shot runner for one generation. Mirrors the
   *  chat-summary resolution ladder (profile → effective profile with the
   *  bound-model overlay merge → execute with the route signal); failures
   *  PROPAGATE — the generation fails with the normalized provider error
   *  rather than silently skipping the assist. No VT-side key preflight:
   *  keyless providers (local gateways, BYOK endpoints) are legitimate
   *  assist providers — the endpoint answers for itself if it wants a key
   *  (owner ruling 2026-09-27: internal features never gate which provider
   *  profiles a user may bind). */
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

  /** IF-10: the learned prompt-cap table — advisory (backend, model) caps
   *  surfaced for the chip's live counter; tiny global list, no scoping. */
  listImageGenPromptCaps = async (): Promise<ImageGenPromptCapList> => {
    return (await this.stores.imageGenPromptCaps.list()).map((row) => ({
      backend: row.backend,
      modelId: row.modelId,
      maxPromptChars: row.maxPromptChars,
    }));
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

  // ── Image prompt families (IPT-3 — the registry read model; the global
  //    per-cell template routes were RETIRED by IF-1e — templates are
  //    profile-scoped now, see ImagePromptProfileAdapter) ──

  listPromptFamilies = async (): Promise<ImagePromptFamiliesValue> => {
    return { families: promptFamiliesReadModel() };
  };

  // ── Profile family (IPT-3 — the override writer + the detection ladder) ──

  setImageGenProfileFamily = async (
    id: string,
    family: ImagePromptFamilyValue | null,
  ): Promise<ImageGenProfileValue | null> => {
    // The Wave 3 family route is the ONLY family-override writer — the
    // store's null-clear convention rides the update patch (IPT-2); the
    // stored detection survives a pin and re-anchors after a clear.
    const updated = await this.stores.imageGen.update(id, { familyOverride: family });
    return updated ? (await decorateImageGenProfileAutoKeys(this.stores, [toClientProfile(updated)]))[0] : null;
  };

  detectImageGenProfileFamily = async (
    id: string,
    signal?: AbortSignal,
    modelOverride?: string,
  ): Promise<ImageGenFamilyDetectionResultValue | null> => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    // IF-8a (owner correction 2026-09-25): the ladder inspects the model
    // the user is LOOKING AT — the client names it explicitly, so a freshly
    // picked unsaved model is detectable on the spot (the save-first gate
    // is gone); the saved modelId stays the fallback and the persisted
    // anchor is the exact model that was inspected.
    const model =
      modelOverride !== undefined && modelOverride !== "" ? modelOverride : (profile.modelId ?? undefined);
    if (model === undefined || model === "") {
      throw validation("Image-gen family detection needs a selected model — pick one in the profile first");
    }
    // Capability-safe seam (IPT-3 review): construct the backend ONLY for
    // dialects that implement the detection surface — a profile on any
    // other dialect gets the honest all-structural-misses ladder without
    // paying that dialect's config validation (generation credentials are
    // irrelevant to detection; a keyless cloud profile must not 400 here).
    // The empty object satisfies the ladder's optional-method slice.
    const backend: FamilyDetectionBackend = IMAGE_GEN_FAMILY_DETECTION_BACKENDS.has(profile.backend)
      ? createImageGenBackend(
          profile.backend,
          await resolveAdapterConfig(this.stores, profile, this.fetchOverride),
        )
      : {};
    const result = await detectImageGenFamily({
      backend,
      model,
      signal,
      deps: {
        civitaiFetch: await this.resolvePublicApiFetch(),
        readSidecarFile: defaultReadSidecarFile,
      },
    });
    if (result.ok) {
      // Persist the detection with its model anchor — freshness is judged
      // against the live modelId by the generation-time resolver (IPT-2).
      await this.stores.imageGen.update(id, {
        familyDetected: result.family,
        familyDetectedForModel: model,
      });
    }
    return result;
  };

  /** The outbound public-API transport (source c — Civitai): the injected
   *  seam wins when present (tests — deterministic, no live network);
   *  production resolves the app's global-default proxy policy through
   *  the provider fetch factory (inherit), never a bare direct fetch that
   *  would bypass a configured proxy — the kokoro-mirror twin. */
  private async resolvePublicApiFetch(): Promise<typeof fetch> {
    if (this.fetchOverride !== undefined) return this.fetchOverride;
    const factory = getProviderFetchFactory();
    const resolved = await factory.resolveFetch({ proxyMode: PROXY_MODE.inherit, proxyId: null });
    return resolved ?? fetch;
  }
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
