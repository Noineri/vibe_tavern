/**
 * @module imagegen/backends/comfyui-model-detection
 *
 * The ComfyUI model-family ladder (CG-A3) — moved out of comfyui.ts
 * (IG-R3): the embedded-metadata reads, the sidecar stores, the
 * folder-roots anchor, the one-model family resolver, and the LoRA
 * trigger-word stores behind every model/lora family label (plus the
 * IPT-3 detection twins that throw or carry failure reasons instead of
 * degrading silently).
 *
 * Doc gate (every wire fact below live-verified on the owner's ComfyUI
 * 0.36.0 / Stability Matrix instance, 2026-09-18 — probe scripts in
 * reports/IMAGEGEN_POLISH_REPORT.md § PG-5):
 * - model FAMILY (CG-A3): three metadata stores, first hit wins, every
 *   store degrading silently (a failed store never fails the list): (1)
 *   metadata EMBEDDED in the safetensors header via `GET
 *   /view_metadata/{folder}?filename=` (`ss_base_model_version` /
 *   `modelspec.architecture` — trainer truth, install-agnostic); (2)
 *   `.cm-info.json` sidecars (Stability Matrix, top-level `BaseModel`);
 *   (3) `.civitai.info` sidecars (the civitai download flow, top-level
 *   `baseModel`). Sidecar paths join against `GET
 *   /internal/folder_paths` (ComfyUI's own folder map — root lists per
 *   folder; on a remote host the paths don't exist locally and resolution
 *   auto-degrades to embedded-only). Raw values normalize through
 *   `normalizeComfyFamily` (canonical ecosystem buckets; unrecognized
 *   values pass through verbatim — the honest labeled bucket).
 *   IPT-3 reuses the SAME stores for family detection: `readModelDetectionMetadata`
 *   surfaces the RAW embedded label for one model (mapping happens
 *   detection-side — no picker bucket collapse) plus the folder-roots
 *   sidecar anchor; core ComfyUI exposes NO hash, so the Civitai by-hash
 *   source stays structurally unavailable on this dialect.
 */

import { readEmbeddedFamilyValue, normalizeModelFamily } from "../model-family.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

import { fetchOrWrap } from "./backend-helpers.js";
import { ComfyImageGenError } from "./comfyui-errors.js";
import { isObjectLike } from "./comfyui-listing.js";

// Shared with the A1111 dialect since FT-A4: the family buckets and the
// embedded-metadata field precedence are ecosystem facts — one definition
// in model-family.ts keeps cross-dialect filter keys identical. The
// legacy export name stays for the pinned test surface.
export { normalizeModelFamily as normalizeComfyFamily } from "../model-family.js";

/** Sidecar stores after the embedded metadata misses, in precedence order
 *  (CG-A3, live-verified): `.cm-info.json` (Stability Matrix's store —
 *  top-level `BaseModel`, mirrors civitai plus the user's manual manager
 *  edits) before `.civitai.info` (the civitai download flow's de-facto
 *  standard — top-level `baseModel`). The stem rule on disk: the model
 *  filename minus its weights extension, sitting in the same directory. */
const COMFY_SIDECAR_STORES = [
  { suffix: ".cm-info.json", field: "BaseModel" },
  { suffix: ".civitai.info", field: "baseModel" },
] as const;

/** GET /view_metadata/{folder}?filename={name} → the metadata dict EMBEDDED
 *  in the safetensors header (trainer truth — the ladder's primary source).
 *  ANY failure degrades silently to undefined (the ladder's rule: an
 *  unreadable store must not fail the model list); the caller's abort is
 *  the one exception and propagates. */
async function fetchComfyEmbeddedFamily(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "model metadata",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isObjectLike(parsed)) return undefined;
  return readEmbeddedFamilyValue(parsed);
}

/** GET /internal/folder_paths → the folder-name → root-paths map ComfyUI
 *  itself resolves (including launcher-shared dirs via
 *  extra_model_paths.yaml). Officially "frontend use only" — it is a BONUS
 *  source for the sidecar join, so any failure (404 on hardened remotes,
 *  transport error, unexpected shape) degrades silently to undefined and
 *  the ladder stays embedded-only (the plan's remote-host rule). */
export async function fetchComfyFolderRoots(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, string[]> | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isObjectLike(parsed)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return out;
}

/** IPT-3 detection twin of fetchComfyEmbeddedFamily: a 404 IS the honest
 *  no-label answer (the installed core's /view_metadata 404s when the
 *  safetensors header carries no `__metadata__` — server.py returns 404
 *  by design there), so it resolves undefined; every OTHER failure
 *  (non-404 status, transport, unparseable 200 body) THROWS the typed
 *  error so the ladder records the real reason at source (a). The
 *  listing twin keeps its silent degradation — both behaviors are
 *  intentional, one per consumer. */
export async function fetchComfyEmbeddedFamilyForDetection(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "model metadata",
    "ComfyUI image-gen",
    ComfyImageGenError,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI model metadata failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!isObjectLike(parsed)) {
    throw new ComfyImageGenError("ComfyUI /view_metadata response was not a JSON object");
  }
  return readEmbeddedFamilyValue(parsed);
}

/** IPT-3 detection twin of fetchComfyFolderRoots: a 404 is the structural
 *  no-anchor answer (hardened remotes legitimately expose no folder map —
 *  roots stay absent); every other failure returns its REASON so the
 *  reader records it on `sidecarError` and source (b) tells the real
 *  story instead of the structural "no path exposed" text. */
export async function fetchComfyFolderRootsForDetection(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ roots?: Record<string, string[]>; error?: string }> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (response.status === 404) return {};
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      return {
        error: `ComfyUI folder map failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      };
    }
    parsed = await response.json().catch(() => null);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      error: `ComfyUI folder map fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isObjectLike(parsed)) {
    return { error: "ComfyUI /internal/folder_paths response was not a JSON object" };
  }
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return { roots: out };
}

/** Read one sidecar store's family field off the local disk: the model's
 *  directory (subfolder part of the id, separators normalized) joined
 *  against each folder root until the file exists and parses. A miss,
 *  unreadable file, or wrong shape returns undefined — the ladder
 *  continues (a remote ComfyUI's roots simply do not exist locally). */
async function readComfySidecarFamily(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string | undefined> {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return undefined;
  const relative = `${slash >= 0 ? `${normalized.slice(0, slash)}/` : ""}${stem}${suffix}`;
  for (const root of roots) {
    try {
      const text = await Bun.file(`${root.replace(/[\\/]+$/, "")}/${relative}`).text();
      const parsed: unknown = JSON.parse(text);
      if (isObjectLike(parsed)) {
        const raw = parsed[field];
        if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one model's family through the full ladder (CG-A3):
 *  embedded safetensors metadata → `.cm-info.json` → `.civitai.info` →
 *  undefined ("unknown family" bucket). Every store degrades silently;
 *  only the caller's abort propagates. `rootsOf` lazily fetches (once per
 *  listing) the folder-roots map and only when the first sidecar lookup is
 *  actually needed — a fully-embedded resolution costs no extra call. */
export async function resolveComfyModelFamily(
  transport: typeof fetch,
  endpoint: string,
  options: {
    folder: string;
    name: string;
    signal: AbortSignal | undefined;
    rootsOf: () => Promise<Record<string, string[]> | undefined>;
  },
): Promise<string | undefined> {
  const embedded = normalizeModelFamily(
    await fetchComfyEmbeddedFamily(transport, endpoint, options.folder, options.name, options.signal),
  );
  if (embedded !== undefined) return embedded;
  const roots = (await options.rootsOf())?.[options.folder] ?? [];
  if (roots.length === 0) return undefined;
  for (const store of COMFY_SIDECAR_STORES) {
    const raw = await readComfySidecarFamily(roots, options.name, store.suffix, store.field);
    const normalized = normalizeModelFamily(raw);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/** Trigger-word sidecar stores, in precedence order (CG-C2, live-verified
 *  on the owner's install 2026-09-18): `.cm-info.json` `TrainedWords`
 *  (Stability Matrix's mirror — populated on civitai imports, null on
 *  manual adds) before `.civitai.info` `trainedWords` (the download
 *  flow's own store). No embedded rung: kohya's `ss_tag_frequency` is a
 *  frequency heuristic the owner's leading lora doesn't even carry —
 *  deliberately out (recorded, CG-C3 decision log). */
const COMFY_LORA_TRIGGER_STORES = [
  { suffix: ".cm-info.json", field: "TrainedWords" },
  { suffix: ".civitai.info", field: "trainedWords" },
] as const;

/** Read one sidecar store's trigger-word array off the local disk — the
 *  same stem/subfolder join as the family store. A missing field, wrong
 *  shape, or all-empty strings returns undefined (the ladder continues);
 *  entries are kept VERBATIM (civitai comma-phrases included). */
async function readComfySidecarTriggerWords(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string[] | undefined> {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return undefined;
  const relative = `${slash >= 0 ? `${normalized.slice(0, slash)}/` : ""}${stem}${suffix}`;
  for (const root of roots) {
    try {
      const text = await Bun.file(`${root.replace(/[\\/]+$/, "")}/${relative}`).text();
      const parsed: unknown = JSON.parse(text);
      if (isObjectLike(parsed)) {
        const raw = parsed[field];
        if (Array.isArray(raw)) {
          const words = raw.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
            .map((w) => w.trim());
          if (words.length > 0) return words;
        }
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one lora's activation words through the sidecar stores (CG-C2):
 *  cm-info → civitai.info → [] (none found). Silent per-store degradation;
 *  only the caller's abort propagates. No transport — the stores are read
 *  off the local disk through the lazily-fetched folder roots. */
export async function resolveComfyLoraTriggers(options: {
  name: string;
  signal: AbortSignal | undefined;
  rootsOf: () => Promise<Record<string, string[]> | undefined>;
}): Promise<string[]> {
  const roots = (await options.rootsOf())?.["loras"] ?? [];
  if (roots.length === 0) return [];
  for (const store of COMFY_LORA_TRIGGER_STORES) {
    const words = await readComfySidecarTriggerWords(roots, options.name, store.suffix, store.field);
    if (words !== undefined) return words;
  }
  return [];
}
