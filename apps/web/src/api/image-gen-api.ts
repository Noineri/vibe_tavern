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
  ImageGenSamplerInfoValue,
  ImageGenSamplerSet,
  ImageGenSamplerSetCreate,
  ImageGenSamplerSetImport,
  ImageGenSamplerSetUpdate,
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

/** One live-model-catalog entry (the picker's data source). */
export type ImageGenModelEntry = ImageGenModelInfoValue;

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

 /** One model's overlay — null = no bound settings yet (inherit the
  *  profile base) or unknown profile; both are "start empty" for the
  *  editor. */
export async function getImageGenModelSettings(
  id: string,
  modelId: string,
): Promise<ImageGenModelSettingsValue | null> {
  const response = await client.api["image-gen"].profiles[":id"]["model-settings"][":modelId"].$get({
    param: { id, modelId },
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
    param: { id, modelId },
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
    param: { id, modelId },
  });
  if (!response.ok) throw await unwrapError(response);
}

// ─── Named image-gen sampler sets (IG-CF15 — the sampler-set-api twin) ────────

/** The set library in store order (global — not scoped to a profile). */
export async function listImageGenSamplerSets(): Promise<ImageGenSamplerSet[]> {
  const response = await client.api["image-gen"]["sampler-sets"].$get();
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
