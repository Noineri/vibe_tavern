/**
 * @module imagegen/backends/comfyui-listing
 *
 * The ComfyUI REST discovery walkers — moved out of comfyui.ts (IG-R2):
 * the /object_info combo walk and the /models folder walk behind every
 * model/sampler/lora/sidecar/detector listing, template detection, and
 * folder validation, plus the object-like guard they read responses
 * through. Shared by comfyui.ts (transport + factory) and
 * comfyui-second-passes.ts (detector discovery): the module both
 * import, so neither imports the other.
 */

import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

import { fetchOrWrap } from "./backend-helpers.js";
import { ComfyImageGenError } from "./comfyui-errors.js";

/** `unknown` → object-like guard; arrays pass — the folder_paths walks
 *  fold a top-level array into an empty map, not a user-visible error
 *  (SC-5r2). */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** GET /object_info/{node} → the combo values of a required input — the
 *  accepted filename enum ComfyUI's own queue validation checks against
 *  (template detection's ground truth, live-verified 0.36.0). CG-A3: the
 *  same walk serves `KSampler.sampler_name` / `KSampler.scheduler` for
 *  the live sampler/scheduler lists. */
export async function fetchComfyComboValues(
  transport: typeof fetch,
  endpoint: string,
  nodeName: string,
  inputName: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/object_info/${encodeURIComponent(nodeName)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "node input list",
    "ComfyUI image-gen",
    ComfyImageGenError,
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI node input list for ${nodeName} failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  const node = isObjectLike(parsed) ? parsed[nodeName] : undefined;
  const input = isObjectLike(node) ? node.input : undefined;
  const required = isObjectLike(input) ? input.required : undefined;
  const slot = isObjectLike(required) ? required[inputName] : undefined;
  const values = Array.isArray(slot) ? slot[0] : undefined;
  if (!Array.isArray(values)) {
    throw new ComfyImageGenError(
      `ComfyUI /object_info/${nodeName} returned an unexpected shape (no input.required.${inputName} combo)`,
    );
  }
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** GET /models/{folder} → the verbatim filename list (non-array responses
 *  fail closed — a silently-empty list would make every resolution miss).
 *  CG-A3: serves `checkpoints` and `diffusion_models` for the model union
 *  in addition to the DiT sidecar folders. */
export async function fetchComfyFolderNames(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/models/${encodeURIComponent(folder)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "sidecar folder list",
    "ComfyUI image-gen",
    ComfyImageGenError,
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI ${folder} list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!Array.isArray(parsed)) {
    throw new ComfyImageGenError(`ComfyUI /models/${folder} returned an unexpected shape (not a filename array)`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}
