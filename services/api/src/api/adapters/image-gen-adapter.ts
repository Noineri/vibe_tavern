/**
 * @module adapters/image-gen-adapter
 *
 * Wire adapter for image-gen profiles (IMAGE_GENERATION_PLAN IG-8): CRUD
 * projection over the ImageGenStore + the probe/models/samplers/generate/
 * gallery arms. Mirrors `stt-adapter.ts` in structure — same hasStoredApiKey
 * projection semantics (the secret lives in the typed `apiKey` column, never
 * in a JSON blob), same write-only tri-state on update.
 *
 * KEY RESOLUTION: image-gen has NO auto-key cascade in v1 (the STT/TTS
 * endpoint+vendor auto-match is documented STT/TTS behavior; the image-gen
 * design carries no equivalent rule) — the profile's OWN typed key is the
 * only source, and a keyless profile passes through to the backend factory
 * which surfaces whatever auth error applies (A1111 is keyless by default).
 *
 * The three backend adapters self-register via side-effect imports here
 * (protocol-registry pattern, the stt-adapter twin) — importing this module
 * makes every v1 slug creatable through the image-gen registry.
 *
 * GENERATE (the image message slot, design-locked semantics): resolve the
 * chat + profile, merge the profile's per-mode size presets and default
 * params with the request's fine-tuning overrides, call the backend with the
 * route's AbortSignal (NO timeout constants — the owner's ban), persist each
 * returned image as a FLAT asset (the bytes never leave the server; the
 * cloud-URL-expiry rule), and append one message carrying the attachment
 * (role/authorType `assistant`, empty content — the slot renders from its
 * attachment; the prompt-pipeline interplay is the generation-core unit's
 * contract, IG-14).
 */

import type {
  CreateImageGenProfileInput,
  DraftImageGenModelsInput,
  GenerateImageGenInput,
  ImageGenGenerateResponseValue,
  ImageGenGalleryPromoteResponseValue,
  ImageGenModelInfoValue,
  ImageGenProbeResultValue,
  ImageGenProfileValue,
  ImageGenSamplerInfoValue,
  UpdateImageGenProfileInput,
} from "@vibe-tavern/api-contracts";
import type {
  CreateImageGenProfileData,
  StoreContainer,
  UpdateImageGenProfileData,
} from "@vibe-tavern/db";
import type { Attachment, ImageGenProfile } from "@vibe-tavern/domain";

import type { AssetService } from "../../domain/asset/asset-service.js";
import type {
  ImageGenAdapterConfig,
  ImageGenGenerateRequest,
} from "../../domain/imagegen/imagegen-backend.js";
import { createImageGenBackend } from "../../domain/imagegen/imagegen-registry.js";
import type { ImageGenRuntimeApi } from "../contract/runtime-api.js";

// Import backend modules for their side-effect registrations (the
// stt-adapter twin): importing the module makes its slug creatable via the
// registry; the route layer reaches every backend through this file.
import "../../domain/imagegen/backends/openrouter.js";
import "../../domain/imagegen/backends/openai-images.js";
import "../../domain/imagegen/backends/a1111.js";

// ─── Route-ladder errors ─────────────────────────────────────────────────────

/** A profile / chat / asset the request names does not exist (route → 404). */
export class ImageGenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenNotFoundError";
  }
}

/** A well-formed request that names an inconsistent state (route → 400). */
export class ImageGenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenValidationError";
  }
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
    defaultParams: profile.defaultParams,
    modeSizePresets: profile.modeSizePresets,
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

/** Adapter config from a stored profile: the typed key is injected
 *  SERVER-SIDE (own-key-only resolution, no auto-match in v1) — the secret
 *  never crosses the API boundary. */
function configFromProfile(
  profile: ImageGenProfile,
  transport?: typeof fetch,
): ImageGenAdapterConfig {
  const config: ImageGenAdapterConfig = {
    endpoint: profile.endpoint,
    ...(profile.apiKey !== undefined && profile.apiKey !== "" ? { apiKey: profile.apiKey } : {}),
    ...(profile.modelId !== undefined && profile.modelId !== "" ? { model: profile.modelId } : {}),
    ...(transport !== undefined ? { fetch: transport } : {}),
  };
  return config;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

type ImageGenAdapterStores = Pick<
  StoreContainer,
  "imageGen" | "chats" | "messages" | "characterAssets"
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
  ) {}

  // ── Profile CRUD ────────────────────────────────────────────────────────

  listImageGenProfiles = async () =>
    (await this.stores.imageGen.listAll()).map(toClientProfile);

  getImageGenProfile = async (id: string) => {
    const profile = await this.stores.imageGen.getById(id);
    return profile ? toClientProfile(profile) : null;
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
      llmAssistEnabled: body.llmAssistEnabled,
      llmProviderProfileId: body.llmProviderProfileId,
      llmModelId: body.llmModelId,
      capabilities: body.capabilities,
      sortOrder: body.sortOrder,
    };
    return toClientProfile(await this.stores.imageGen.create(input));
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
    if (body.llmAssistEnabled !== undefined) patch.llmAssistEnabled = body.llmAssistEnabled;
    if (body.llmProviderProfileId !== undefined) patch.llmProviderProfileId = body.llmProviderProfileId;
    if (body.llmModelId !== undefined) patch.llmModelId = body.llmModelId;
    if (body.capabilities !== undefined) patch.capabilities = body.capabilities;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    const updated = await this.stores.imageGen.update(id, patch);
    return updated ? toClientProfile(updated) : null;
  };

  deleteImageGenProfile = async (id: string): Promise<void> => {
    await this.stores.imageGen.delete(id);
  };

  // ── Probe / models / samplers ───────────────────────────────────────────

  probeImageGenProfile = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    const backend = createImageGenBackend(profile.backend, configFromProfile(profile, this.fetchOverride));
    return backend.probe(signal);
  };

  listImageGenProfileModels = async (id: string, signal?: AbortSignal) => {
    const profile = await this.stores.imageGen.getById(id);
    if (!profile) return null;
    const backend = createImageGenBackend(profile.backend, configFromProfile(profile, this.fetchOverride));
    return backend.listModels(signal);
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
    const backend = createImageGenBackend(profile.backend, configFromProfile(profile, this.fetchOverride));
    // Interface-driven second gate (the STT `typeof backend.listModels`
    // twin): a backend without the sampler method reports "not supported",
    // not an empty catalog.
    if (typeof backend.listSamplers !== "function") return null;
    return backend.listSamplers(signal);
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

    // Effective params: request overrides WIN, then the profile's per-mode
    // size preset (width/height) and default params (steps/cfg/sampler/seed/
    // clipSkip), then the vendor default (field simply not sent). No value is
    // ever invented here (owner's hardcoded-parameters ban).
    const overrides = body.overrides ?? {};
    const modePreset = profile.modeSizePresets[body.mode];
    const defaults = profile.defaultParams;
    const model = overrides.model ?? profile.modelId;
    const width = overrides.width ?? modePreset?.width;
    const height = overrides.height ?? modePreset?.height;
    const steps = overrides.steps ?? defaults.steps;
    const cfgScale = overrides.cfgScale ?? defaults.cfgScale;
    const sampler = overrides.sampler ?? defaults.sampler;
    const seed = overrides.seed ?? defaults.seed;
    const clipSkip = overrides.clipSkip ?? defaults.clipSkip;
    const request: ImageGenGenerateRequest = {
      prompt: body.prompt,
      ...(overrides.negativePrompt !== undefined ? { negativePrompt: overrides.negativePrompt } : {}),
      ...(model !== undefined && model !== "" ? { model } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(steps !== undefined ? { steps } : {}),
      ...(cfgScale !== undefined ? { cfgScale } : {}),
      ...(sampler !== undefined ? { sampler } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(clipSkip !== undefined ? { clipSkip } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };

    const backend = createImageGenBackend(profile.backend, configFromProfile(profile, this.fetchOverride));
    const result = await backend.generate(request);

    // Persist every image as a FLAT asset (bytes server-side, immutable) and
    // build the slot's attachment entries — the same shape a client upload
    // produces, so rendering/vision-describe/promote all work unchanged.
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
      });
    }

    // The image message slot: one message carrying the generated attachment(s)
    // on the chat's active branch, appended at the feed tail (MessageStore has
    // no mid-history insert; the anchor is recorded in the response for the
    // client + IG-14's context-aware regeneration).
    const message = await this.stores.messages.addMessage({
      chatId: chat.id,
      branchId: chat.activeBranchId,
      role: "assistant",
      authorType: "assistant",
      content: "",
      attachmentsJson: JSON.stringify(attachments),
    });

    return {
      messageId: message.id,
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
}

// ─── MIME recovery for asset → gallery copy ──────────────────────────────────

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
