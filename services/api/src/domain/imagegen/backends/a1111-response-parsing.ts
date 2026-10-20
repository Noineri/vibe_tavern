/**
 * @module imagegen/backends/a1111-response-parsing
 *
 * The A1111 dialect's response parsers — moved out of a1111.ts (IG-R4):
 * the `{images, parameters, info}` envelope walker, the checkpoint /
 * sampler / scheduler / lora / upscaler / extension list parsers, the
 * family-detection checkpoint finder with the Forge unet sidecar root,
 * and the progress snapshot parser. Every wire shape is the A1111
 * card's (IMAGE_GEN_LOCAL_BACKENDS_RESEARCH, doc-verified 2026-09-07);
 * the factory in a1111.ts fetches the endpoints and hands the raw JSON
 * here for parsing — importing a1111.ts stays the public path (the
 * error classes live in a1111-errors.ts).
 */

import type {
  ImageGenLoraInfo,
  ImageGenModelInfo,
  ImageGenProgressInfo,
  ImageGenSamplerInfo,
  ImageGenSchedulerInfo,
  ImageGenUpscalerInfo,
} from "../imagegen-backend.js";
import { normalizeModelFamily, readEmbeddedFamilyValue } from "../model-family.js";
import { A1111ImageGenError } from "./a1111-errors.js";

// ─── Response parsing ────────────────────────────────────────────────────────

/** Pull `images[]` out of the documented `{images, parameters, info}`
 *  envelope — non-empty base64 PNG strings. `parameters`/`info` are not
 *  parsed (inner shape not card-documented). Fails closed on absent,
 *  malformed, or empty containers. */
export function extractImages(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    throw new A1111ImageGenError("A1111 image-gen response is missing a JSON body");
  }
  const images = (payload as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new A1111ImageGenError("A1111 image-gen response carried no images");
  }
  for (const entry of images) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new A1111ImageGenError("A1111 image-gen response has a non-string images[] entry");
    }
  }
  return images;
}

/** Parse the `GET /sdapi/v1/sd-models` checkpoint list — a top-level array
 *  of `{title, model_name, hash, sha256, filename, config}` records. `id`
 *  maps the server's `title` verbatim: it is the canonical
 *  `sd_model_checkpoint` vocabulary, including Forge Neo's `unet\\…`
 *  entries with their extension and no hash suffix. `model_name` is only a
 *  legacy fallback for malformed entries without a title, so pre-IF-16f
 *  profile ids remain selectable. */
export function parseCheckpointInfos(parsed: unknown): ImageGenModelInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenModelInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" && item.title.length > 0 ? item.title : undefined;
    const modelName = typeof item.model_name === "string" && item.model_name.length > 0
      ? item.model_name
      : undefined;
    const id = title ?? modelName;
    if (id === undefined) continue;
    out.push({ id, label: title ?? id });
  }
  return out;
}

/** Parse `GET /sdapi/v1/sd-models` for family detection (IPT-3): the
 *  entry whose canonical `title` (or a legacy `model_name`) matches the
 *  current model id, carrying the authoritative anchors — `sha256` (feeds
 *  the Civitai by-hash source)
 *  and `filename` (the sidecar join / extension-probe file path). This
 *  surface carries NO base-model label — an honest structural miss for
 *  source (a) on this dialect. Undefined = the model is not in the list
 *  (the caller's fail-closed reselect message). */
export function findDetectionCheckpointEntry(
  parsed: unknown,
  model: string,
): { sha256?: string; filename?: string; title?: string } | undefined {
  if (!Array.isArray(parsed)) return undefined;
  let legacyMatch: Record<string, unknown> | undefined;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    // `title` is the current picker/profile id and must win over an
    // old-style model_name match. The fallback preserves detection for
    // profiles saved before titles became the stored vocabulary.
    if (item.title === model) {
      return {
        ...(typeof item.sha256 === "string" && item.sha256.length > 0 ? { sha256: item.sha256 } : {}),
        ...(typeof item.filename === "string" && item.filename.length > 0 ? { filename: item.filename } : {}),
        title: model,
      };
    }
    if (item.model_name === model) legacyMatch = item;
  }
  if (legacyMatch === undefined) return undefined;
  return {
    ...(typeof legacyMatch.sha256 === "string" && legacyMatch.sha256.length > 0
      ? { sha256: legacyMatch.sha256 }
      : {}),
    ...(typeof legacyMatch.filename === "string" && legacyMatch.filename.length > 0
      ? { filename: legacyMatch.filename }
      : {}),
    ...(typeof legacyMatch.title === "string" && legacyMatch.title.length > 0
      ? { title: legacyMatch.title }
      : {}),
  };
}

/** Forge Neo exposes shared DiT files through sd-models as `unet\\…` titles
 * while its `filename` points at the Stable-diffusion compatibility link.
 * Stability Matrix keeps the authoritative cm-info sidecars in its models
 * root's DiffusionModels folder (alongside, not inside, Packages), so add
 * that known root before the compatibility directory. A non-Matrix layout
 * falls back to a DiffusionModels sibling of Stable-diffusion. This derives
 * paths only from the backend-exposed title and filename; it never infers a
 * family from a name. */
export function forgeUnetSidecarRoot(filename: string, title: string | undefined): string | undefined {
  if (title === undefined || !/^unet[\\/]/i.test(title)) return undefined;
  const parts = filename.split(/[\\/]+/);
  let stableDiffusionIndex = -1;
  let packagesIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (stableDiffusionIndex === -1 && parts[index]?.toLowerCase() === "stable-diffusion") {
      stableDiffusionIndex = index;
    }
    if (parts[index]?.toLowerCase() === "packages") {
      packagesIndex = index;
      break;
    }
  }
  if (stableDiffusionIndex <= 0 || parts[stableDiffusionIndex + 1]?.toLowerCase() !== "unet") {
    return undefined;
  }
  const separator = filename.includes("\\") ? "\\" : "/";
  const modelsRoot = packagesIndex > 0 && packagesIndex < stableDiffusionIndex
    ? [...parts.slice(0, packagesIndex), "Models"]
    : parts.slice(0, stableDiffusionIndex);
  return `${modelsRoot.join(separator)}${separator}DiffusionModels`;
}

/** Parse the `GET /sdapi/v1/samplers` list — a top-level array of
 *  `{name, aliases, options}` records mapped onto `{name, aliases?}`. */
export function parseSamplerInfos(parsed: unknown): ImageGenSamplerInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenSamplerInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const info: ImageGenSamplerInfo = { name };
    if (
      Array.isArray(item.aliases) &&
      item.aliases.every((alias) => typeof alias === "string")
    ) {
      info.aliases = item.aliases as string[];
    }
    out.push(info);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/schedulers` list (PG-3) — a top-level array
 *  of `{name, label, aliases, options}` records mapped onto
 *  `{name, label?}`; entries without a usable name are skipped. */
export function parseSchedulerInfos(parsed: unknown): ImageGenSchedulerInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenSchedulerInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const info: ImageGenSchedulerInfo = { name };
    if (typeof item.label === "string" && item.label.length > 0) {
      info.label = item.label;
    }
    out.push(info);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/loras` list (FT-A4) — a top-level array of
 *  `{name, alias, path, metadata}` records (the builtin Lora extension's
 *  create_lora_json). `name` is the `<lora:>` tag vocabulary; family rides
 *  the embedded metadata's two family keys through the SHARED normalizer
 *  (a model's "Krea 2" matches a LoRA's "Krea 2" cross-dialect); NULL =
 *  the metadata carried nothing (the chip's unknown-family bucket). No
 *  trigger-word store exists on this endpoint → []. Entries without a
 *  usable name are skipped (the malformed-entry discipline). */
export function parseLoraInfos(parsed: unknown): ImageGenLoraInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenLoraInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      name,
      family: normalizeModelFamily(readEmbeddedFamilyValue(item.metadata)) ?? null,
      triggerWords: [],
    });
  }
  return out;
}

/** Parse the `GET /sdapi/v1/upscalers` list (FT-A4) — a top-level array of
 *  `{name, model_name, model_path, model_url, scale}` records; `name` is
 *  the `hr_upscaler` vocabulary. Entries without a usable name are
 *  skipped (the malformed-entry discipline). */
export function parseUpscalerInfos(parsed: unknown): ImageGenUpscalerInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenUpscalerInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({ name });
  }
  return out;
}

/** Parse the `GET /sdapi/v1/extensions` list — a top-level array of
 *  `{name, dirname, enabled, builtin}` records; `name` is the extension's
 *  directory identifier (the ADetailer probe's `adetailer`). Entries
 *  without a string name are skipped (the malformed-entry discipline). */
export function parseExtensionNames(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) out.push(name);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/progress` snapshot. `progress` (0..1) is the
 *  documented core and required; `eta_relative` maps when numeric;
 *  `state` passes through only as a string (object shape not
 *  card-documented — omitted rather than inventing a serialization);
 *  `current_image` (b64 preview, absent unless the server produces
 *  previews) maps onto `previewBase64` when non-empty. */
export function parseProgressInfo(payload: unknown): ImageGenProgressInfo {
  if (typeof payload !== "object" || payload === null) {
    throw new A1111ImageGenError("A1111 progress response is missing a JSON body");
  }
  const record = payload as Record<string, unknown>;
  const progress = record.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    throw new A1111ImageGenError("A1111 progress response has no numeric progress value");
  }
  const info: ImageGenProgressInfo = { progress };
  const eta = record.eta_relative;
  if (typeof eta === "number" && Number.isFinite(eta)) {
    info.etaRelative = eta;
  }
  if (typeof record.state === "string") {
    info.state = record.state;
  }
  if (typeof record.current_image === "string" && record.current_image.length > 0) {
    info.previewBase64 = record.current_image;
  }
  return info;
}
