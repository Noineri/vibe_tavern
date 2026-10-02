/**
 * @module imagegen/family-detection
 *
 * IPT-3 (IMAGE_PROMPT_TEMPLATES_PLAN Wave 3.4): authoritative
 * checkpoint-family detection for image-gen profiles. Runs a STRICT source
 * ladder against the profile's CURRENT model and returns the typed family
 * with the source that answered — or an honest structured failure carrying
 * every tried source in order. NO filename heuristics anywhere (owner
 * ruling): every label this module maps came from authoritative metadata
 * (a backend's own metadata surface, a sidecar next to a backend-exposed
 * path, Civitai's public by-hash API, or the Prompt All-in-One extension's
 * Civitai-resolved `base_model`); a label with no registry mapping, or an
 * SDXL-class label without a clearly disambiguating author tag corpus, is
 * a MISS — never a guess; the user pins once.
 *
 * Source order (fixed, tried[] mirrors it):
 *   a. backend-native metadata — the backend adapters' own authoritative
 *      surfaces (A1111/Forge sd-models anchors; ComfyUI's embedded
 *      safetensors header via /view_metadata);
 *   b. sidecars next to a model path — only when an authoritative backend
 *      response exposed that path (.cm-info.json `BaseModel` before
 *      .civitai.info `baseModel`, the CG-A3 live-verified precedence);
 *   c. Civitai public by-hash API — needs a sha256 anchor from (a); an
 *      SDXL-class baseModel disambiguates through the model's author tags
 *      (realism/photoreal, no anime → sdxl-realism);
 *   d. the Prompt All-in-One extension preset endpoint — when the dialect
 *      exposes it and (a) supplied the model's file path; only its
 *      Civitai-resolved `base_model` is read.
 *
 * Network/filesystem access is fully injected (tier T1): the Civitai
 * transport arrives as a dependency (the proxy-aware provider fetch in
 * production), the sidecar read as a function (Bun.file-based by default).
 * Tests pass stubs — no live network, no globalThis patching.
 */

import {
  disambiguateSdxlFamily,
  matchImagePromptBaseModel,
  type ImagePromptFamilyId,
} from "@vibe-tavern/domain";

import type { ImageGenModelDetectionMetadata, ImageGenSidecarAnchor } from "./imagegen-backend.js";

/** The slice of the backend contract the ladder reads (IPT-3): both
 *  members optional — a backend without one records the structural miss.
 *  The concrete ImageGenBackend satisfies this structurally; tests build
 *  small doubles without casts (tier T1). */
export interface FamilyDetectionBackend {
  readModelDetectionMetadata?(model: string, signal?: AbortSignal): Promise<ImageGenModelDetectionMetadata>;
  readModelPresetFromExtension?(filepath: string, signal?: AbortSignal): Promise<{ baseModel?: string }>;
}

// ─── Result shapes ───────────────────────────────────────────────────────────

/** The ordered detection ladder's source ids — also the success response's
 *  sourceLabel. */
export const FAMILY_DETECTION_SOURCES = {
  BackendMetadata: "backend-metadata",
  Sidecar: "sidecar",
  CivitaiByHash: "civitai-by-hash",
  ExtensionPreset: "extension-preset",
} as const;
export type FamilyDetectionSource = (typeof FAMILY_DETECTION_SOURCES)[keyof typeof FAMILY_DETECTION_SOURCES];

/** One tried-and-missed source, with the honest reason (always populated —
 *  the no-hidden-catch rule: every miss and error is recorded in order). */
export interface FamilyDetectionAttempt {
  source: FamilyDetectionSource;
  reason: string;
}

export type FamilyDetectionResult =
  | {
      ok: true;
      family: ImagePromptFamilyId;
      sourceLabel: FamilyDetectionSource;
      /** The raw base-model label that decided (UI provenance hint). */
      baseModel?: string;
    }
  | {
      ok: false;
      error: string;
      /** Every source in ladder order with its miss reason. */
      tried: FamilyDetectionAttempt[];
    };

// ─── Injected seams (tier T1) ────────────────────────────────────────────────

export interface FamilyDetectionDeps {
  /** Source (c) transport for the PUBLIC Civitai API — the proxy-aware
   *  provider fetch in production (resolved through the provider fetch
   *  factory's inherit policy); a stub in tests. */
  civitaiFetch: typeof fetch;
  /** Source (b) local sidecar read: returns the file's text, or undefined
   *  when unreadable (a miss, never an error). Bun.file-based default
   *  below; tests inject an in-memory map. */
  readSidecarFile(path: string): Promise<string | undefined>;
}

/** Production sidecar read (source b): Bun.file text; any read failure is
 *  undefined — the ladder continues (a remote or unreadable path simply
 *  has no sidecar to read). */
export function defaultReadSidecarFile(path: string): Promise<string | undefined> {
  return Bun.file(path).text().catch(() => undefined);
}

// ─── Source details ──────────────────────────────────────────────────────────

/** The public Civitai API root (source c). */
const CIVITAI_API_BASE = "https://civitai.com/api/v1";

/** Civitai request headers — the source-proven browser-style User-Agent
 *  the installed Prompt All-in-One extension sends on its own Civitai
 *  lookups (`_civitai_headers`, sd-civitai-browser-neo's pattern):
 *  Civitai's Cloudflare answers anonymous API hits without a browser UA
 *  with error 1010. A literal browser token, no app version baked in. */
const CIVITAI_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
};

/** Sidecar stores in precedence order — the ComfyUI backend's live-verified
 *  CG-A3 ladder precedence: Stability Matrix's `.cm-info.json` (top-level
 *  `BaseModel`) before the civitai download flow's `.civitai.info`
 *  (top-level `baseModel`). The stem rule: the model file's name minus its
 *  weights extension, in the same directory (subfolder preserved). */
const SIDECAR_STORES = [
  { suffix: ".cm-info.json", field: "BaseModel" },
  { suffix: ".civitai.info", field: "baseModel" },
] as const;

/** A hit, an SDXL-class label (only source (c) can fetch the tag corpus
 *  that disambiguates it), or a miss reason. */
type LabelOutcome =
  | { hit: { family: ImagePromptFamilyId; baseModel: string } }
  | { sdxl: string }
  | { miss: string };

/** Map one authoritative base-model label. SDXL-class labels need the
 *  author tag corpus — callers without corpus access turn them into the
 *  honest ambiguity miss via `sdxlMissReason`. */
function mapLabel(baseModel: string): LabelOutcome {
  const match = matchImagePromptBaseModel(baseModel);
  if (match.kind === "family") {
    return { hit: { family: match.family, baseModel } };
  }
  if (match.kind === "sdxl") return { sdxl: baseModel };
  if (match.kind === "ambiguous") {
    return {
      miss: `base model '${baseModel}' matches multiple families (${match.families.join(", ")}) — set the family manually`,
    };
  }
  return { miss: `base model '${baseModel}' has no registry family mapping — set the family manually` };
}

/** The honest ambiguity text for an SDXL-class label without a corpus. */
function sdxlMissReason(label: string): string {
  return `SDXL-class base model '${label}' needs an author tag corpus to disambiguate — set the family manually`;
}

/** Any non-hit outcome's miss text (corpus-less sources resolve the
 *  SDXL class to its honest ambiguity). */
function labelMissReason(outcome: { sdxl: string } | { miss: string }): string {
  return "sdxl" in outcome ? sdxlMissReason(outcome.sdxl) : outcome.miss;
}

/** The caller's abort propagates untouched; anything else is a miss
 *  reason (the no-hidden-catch rule: the error is RECORDED in tried[]). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trimmed non-empty label, or undefined — an empty/whitespace label is
 *  no label at all (the extension's filename-preset machinery answers
 *  with empty base_model exactly when it did NOT resolve via Civitai). */
function usableLabel(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Build the sidecar candidate paths for one anchor: each root joined with
 *  the model reference's directory + stem + each store suffix, in store
 *  precedence order. */
function sidecarCandidates(anchor: ImageGenSidecarAnchor): Array<{ path: string; field: string }> {
  const normalized = anchor.relativeName.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return [];
  const dir = slash >= 0 ? `${normalized.slice(0, slash)}/` : "";
  const out: Array<{ path: string; field: string }> = [];
  for (const store of SIDECAR_STORES) {
    for (const root of anchor.roots) {
      out.push({ path: `${root.replace(/[\\/]+$/, "")}/${dir}${stem}${store.suffix}`, field: store.field });
    }
  }
  return out;
}

// ─── The ladder ──────────────────────────────────────────────────────────────

/** Run the strict source ladder for one profile model. Every source runs
 *  only while no authoritative answer has resolved; each miss/error lands
 *  in `tried[]` in ladder order; the first hit wins and short-circuits. */
export async function detectImageGenFamily(options: {
  backend: FamilyDetectionBackend;
  model: string;
  deps: FamilyDetectionDeps;
  signal?: AbortSignal;
}): Promise<FamilyDetectionResult> {
  const { backend, model, deps, signal } = options;
  const tried: FamilyDetectionAttempt[] = [];

  // ── Source (a): backend-native metadata ──────────────────────────────
  let anchors: {
    sha256?: string;
    sidecar?: ImageGenSidecarAnchor;
    sidecarError?: string;
    modelFilePath?: string;
  } = {};
  if (backend.readModelDetectionMetadata === undefined) {
    tried.push({
      source: FAMILY_DETECTION_SOURCES.BackendMetadata,
      reason: "this backend dialect exposes no native model-metadata surface",
    });
  } else {
    let metadata: Awaited<ReturnType<NonNullable<FamilyDetectionBackend["readModelDetectionMetadata"]>>> | undefined;
    try {
      metadata = await backend.readModelDetectionMetadata(model, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      tried.push({
        source: FAMILY_DETECTION_SOURCES.BackendMetadata,
        reason: `backend metadata read failed: ${errorReason(error)}`,
      });
    }
    if (metadata !== undefined) {
      anchors = metadata;
      if (metadata.metadataError !== undefined) {
        // A carried backend-metadata failure (the reader's anchors stayed
        // obtainable) — record the real reason; the ladder continues on
        // the anchors below instead of dropping them with a throw.
        tried.push({ source: FAMILY_DETECTION_SOURCES.BackendMetadata, reason: metadata.metadataError });
      } else {
        const label = usableLabel(metadata.baseModel ?? "");
        if (label !== undefined) {
          const outcome = mapLabel(label);
          if ("hit" in outcome) {
            return { ok: true, family: outcome.hit.family, sourceLabel: FAMILY_DETECTION_SOURCES.BackendMetadata, baseModel: outcome.hit.baseModel };
          }
          tried.push({ source: FAMILY_DETECTION_SOURCES.BackendMetadata, reason: labelMissReason(outcome) });
        } else {
          tried.push({
            source: FAMILY_DETECTION_SOURCES.BackendMetadata,
            reason: "the backend's metadata surface carried no base-model label",
          });
        }
      }
    }
  }

  // ── Source (b): sidecars next to the backend-exposed path ────────────
  if (anchors.sidecar === undefined) {
    tried.push({
      source: FAMILY_DETECTION_SOURCES.Sidecar,
      reason: anchors.sidecarError ?? "no authoritative model path was exposed to join sidecars against",
    });
  } else {
    const candidates = sidecarCandidates(anchors.sidecar);
    let sidecarMiss = candidates.length === 0
      ? "the model reference carried no readable file stem"
      : "no readable .cm-info.json / .civitai.info sidecar next to the model";
    let sidecarHit: { family: ImagePromptFamilyId; baseModel: string } | undefined;
    for (const candidate of candidates) {
      const text = await deps.readSidecarFile(candidate.path);
      if (text === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const raw = (parsed as Record<string, unknown>)[candidate.field];
      if (typeof raw !== "string") continue;
      const label = usableLabel(raw);
      if (label === undefined) continue;
      const outcome = mapLabel(label);
      if ("hit" in outcome) {
        sidecarHit = outcome.hit;
        break;
      }
      sidecarMiss = labelMissReason(outcome);
    }
    if (sidecarHit !== undefined) {
      return { ok: true, family: sidecarHit.family, sourceLabel: FAMILY_DETECTION_SOURCES.Sidecar, baseModel: sidecarHit.baseModel };
    }
    tried.push({ source: FAMILY_DETECTION_SOURCES.Sidecar, reason: sidecarMiss });
  }

  // ── Source (c): Civitai public by-hash ───────────────────────────────
  const sha256 = anchors.sha256;
  if (sha256 === undefined) {
    tried.push({
      source: FAMILY_DETECTION_SOURCES.CivitaiByHash,
      reason: "no model hash available from an authoritative source",
    });
  } else {
    const civitai = await tryCivitaiByHash(sha256, deps, signal);
    if ("hit" in civitai) {
      return { ok: true, family: civitai.hit.family, sourceLabel: FAMILY_DETECTION_SOURCES.CivitaiByHash, baseModel: civitai.hit.baseModel };
    }
    tried.push({ source: FAMILY_DETECTION_SOURCES.CivitaiByHash, reason: civitai.miss });
  }

  // ── Source (d): the Prompt All-in-One extension preset ───────────────
  const probe = backend.readModelPresetFromExtension;
  if (probe === undefined) {
    tried.push({
      source: FAMILY_DETECTION_SOURCES.ExtensionPreset,
      reason: "this backend dialect has no model-preset extension surface",
    });
  } else if (anchors.modelFilePath === undefined) {
    tried.push({
      source: FAMILY_DETECTION_SOURCES.ExtensionPreset,
      reason: "no authoritative model file path to hand the extension",
    });
  } else {
    let recorded = false;
    let label: string | undefined;
    try {
      const preset = await probe(anchors.modelFilePath, signal);
      label = usableLabel(preset.baseModel ?? "");
    } catch (error) {
      if (isAbortError(error)) throw error;
      tried.push({
        source: FAMILY_DETECTION_SOURCES.ExtensionPreset,
        reason: `extension preset detection failed: ${errorReason(error)}`,
      });
      recorded = true;
    }
    if (label !== undefined) {
      const outcome = mapLabel(label);
      if ("hit" in outcome) {
        return { ok: true, family: outcome.hit.family, sourceLabel: FAMILY_DETECTION_SOURCES.ExtensionPreset, baseModel: outcome.hit.baseModel };
      }
      tried.push({ source: FAMILY_DETECTION_SOURCES.ExtensionPreset, reason: labelMissReason(outcome) });
      recorded = true;
    }
    if (!recorded) {
      tried.push({
        source: FAMILY_DETECTION_SOURCES.ExtensionPreset,
        reason: "the extension returned no Civitai-resolved base model",
      });
    }
  }

  return {
    ok: false,
    error: "No authoritative source identified this model's family — set it manually in the profile.",
    tried,
  };
}

// ─── Source (c) internals ────────────────────────────────────────────────────

/** One Civitai by-hash step's outcome: a hit, or the honest miss reason. */
type CivitaiOutcome =
  | { hit: { family: ImagePromptFamilyId; baseModel: string } }
  | { miss: string };

/** `GET /api/v1/model-versions/by-hash/{sha256}` → `baseModel`; an
 *  SDXL-class baseModel continues to `GET /api/v1/models/{modelId}` for
 *  the author tag corpus (realism/photoreal without anime →
 *  sdxl-realism, else the honest ambiguity). Every failure is a miss
 *  reason — never a thrown error, never a guess. */
async function tryCivitaiByHash(
  sha256: string,
  deps: FamilyDetectionDeps,
  signal: AbortSignal | undefined,
): Promise<CivitaiOutcome> {
  let version: unknown;
  try {
    const response = await deps.civitaiFetch(`${CIVITAI_API_BASE}/model-versions/by-hash/${sha256}`, {
      method: "GET",
      headers: CIVITAI_HEADERS,
      signal,
    });
    if (!response.ok) {
      // 404 = hash unknown to Civitai (private/offline merges); other
      // statuses are equally honest misses.
      return { miss: `Civitai by-hash lookup failed (HTTP ${response.status})` };
    }
    version = await response.json().catch(() => null);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { miss: `Civitai by-hash lookup failed: ${errorReason(error)}` };
  }
  if (typeof version !== "object" || version === null) {
    return { miss: "Civitai by-hash response was not a JSON object" };
  }
  const versionRecord = version as Record<string, unknown>;
  const baseModel = versionRecord.baseModel;
  if (typeof baseModel !== "string" || baseModel.trim().length === 0) {
    return { miss: "Civitai by-hash response carried no baseModel" };
  }
  const mapped = mapLabel(baseModel.trim());
  if ("hit" in mapped) return mapped;
  if ("sdxl" in mapped) {
    // The corpus step: the version's parent model carries the author tags.
    const modelId = versionRecord.modelId;
    if (typeof modelId !== "number" || !Number.isFinite(modelId)) {
      return { miss: `${sdxlMissReason(mapped.sdxl)} (no model id to fetch the tag corpus)` };
    }
    const tags = await fetchCivitaiModelTags(modelId, deps, signal);
    if (typeof tags === "string") return { miss: `${sdxlMissReason(mapped.sdxl)} (${tags})` };
    const family = disambiguateSdxlFamily(tags);
    if (family !== undefined) {
      return { hit: { family, baseModel: baseModel.trim() } };
    }
    return {
      miss: `SDXL-class base model '${baseModel.trim()}' with an author tag corpus that does not clearly indicate realism — set the family manually`,
    };
  }
  return { miss: mapped.miss };
}

/** `GET /api/v1/models/{modelId}` → the author tag corpus, or the miss
 *  reason string on failure. */
async function fetchCivitaiModelTags(
  modelId: number,
  deps: FamilyDetectionDeps,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | string> {
  let model: unknown;
  try {
    const response = await deps.civitaiFetch(`${CIVITAI_API_BASE}/models/${modelId}`, {
      method: "GET",
      headers: CIVITAI_HEADERS,
      signal,
    });
    if (!response.ok) {
      return `tag corpus fetch failed (HTTP ${response.status})`;
    }
    model = await response.json().catch(() => null);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return `tag corpus fetch failed: ${errorReason(error)}`;
  }
  if (typeof model !== "object" || model === null) return "tag corpus response was not a JSON object";
  const tags = (model as Record<string, unknown>).tags;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    return "tag corpus response carried no tags";
  }
  return tags;
}
