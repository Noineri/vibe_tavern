/**
 * @module imagegen/model-family
 *
 * Dialect-SHARED model-family normalization (extracted from the ComfyUI
 * backend for FT-A4): the family buckets and the embedded-metadata field
 * precedence are ecosystem facts, not ComfyUI facts — the A1111 dialect's
 * `/sdapi/v1/loras` metadata arm reads the SAME two keys the ComfyUI
 * ladder's embedded store reads (`ss_base_model_version` /
 * `modelspec.architecture`, delivered inline on the entry there vs.
 * `GET /view_metadata/…` here). One definition keeps a model's "Krea 2"
 * matching a LoRA's "Krea 2" across dialects.
 */

import { comfyWorkflowFamilyForBaseModel } from "@vibe-tavern/domain";

/** Embedded-metadata fields that name a model family, in precedence order:
 *  `ss_base_model_version` (kohya-training convention, LoRAs and finetunes)
 *  and `modelspec.architecture` (AI-Toolkit modelspec convention, DiT
 *  finetunes). The key literally contains a dot. */
export const EMBEDDED_FAMILY_FIELDS = ["ss_base_model_version", "modelspec.architecture"] as const;

/** Read the first non-empty embedded-family string off a metadata record
 *  (either dialect's parsed metadata dict) — undefined when the record is
 *  not an object or carries no usable value (the caller's ladder rule: a
 *  missed store degrades silently, never fails the list). */
export function readEmbeddedFamilyValue(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const entries = record as Record<string, unknown>;
  for (const field of EMBEDDED_FAMILY_FIELDS) {
    const raw = entries[field];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/** Normalize a raw base-model string from any metadata store into a
 *  canonical family label — the picker subtitle and (CG-A2/C3, FT-A4) the
 *  LoRA family-filter match key both sides normalize through, so a model's
 *  "Krea 2" matches a LoRA's "Krea 2" regardless of which store either
 *  side read. Exact DiT workflow labels are checked before legacy ecosystem
 *  buckets; every other recognized label keeps its existing behavior.
 * Anything unrecognized passes through VERBATIM (an honest labeled bucket,
 * never a wrong guess); empty → undefined. */
export function normalizeModelFamily(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const exactWorkflowFamily = comfyWorkflowFamilyForBaseModel(trimmed);
  if (exactWorkflowFamily !== undefined) return exactWorkflowFamily.workflowFamily;
  const lower = trimmed.toLowerCase();
  if (lower.includes("krea")) return "Krea 2";
  if (lower.includes("qwen")) return "Qwen Image";
  if (lower.includes("pony")) return "Pony";
  if (lower.includes("illustrious") || lower.includes("noobai")) return "Illustrious";
  if (lower.includes("flux")) return "Flux";
  if (
    lower.includes("sdxl") ||
    lower.includes("sd_xl") ||
    lower.includes("sd xl") ||
    lower.includes("stable-diffusion-xl")
  ) {
    return "SDXL";
  }
  if (
    lower.includes("sd15") ||
    lower.includes("sd 1.5") ||
    lower.includes("sd1.5") ||
    lower.includes("v1-5") ||
    lower.includes("stable-diffusion-v1") ||
    lower.includes("sd-v1")
  ) {
    return "SD 1.5";
  }
  return trimmed;
}
