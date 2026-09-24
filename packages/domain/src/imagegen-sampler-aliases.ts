import type { ImageGenSamplerSetPayload } from "./entities.js";

/**
 * Cross-dialect sampler vocabulary bridge (IF-7c).
 *
 * A sampler set stores FLAT VT param names — authored in whichever dialect
 * its source family runs (stock rows: Krea/Anima carry ComfyUI combo ids
 * like `euler_sde`; Diffusion carries the A1111 display name `Euler a`).
 * The two local backends translate at apply time, and their VOCABULARIES
 * drift: A1111 names samplers for display (`Euler a`), ComfyUI names them
 * as node combo ids (`euler_ancestral`). A name from one dialect may not
 * exist verbatim in the other's LIVE list — so every set application
 * resolves its names against the target's live list, with this static map
 * as the cross-dialect bridge (A1111's own `aliases` field covers most
 * A1111-side lookups; ComfyUI lists carry no aliases — the static map is
 * the only bridge there).
 *
 * Owner ruling (2026-09-22, IF-7c spec): a missing name surfaces a HINT,
 * never silent garbage — the resolver returns `null` and the caller shows
 * the note while applying everything else.
 */

/** One live-list entry as the samplers/schedulers routes return them. */
export interface SamplerLiveEntry {
  name: string;
  aliases?: string[];
}

export type LocalImageGenDialect = "a1111" | "comfyui";

/**
 * The static cross-dialect pairs — deliberately SMALL (the spec's "small
 * per-dialect alias map"): one-to-one translations only. Legacy
 * karras-suffixed A1111 names ("DPM++ 2M Karras") are excluded on purpose:
 * they encode sampler+scheduler in one name, and the ComfyUI twin needs a
 * scheduler value the map cannot express — those surface the honest
 * missing-name hint instead of a wrong translation.
 */
const SAMPLER_ALIAS_PAIRS: ReadonlyArray<readonly [a1111: string, comfyui: string]> = [
  ["Euler", "euler"],
  ["Euler a", "euler_ancestral"],
  ["Euler SDE", "euler_sde"],
  ["Heun", "heun"],
  ["LMS", "lms"],
  ["DDIM", "ddim"],
  ["UniPC", "uni_pc"],
  ["DPM++ 2M", "dpmpp_2m"],
  ["DPM++ 2M SDE", "dpmpp_2m_sde"],
  ["DPM++ 3M SDE", "dpmpp_3m_sde"],
  ["DPM++ SDE", "dpmpp_sde"],
  ["DPM++ 2S a", "dpmpp_2s_ancestral"],
];

const A1111_TO_COMFY: ReadonlyMap<string, string> = new Map(
  SAMPLER_ALIAS_PAIRS.map(([a, c]) => [a.toLowerCase(), c]),
);
const COMFY_TO_A1111: ReadonlyMap<string, string> = new Map(
  SAMPLER_ALIAS_PAIRS.map(([a, c]) => [c.toLowerCase(), a]),
);

/** Result of resolving one stored name against a target dialect's live list. */
export interface SamplerNameResolution {
  /** The name to SEND on this dialect — the live entry's own name. */
  name: string | null;
  /** True when resolution went through a bridge (alias field or static map). */
  viaBridge: boolean;
}

/**
 * Resolve a stored sampler name for one dialect's live list:
 * 1. exact name match;
 * 2. the live entry's own `aliases` (A1111 serves `euler_sde` as an alias of
 *    `Euler SDE` — the API-native bridge);
 * 3. the static cross-dialect map (either direction).
 * `null` = not available on this backend — the caller surfaces the hint.
 * `live` empty (no list — offline/unfetched/cloud) resolves to the stored
 * name unchanged: no list, no conclusion (the options-data rule).
 */
export function resolveSamplerNameForDialect(
  stored: string,
  live: readonly SamplerLiveEntry[],
): SamplerNameResolution {
  if (live.length === 0) return { name: stored, viaBridge: false };
  const exact = live.find((entry) => entry.name === stored);
  if (exact) return { name: exact.name, viaBridge: false };
  const byAlias = live.find((entry) => entry.aliases?.includes(stored));
  if (byAlias) return { name: byAlias.name, viaBridge: true };
  const lowered = stored.toLowerCase();
  const a = A1111_TO_COMFY.get(lowered);
  if (a !== undefined && live.some((entry) => entry.name === a)) {
    return { name: a, viaBridge: true };
  }
  const c = COMFY_TO_A1111.get(lowered);
  if (c !== undefined && live.some((entry) => entry.name === c)) {
    return { name: c, viaBridge: true };
  }
  return { name: null, viaBridge: false };
}

/**
 * Resolve a stored scheduler name. Both dialects share the k-diffusion
 * scheduler vocabulary (`karras`, `simple`, `sgm_uniform`, …) — identity
 * plus the live check; no static map needed. Same empty-list and
 * missing-name semantics as the sampler resolver.
 */
export function resolveSchedulerNameForDialect(
  stored: string,
  live: readonly SamplerLiveEntry[],
): SamplerNameResolution {
  if (live.length === 0) return { name: stored, viaBridge: false };
  return live.some((entry) => entry.name === stored)
    ? { name: stored, viaBridge: false }
    : { name: null, viaBridge: false };
}

/** Why one adapted field note exists — the caller composes the hint copy. */
export type SetFieldNoteReason = "translated" | "missing" | "dit-fixed-vae";

/** One surfaced adaptation note (structured; i18n happens at render). */
export interface SetFieldNote {
  field: "sampler" | "scheduler" | "vae";
  stored: string;
  resolved: string | null;
  reason: SetFieldNoteReason;
}

/** Target-shape input for {@link adaptSamplerSetPayloadToTarget}. */
export interface SamplerSetAdaptationTarget {
  /** null = no local sampler surface (cloud/unknown) — apply unchanged. */
  dialect: LocalImageGenDialect | null;
  /** ComfyUI DiT templates keep a FAMILY-FIXED VAE — the set's vae never applies. */
  ditFamilyFixedVae: boolean;
  samplers: readonly SamplerLiveEntry[];
  schedulers: readonly SamplerLiveEntry[];
  /** Live VAE name list; empty = no conclusion (note nothing, apply as stored). */
  vaes: readonly string[];
}

/**
 * Adapt a set payload for one target (IF-7c apply-time validation):
 * - sampler/scheduler resolve against the live lists (bridge on drift);
 *   a MISSING name keeps the arm's current value (field skipped) + note;
 * - vae on a DiT target is stripped + noted (family-fixed sidecar stands);
 * - vae on a swappable target outside the live list applies AS STORED +
 *   note (the stored-outside-list fallback philosophy — the file may
 *   appear later; the generation path's own behavior is unchanged).
 * Numeric fields (steps/cfg/…) pass through untouched.
 */
export function adaptSamplerSetPayloadToTarget(
  payload: ImageGenSamplerSetPayload,
  target: SamplerSetAdaptationTarget,
): { payload: ImageGenSamplerSetPayload; notes: SetFieldNote[] } {
  const notes: SetFieldNote[] = [];
  if (target.dialect === null) return { payload, notes };

  const next: ImageGenSamplerSetPayload = { ...payload };
  if (payload.sampler !== undefined) {
    const resolved = resolveSamplerNameForDialect(payload.sampler, target.samplers);
    if (resolved.name === null) {
      delete next.sampler;
      notes.push({ field: "sampler", stored: payload.sampler, resolved: null, reason: "missing" });
    } else {
      if (resolved.name !== payload.sampler) {
        notes.push({
          field: "sampler",
          stored: payload.sampler,
          resolved: resolved.name,
          reason: "translated",
        });
      }
      next.sampler = resolved.name;
    }
  }
  if (payload.scheduler !== undefined) {
    const resolved = resolveSchedulerNameForDialect(payload.scheduler, target.schedulers);
    if (resolved.name === null) {
      delete next.scheduler;
      notes.push({ field: "scheduler", stored: payload.scheduler, resolved: null, reason: "missing" });
    } else {
      next.scheduler = resolved.name;
    }
  }
  if (payload.vae !== undefined) {
    if (target.ditFamilyFixedVae) {
      delete next.vae;
      notes.push({ field: "vae", stored: payload.vae, resolved: null, reason: "dit-fixed-vae" });
    } else if (target.vaes.length > 0 && !target.vaes.includes(payload.vae)) {
      notes.push({ field: "vae", stored: payload.vae, resolved: null, reason: "missing" });
      // applies as stored — see the doc comment.
    }
  }
  return { payload: next, notes };
}
