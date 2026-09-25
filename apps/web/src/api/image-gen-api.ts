/**
 * Image-gen profile API client (IMAGE_GENERATION_PLAN IG-10). Mirrors
 * stt-api.ts / tts-api.ts: profile CRUD via the typed Hono RPC client
 * (`client.api["image-gen"]…`, the bracket form for hyphenated path
 * segments — the experience-copilot precedent); the picker/probe family
 * (probe / models / samplers / draft models) via raw fetch with the
 * mobile-token query so abort signals ride the request (the
 * generateTtsSpeech / listSttDraftModels precedent).
 *
 * Wire types come from @vibe-tavern/api-contracts (IG-3/IG-8) — never
 * re-declared locally. The secret rides the top-level write-only `apiKey`
 * field and is projected back as `hasStoredApiKey` (the STT/TTS key rule).
 * Scope: CRUD + probe/models/samplers + the chat-surface generate call
 * (IG-16); gallery-promote is the remaining later-unit surface.
 */

import type { z } from "zod";
import type {
  CreateImageGenProfileInput,
  DraftImageGenModelsInput,
  FavoriteImageGenModelInput,
  ImageGenModelFavoriteValue,
  ImageGenModelInfoValue,
  ImageGenModelSettingsOverlayValue,
  ImageGenModelSettingsValue,
  ImageGenProfileValue,
  ImageGenProgressInfoValue,
  ImageGenSamplerInfoValue,
  ImageGenSchedulerInfoValue,
  ImageGenDitSidecarsValue,
  ImageGenLoraInfoValue,
  ImageGenUpscalerInfoValue,
  ImagePromptFamiliesValue,
  ImagePromptFamilyValue,
  ImageGenFamilyDetectionResultValue,
  ImageGenSamplerSet,
  ImageGenSamplerSetCreate,
  ImageGenSamplerSetImport,
  ImageGenSamplerSetUpdate,
  ImageGenPromptCap,
  GenerateImageGenInput,
  ImageGenGenerateResponseValue,
  UpdateImageGenProfileInput,
} from "@vibe-tavern/api-contracts";
import { createImageGenProfileSchema } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

/** Read-side wire record alias — the naming convention the STT/TTS clients
 *  established (`SttProfileRecord`), bound to the contracts type instead of
 *  a local re-declaration. */
export type ImageGenProfileRecord = ImageGenProfileValue;

/** IF-10: one learned provider prompt-cap row (advisory counter data). */
export type { ImageGenPromptCap };

/** One live-model-catalog entry (the picker's data source). */
export type ImageGenModelEntry = ImageGenModelInfoValue;

/** IPT-4 pane contracts: the server resolves canon inheritance before these
 *  reach the browser, so callers render cells verbatim instead of duplicating
 *  family fallback logic. The per-cell template client (GET/PUT/DELETE) was
 *  RETIRED by IF-1e — templates are profile-scoped (image-prompt-profile-api). */
export type ImagePromptFamiliesRecord = ImagePromptFamiliesValue;

export async function listImagePromptFamilies(): Promise<ImagePromptFamiliesRecord> {
  const response = await client.api["image-gen"]["prompt-families"].$get();
  return unwrapRpc(response);
}

// ─── CRUD (typed Hono RPC) ───────────────────────────────────────────────────

export async function listAllImageGenProfiles(): Promise<ImageGenProfileRecord[]> {
  const response = await client.api["image-gen"].profiles.all.$get();
  return unwrapRpc(response);
}

export async function getImageGenProfile(id: string): Promise<ImageGenProfileRecord | null> {
  const response = await client.api["image-gen"].profiles[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

/** Create-call body — the INPUT side of the create schema (`z.input`, the
 *  lorebook-api/types.ts precedent): server-side `.default()` fields
 *  (sortOrder, llmAssistEnabled) stay optional for the caller while the
 *  z.infer output type keeps them required. */
export type CreateImageGenProfileBody = z.input<typeof createImageGenProfileSchema>;

export async function createImageGenProfile(
  body: CreateImageGenProfileBody,
): Promise<ImageGenProfileRecord> {
  const response = await client.api["image-gen"].profiles.$post({ json: body });
  return unwrapRpc(response);
}

export async function updateImageGenProfile(
  id: string,
  body: UpdateImageGenProfileInput,
): Promise<ImageGenProfileRecord> {
  const response = await client.api["image-gen"].profiles[":id"].$patch({ param: { id }, json: body });
  if (response.status === 404) throw await unwrapError(response);
  return unwrapRpc(response);
}

export async function deleteImageGenProfile(id: string): Promise<void> {
  const response = await client.api["image-gen"].profiles[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

/** MR-12 (the STT `setSttDefault` twin): move the GLOBAL active-profile
 *  pointer server-side — survives restarts/reloads (owner report
 *  2026-09-19). Returns the updated record. */
export async function setImageGenDefault(id: string): Promise<ImageGenProfileRecord> {
  const response = await client.api["image-gen"].profiles[":id"].default.$put({ param: { id } });
  if (response.status === 404) throw await unwrapError(response);
  return unwrapRpc(response);
}

// ─── Profile family (IPT-5 — manual pin + the detection probe) ───────────────

/** Manual family pin, or null to clear it back to the auto path (IPT-3).
 * This route is the ONLY family-override writer; returns the updated
 * record so callers can refresh their server-state view. */
export async function setImageGenProfileFamily(
  id: string,
  family: ImagePromptFamilyValue | null,
): Promise<ImageGenProfileRecord> {
  const response = await client.api["image-gen"].profiles[":id"].family.$put({
    param: { id },
    json: { family },
  });
  if (response.status === 404) throw await unwrapError(response);
  return unwrapRpc(response);
}

/** Run the authoritative detection ladder for a saved profile (IPT-3) —
 * probe-family raw fetch so an abort signal rides the request (the route
 * forwards it into the server-side ladder). A no-answer is DATA
 * (ok:false + the ordered tried[] ladder), never a thrown error;
 * transport/route failures (unknown profile, no model) throw. */
export async function detectImageGenProfileFamily(
  id: string,
  signal?: AbortSignal,
  model?: string,
): Promise<ImageGenFamilyDetectionResultValue> {
  const baseUrl = getGatewayBaseUrl();
  // IF-8a: the DISPLAYED model rides the query — detection runs against it
  // without a save round-trip (the save-first gate is gone, owner correction
  // 2026-09-25).
  const modelQuery = model !== undefined && model !== "" ? `?model=${encodeURIComponent(model)}` : "";
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/detect-family${modelQuery}`),
    { method: "POST", signal },
  );
  if (!response.ok) throw await rawError("Image-gen family detection", response);
  return (await response.json()) as ImageGenFamilyDetectionResultValue;
}

// ─── Probe / models / samplers / draft (raw fetch, signal-aware) ─────────────

/** Excerpt length for a failed picker/probe response body included in the
 *  thrown error message (the stt/tts client convention). */
const ERROR_BODY_EXCERPT_LENGTH = 200;

async function rawError(operation: string, response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(
    `${operation} failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}` : ""}`,
  );
}

/** Live model catalog for a saved profile (picker data source). Null = the
 *  route's 404 (unknown profile); upstream backend failures throw (the route
 *  maps them to typed error bodies). */
export async function listImageGenModels(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenModelEntry[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/models`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen model list", response);
  return (await response.json()) as ImageGenModelEntry[];
}

/** Samplers for a saved profile — capability-gated (A1111-compat only in
 *  v1). Null = unknown profile; an unsupported backend throws the route's
 *  400 message ("sampler listing not supported") — the hook gates on
 *  `supportsSamplers` before calling. */
export async function listImageGenSamplers(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenSamplerInfoValue[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/samplers`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen sampler list", response);
  return (await response.json()) as ImageGenSamplerInfoValue[];
}

/** Server extension names for a saved profile — A1111-dialect feature
 *  detection (IG-CF15/PG-4: the ADetailer probe). Null = unknown profile;
 *  a non-A1111 backend throws the route's 400 ("extension listing not
 *  supported") — callers gate on the profile's backend before calling. */
export async function listImageGenExtensions(
  id: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/extensions`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen extension list", response);
  return (await response.json()) as string[];
}

/** Face-detector model list for a saved ComfyUI-dialect profile (IF-6 —
 *  the Impact Pack chain probe): the DISCOVERED face bbox models feeding
 *  the ADetailer-equivalent toggle + picker. Null = unknown profile; a
 *  non-comfy backend throws the route's 400 — callers gate on the
 *  profile's backend before calling. An EMPTY array = the dialect is
 *  right but the chain is absent (the honest unavailable signal). */
export async function listImageGenFaceDetectors(
  id: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/face-detectors`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen face detector list", response);
  return (await response.json()) as string[];
}

/** Scheduler (schedule type) list for a saved A1111-dialect profile
 *  (PG-3): the live `GET /sdapi/v1/schedulers` catalog for the advanced
 *  panel's dropdown — fetched at form time, never hardcoded. Null =
 *  unknown profile; throws on transport/5xx. */
export async function listImageGenSchedulers(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenSchedulerInfoValue[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/schedulers`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen scheduler list", response);
  return (await response.json()) as ImageGenSchedulerInfoValue[];
}

/** DiT sidecar (text encoder + VAE) lists for a saved ComfyUI-dialect
 *  profile (CG-B1): the live folder catalogs for the advanced accordion's
 *  DiT fields. Null = unknown profile; a non-comfy backend throws the
 *  route's 400 ("DiT sidecar listing not supported") — callers gate on
 *  the profile's backend before calling. */
export async function listImageGenDitSidecars(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenDitSidecarsValue | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/sidecars`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen DiT sidecar list", response);
  return (await response.json()) as ImageGenDitSidecarsValue;
}

/** Re-exported contracts alias — the hook's sidecar cache entry. */
export type ImageGenDitSidecars = ImageGenDitSidecarsValue;

/** LoRA list for a saved local-dialect profile (CG-C2 / FT-A4): names +
 *  family (null = the unknown-family bucket), feeding the fine-tuning
 *  chip's family-filtered picker (CG-C3). Null = unknown profile; a
 *  backend without the surface throws the route's 400 ("LoRA listing not
 *  supported") — callers gate on the profile's backend before calling. */
export async function listImageGenLoras(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenLoraInfoValue[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/loras`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen lora list", response);
  return (await response.json()) as ImageGenLoraInfoValue[];
}

/** Re-exported contracts alias — the chip's lora list entry. */
export type ImageGenLora = ImageGenLoraInfoValue;

/** Upscaler list for a saved a1111-dialect profile (FT-A4): the
 *  `hr_upscaler` vocabulary for the hires-fix block's dropdown. Null =
 *  unknown profile; a backend without the surface throws the route's 400
 *  ("Upscaler listing not supported") — callers gate on the profile's
 *  backend before calling. */
export async function listImageGenUpscalers(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenUpscalerInfoValue[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/upscalers`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen upscaler list", response);
  return (await response.json()) as ImageGenUpscalerInfoValue[];
}

/** Re-exported contracts alias — the chip's upscaler list entry. */
export type ImageGenUpscaler = ImageGenUpscalerInfoValue;

/** VAE list for a saved local profile (IF-7b): the swappable-VAE vocabulary
 *  for the advanced accordion's VAE field (A1111 `/sdapi/v1/sd-vae` +
 *  ComfyUI `/models/vae`). Null = unknown profile; a backend without the
 *  surface throws the route's 400 — callers gate on the profile's backend
 *  before calling. */
export async function listImageGenVae(id: string, signal?: AbortSignal): Promise<string[] | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/vaes`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen VAE list", response);
  return (await response.json()) as string[];
}

/** One live progress snapshot for a saved local profile (PG-2): polled by
 *  the chat surface ONLY while our own generate request is in flight
 *  (A1111's progress is global-per-instance — cross-talk is ignored by
 *  construction outside a run). Throws on transport/5xx; callers treat any
 *  failure as "no data this tick". */
export async function fetchImageGenProgress(
  id: string,
  signal?: AbortSignal,
): Promise<ImageGenProgressInfoValue | null> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/progress`),
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await rawError("Image-gen progress", response);
  return (await response.json()) as ImageGenProgressInfoValue;
}

/** Ask the profile's local instance to cancel its current job (PG-2,
 *  `POST /sdapi/v1/interrupt` through our server). Fire-and-forget by
 *  design: the transport abort is the user-visible cancel, this stops the
 *  GPU work behind it. Throws on failure; the store swallows (a dead
 *  interrupt must not mask the cancel). */
export async function interruptImageGenProfile(id: string, signal?: AbortSignal): Promise<void> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/profiles/${encodeURIComponent(id)}/interrupt`),
    { method: "POST", signal },
  );
  if (!response.ok && response.status !== 204) {
    throw await rawError("Image-gen interrupt", response);
  }
}

/** Shared fetch-by-endpoint model listing over the TRANSIENT draft config
 *  (the STT draft twin): the form's just-typed key rides INSIDE `config`;
 *  `profileId` lets the server inject the stored key when the form's own is
 *  empty and the endpoint matches. Throws the route's 400 message for a
 *  backend without a model-listing surface. */
export async function draftListImageGenModels(
  body: DraftImageGenModelsInput,
  signal?: AbortSignal,
): Promise<ImageGenModelEntry[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/image-gen/draft/models`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await rawError("Image-gen draft model list", response);
  return (await response.json()) as ImageGenModelEntry[];
}

// ─── Chat-surface generate (IG-16 — raw fetch, abort-signal aware) ──────────

/** Fire ONE image generation in a chat (the IG-8/IG-14 locked contract:
 * profile + mode + anchor message; the server builds the prompt, appends
 * the image slot, and returns its provenance). The signal is the Stop
 * control's seam — a user abort maps server-side to a silent cancel (the
 * route distinguishes it from the 180s cloud timer). */
export async function generateImageGen(
  chatId: string,
  body: GenerateImageGenInput,
  signal?: AbortSignal,
): Promise<ImageGenGenerateResponseValue> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/chats/${encodeURIComponent(chatId)}/image-gen/generate`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) throw await rawError("Image-gen generate", response);
  return (await response.json()) as ImageGenGenerateResponseValue;
}

// ─── Model favorites + per-model overlay (IG-12b — typed Hono RPC, the
//     CRUD family: no abort-signal needs surfaced by the pane in v1) ─────────

/** Starred models of a saved profile (persisted bookmarks — the picker
 *  pins them on top). */
export async function listImageGenModelFavorites(id: string): Promise<ImageGenModelFavoriteValue[]> {
  const response = await client.api["image-gen"].profiles[":id"]["model-favorites"].$get({ param: { id } });
  return unwrapRpc(response);
}

/** Star a model (idempotent; refreshes the label when re-starred). */
export async function addImageGenModelFavorite(
  id: string,
  body: FavoriteImageGenModelInput,
): Promise<ImageGenModelFavoriteValue> {
  const response = await client.api["image-gen"].profiles[":id"]["model-favorites"].$post({
    param: { id },
    json: body,
  });
  return unwrapRpc(response);
}

/** Un-star a model (the overlay row SURVIVES — favorites are bookmarks,
 *  overlays are config; the provider-twin rule). */
export async function removeImageGenModelFavorite(id: string, modelId: string): Promise<void> {
  const response = await client.api["image-gen"].profiles[":id"]["model-favorites"].$delete({
    param: { id },
    json: { modelId },
  });
  if (!response.ok) throw await unwrapError(response);
}

/** Model ids ride the URL PATH — Krea ids (`krea/krea-2/…`) and ComfyUI
 *  folder paths contain `/`, which must be percent-encoded or Hono's
 *  `:modelId` (single-segment) misses and the SPA fallback answers HTML
 *  (the "Unexpected token '<'" JSON error). The hono client substitutes
 *  params RAW; the route decodes `%2F` back to the id. */
function modelIdPathSegment(modelId: string): string {
  return encodeURIComponent(modelId);
}

 /** One model's overlay — null = no bound settings yet (inherit the
  *  profile base) or unknown profile; both are "start empty" for the
  *  editor. */
export async function getImageGenModelSettings(
  id: string,
  modelId: string,
): Promise<ImageGenModelSettingsValue | null> {
  const response = await client.api["image-gen"].profiles[":id"]["model-settings"][":modelId"].$get({
    param: { id, modelId: modelIdPathSegment(modelId) },
  });
  if (response.status === 404) return null;
  const body: unknown = await response.json();
  return body === null ? null : (body as ImageGenModelSettingsValue);
}

/** Upsert a model's overlay (idempotent on (profile, model); replaces the
 *  stored overlay wholesale — absent fields go back to inheriting the base).
 *  `samplerSetId` rides the same upsert (IG-CF15): absent = keep the stored
 *  pointer, null = clear, string = set. */
export async function upsertImageGenModelSettings(
  id: string,
  modelId: string,
  overlay: ImageGenModelSettingsOverlayValue,
  samplerSetId?: string | null,
): Promise<ImageGenModelSettingsValue> {
  const response = await client.api["image-gen"].profiles[":id"]["model-settings"][":modelId"].$put({
    param: { id, modelId: modelIdPathSegment(modelId) },
    json: {
      settings: overlay,
      ...(samplerSetId !== undefined ? { samplerSetId } : {}),
    },
  });
  return unwrapRpc(response);
}

/** Delete a model's overlay — the model reverts to the profile base. */
export async function deleteImageGenModelSettings(id: string, modelId: string): Promise<void> {
  const response = await client.api["image-gen"].profiles[":id"]["model-settings"][":modelId"].$delete({
    param: { id, modelId: modelIdPathSegment(modelId) },
  });
  if (!response.ok) throw await unwrapError(response);
}

// ─── Named image-gen sampler sets (IG-CF15 — the sampler-set-api twin) ────────

/** The set library in store order (global — not scoped to a profile). */
export async function listImageGenSamplerSets(): Promise<ImageGenSamplerSet[]> {
  const response = await client.api["image-gen"]["sampler-sets"].$get();
  return unwrapRpc(response);
}

/** IF-10: learned provider prompt caps — advisory per-(backend, model)
 *  counter data for the chip's prompt editor; never gates a send. */
export async function listImageGenPromptCaps(): Promise<ImageGenPromptCap[]> {
  const response = await client.api["image-gen"]["prompt-caps"].$get();
  return unwrapRpc(response);
}

/** Create a set from the pane's current values (the «+» flow). */
export async function createImageGenSamplerSet(
  input: ImageGenSamplerSetCreate,
): Promise<ImageGenSamplerSet> {
  const response = await client.api["image-gen"]["sampler-sets"].$post({ json: input });
  return unwrapRpc(response);
}

/** Rename and/or overwrite the stored payload (pencil / 💾 flows). */
export async function updateImageGenSamplerSet(
  setId: string,
  input: ImageGenSamplerSetUpdate,
): Promise<ImageGenSamplerSet> {
  const response = await client.api["image-gen"]["sampler-sets"][":setId"].$patch({
    param: { setId },
    json: input,
  });
  return unwrapRpc(response);
}

/** Delete a set; overlay rows' provenance pointers to it are cleared
 *  server-side first (LS-5e twin — applied values stay). */
export async function deleteImageGenSamplerSet(setId: string): Promise<void> {
  const response = await client.api["image-gen"]["sampler-sets"][":setId"].$delete({
    param: { setId },
  });
  if (!response.ok) throw await unwrapError(response);
}

/** Point import (upload button): name + raw parsed JSON (VT-native). */
export async function importImageGenSamplerSet(
  input: ImageGenSamplerSetImport,
): Promise<{ set: ImageGenSamplerSet; notes: string[] }> {
  const response = await client.api["image-gen"]["sampler-sets"].import.$post({ json: input });
  return unwrapRpc(response);
}

/** IG-18: copy a generated image asset into the character's gallery (the
 *  existing promote route; the sent message's attachment stays immutable).
 *  The gallery entry rides the character's gallery store exactly like an
 *  uploaded gallery image. */
export async function promoteImageGenAttachmentToGallery(
  assetId: string,
  characterId: string,
): Promise<import("@vibe-tavern/api-contracts").ImageGenGalleryPromoteResponseValue> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/image-gen/attachments/${encodeURIComponent(assetId)}/promote-to-gallery`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to add to gallery: ${response.status}`);
  }
  return response.json();
}
