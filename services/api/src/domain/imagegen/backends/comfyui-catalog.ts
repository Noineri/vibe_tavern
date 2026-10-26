/**
 * @module imagegen/backends/comfyui-catalog
 *
 * The ComfyUI listing walkers — moved out of comfyui.ts (IG-R3b): the
 * backend object's read-only catalog methods (models, samplers,
 * schedulers, DiT sidecars, upscalers, VAE, face detectors, loras, and
 * the detection-metadata read), each a named function over the parsed
 * config — a listing reads nothing but cfg.endpoint/cfg.fetch. The
 * factory in comfyui.ts delegates every backend-object method to its
 * twin here (same signatures, same behaviour).
 */

import type {
  ImageGenDitSidecars,
  ImageGenLoraInfo,
  ImageGenModelDetectionMetadata,
  ImageGenModelInfo,
  ImageGenSamplerInfo,
  ImageGenSchedulerInfo,
  ImageGenUpscalerInfo,
} from "../imagegen-backend.js";
import { comfyWeightsBasename } from "./comfy-workflow-templates.js";
import { comfyNodeClassExists, fetchComfyFaceDetectors } from "./comfyui-second-passes.js";
import { ComfyImageGenConfigError } from "./comfyui-errors.js";
import { fetchComfyComboValues, fetchComfyFolderNames } from "./comfyui-listing.js";
import { COMFY_MODEL_TEMPLATES, resolveComfyListedDiffusionTemplate } from "./comfyui-workflows.js";
import {
  fetchComfyEmbeddedFamilyForDetection,
  fetchComfyFolderRoots,
  fetchComfyFolderRootsForDetection,
  resolveComfyLoraTriggers,
  resolveComfyModelFamily,
} from "./comfyui-model-detection.js";
import type { ComfyImageGenConfig } from "./comfyui-config.js";

export async function listComfyModels(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenModelInfo[]> {
  // The model union (CG-A3): checkpoints ∪ diffusion models — the two
  // folders the two templates load from. `id` keeps the server's path
  // VERBATIM (round-trips into ckpt_name/unet_name byte-identically,
  // subfolder separators included); `label` is the basename without the
  // weights extension; `template` marks which workflow the adapter
  // resolves; `family` rides the metadata ladder with silent
  // degradation (an unreadable store never fails the list).
  const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
  const unetNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal);
  // Folder roots for the sidecar join — fetched lazily, ONCE per
  // listing, and only when the first model actually needs a sidecar.
  let folderRoots: Record<string, string[]> | undefined;
  let folderRootsFetched = false;
  const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
    if (!folderRootsFetched) {
      folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
      folderRootsFetched = true;
    }
    return folderRoots;
  };
  const entries: ImageGenModelInfo[] = [];
  const folders: Array<{ folder: string; names: string[]; template: string }> = [
    { folder: "checkpoints", names: checkpointNames, template: COMFY_MODEL_TEMPLATES.checkpoint },
    { folder: "diffusion_models", names: unetNames, template: COMFY_MODEL_TEMPLATES.krea2Dit },
  ];
  for (const { folder, names, template } of folders) {
    for (const name of names) {
      const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
        folder,
        name,
        signal,
        rootsOf,
      });
      const label = comfyWeightsBasename(name);
      const resolvedTemplate = folder === "diffusion_models"
        ? resolveComfyListedDiffusionTemplate(family)
        : template;
      entries.push({
        id: name,
        label: label.length > 0 ? label : name,
        ...(family !== undefined ? { family } : {}),
        ...(resolvedTemplate !== undefined ? { template: resolvedTemplate } : {}),
      });
    }
  }
  return entries;
}

export async function listComfySamplers(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenSamplerInfo[]> {
  // The live KSampler sampler union (CG-A3) — the same /object_info
  // combo walk template detection uses; bare enums, no aliases.
  const names = await fetchComfyComboValues(
    cfg.fetch,
    cfg.endpoint,
    "KSampler",
    "sampler_name",
    signal,
  );
  return names.map((name) => ({ name }));
}

export async function listComfySchedulers(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenSchedulerInfo[]> {
  // The live KSampler scheduler union (CG-A3) — bare enums, no labels.
  const names = await fetchComfyComboValues(
    cfg.fetch,
    cfg.endpoint,
    "KSampler",
    "scheduler",
    signal,
  );
  return names.map((name) => ({ name }));
}

export async function listComfyDitSidecars(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenDitSidecars> {
  // The live DiT sidecar folders (CG-B1) — the same catalogs the
  // generate path resolves canonical sidecars against; both fetched in
  // parallel (independent folders, one round-trip each).
  const [encoders, vaes] = await Promise.all([
    fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "text_encoders", signal),
    fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal),
  ]);
  return { encoders, vaes };
}

export async function listComfyUpscalers(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenUpscalerInfo[]> {
  // The hires-upscaler vocabulary (FT-A4, comfy dialect): the live
  // upscale_models folder (the /models route — the per-node combo is
  // combo-truncated on 0.37+, the checkpoints-list precedent's source).
  // The chip's Auto ("") is the LATENT path — adapter-side, no entry.
  const names = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "upscale_models", signal);
  return names.map((name) => ({ name }));
}

export async function listComfyVae(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  // IF-7b: the live vae folder — the SAME catalog the DiT sidecar
  // resolver uses; here it feeds the checkpoint template's VAE-swap
  // field too (one folder, both templates' vocabulary).
  return fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal);
}

export async function listComfyFaceDetectors(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  // The IF-6 chain probe: BOTH links must hold — the Impact Pack's
  // FaceDetailer node exists AND the ultralytics folder/combo carries
  // at least one face bbox model. Either miss = [] (the honest
  // unavailable signal the picker gates on).
  if (!(await comfyNodeClassExists(cfg.fetch, cfg.endpoint, "FaceDetailer", signal))) return [];
  return fetchComfyFaceDetectors(cfg.fetch, cfg.endpoint, signal);
}

export async function listComfyLoras(
  cfg: ComfyImageGenConfig,
  signal?: AbortSignal,
): Promise<ImageGenLoraInfo[]> {
  // The lora list (CG-C2): names from the live LoraLoader combo (what
  // ComfyUI itself validates at queue time), family through the SAME
  // three-store ladder as models (folder "loras"), NULL = the ladder
  // found nothing (the chip's unknown-family bucket — never a guess).
  const names = await fetchComfyComboValues(
    cfg.fetch,
    cfg.endpoint,
    "LoraLoader",
    "lora_name",
    signal,
  );
  let folderRoots: Record<string, string[]> | undefined;
  let folderRootsFetched = false;
  const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
    if (!folderRootsFetched) {
      folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
      folderRootsFetched = true;
    }
    return folderRoots;
  };
  const entries: ImageGenLoraInfo[] = [];
  for (const name of names) {
    const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
      folder: "loras",
      name,
      signal,
      rootsOf,
    });
    // Activation words (owner-directed pull-forward 2026-09-18): the
    // sidecar stores only — discovered, never hardcoded.
    const triggerWords = await resolveComfyLoraTriggers({
      name,
      signal,
      rootsOf,
    });
    entries.push({ name, family: family ?? null, triggerWords });
  }
  return entries;
}

export async function readComfyModelDetectionMetadata(
  cfg: ComfyImageGenConfig,
  model: string,
  signal?: AbortSignal,
): Promise<ImageGenModelDetectionMetadata> {
  // IPT-3 source (a): locate the model's folder (the listModels union
  // walk for ONE model — /models/checkpoints before
  // /models/diffusion_models, the common sync-checkpoint case first),
  // then read the embedded safetensors `__metadata__` through the
  // backend's own /view_metadata surface (authoritative trainer
  // truth). Core ComfyUI exposes NO hash — the Civitai source's
  // anchor stays absent on this dialect (an honest miss).
  //
  // Failure honesty (IPT-3 review): the DETECTION twins below THROW
  // or carry reasons — the listing helpers' silent degradation stays
  // for the picker/list paths it was built for. /view_metadata 404 IS
  // the honest no-label answer (the installed core 404s when the
  // header carries no __metadata__); /internal/folder_paths 404 is
  // the structural no-anchor answer (hardened remotes); anything
  // else records the real reason at the source it failed.
  const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
  const folder = checkpointNames.includes(model)
    ? "checkpoints"
    : (await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal)).includes(model)
      ? "diffusion_models"
      : undefined;
  if (folder === undefined) {
    throw new ComfyImageGenConfigError(
      `ComfyUI model "${model}" is in neither the checkpoints nor the diffusion-models folder — reselect it from the model list`,
    );
  }
  const metadata: ImageGenModelDetectionMetadata = {};
  // Embedded read: a non-abort failure is CARRIED (metadataError),
  // not thrown — the folder-map anchor below stays obtainable for
  // source (b) even when /view_metadata itself errored, and the
  // rethrow-at-the-end pattern would discard it (the ladder drops
  // metadata on a reader throw).
  let embeddedError: Error | undefined;
  try {
    const embedded = await fetchComfyEmbeddedFamilyForDetection(
      cfg.fetch,
      cfg.endpoint,
      folder,
      model,
      signal,
    );
    if (embedded !== undefined) metadata.baseModel = embedded;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    embeddedError = error instanceof Error ? error : new Error(String(error));
  }
  // Sidecar join anchor: the folder roots the backend itself reports
  // via /internal/folder_paths (officially frontend-only — a bonus
  // source). Fetched EAGERLY: an embedded label that maps is the
  // common short-circuit, but an embedded miss OR an unmappable
  // embedded label (e.g. a bare SDXL architecture stamp) must still
  // let the sidecar source run — the ladder's correctness beats
  // saving one localhost round-trip. A failed map fetch records its
  // reason on sidecarError so source (b) tells the real story.
  const folderMap = await fetchComfyFolderRootsForDetection(cfg.fetch, cfg.endpoint, signal);
  if (folderMap.error !== undefined) {
    metadata.sidecarError = folderMap.error;
  } else {
    const roots = folderMap.roots?.[folder] ?? [];
    if (roots.length > 0) metadata.sidecar = { roots, relativeName: model };
  }
  if (embeddedError !== undefined) {
    metadata.metadataError = `backend metadata read failed: ${embeddedError.message}`;
  }
  return metadata;
}
