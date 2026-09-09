/**
 * Pure helpers for the sampler preset clipboard (Wave 6).
 *
 * Copy direction:  form → {@link computeOverlayPatch} → JSON → clipboard.
 * Paste direction: clipboard → JSON → {@link samplerPresetPayloadSchema}.safeParse
 *                  → {@link applySamplerPresetFields} → form (via updateForm).
 *
 * The schema (= modelSettingsOverlaySchema) is the single validator on the
 * paste side; it accepts a partial overlay (absent field = inherit, not
 * overwrite). `applySamplerPresetFields` only touches fields that are PRESENT
 * in the parsed payload — it never nulls-out or resets a field the clipboard
 * blob didn't include.
 *
 * Routing (overlay vs base) is automatic: `updateForm` (= lazyAutoSaveField in
 * the modal) already routes to the overlay or base based on
 * `form.bindPerModel && form.editingModelId` (Wave 4). So a paste in overlay
 * mode naturally writes the bound model's overlay; in base mode, the base.
 */

import type { ModelSettingsOverlay, SamplerFieldId } from "@vibe-tavern/domain";
import { SAMPLER_FIELDS } from "@vibe-tavern/domain";
import type { FormState } from "../components/modals/ProviderModal.js";

/** The form-update callback shape (matches lazyAutoSaveField / autoSaveField). */
export type FormUpdater = <K extends keyof FormState>(k: K, v: FormState[K]) => void;

/**
 * Apply every PRESENT field from a parsed sampler preset to the form.
 *
 * Absent fields (`undefined`) are skipped — the form keeps its current value
 * for those. Null-valued optional fields (e.g. `contextBudget: null`,
 * `seed: null`) ARE applied (they're explicit "unset" signals from the preset).
 *
 * Type narrowing is done field-by-field: `ModelSettingsOverlay` is a Partial of
 * the stored record, and the form mirrors those fields with minor type
 * differences (e.g. FormState.contextBudget is `number`, overlay is
 * `number | null`). Each branch narrows to the form's expected type.
 */
export function applySamplerPresetFields(
  fields: Partial<ModelSettingsOverlay>,
  updateForm: FormUpdater,
): void {
  if (fields.temperature != null) updateForm("temperature", fields.temperature);
  if (fields.topP != null) updateForm("topP", fields.topP);
  if (fields.topK != null) updateForm("topK", fields.topK);
  if (fields.minP != null) updateForm("minP", fields.minP);
  if (fields.topA != null) updateForm("topA", fields.topA);
  if (fields.typicalP != null) updateForm("typicalP", fields.typicalP);
  if (fields.tfsZ != null) updateForm("tfsZ", fields.tfsZ);
  if (fields.adaptiveTarget != null) updateForm("adaptiveTarget", fields.adaptiveTarget);
  if (fields.adaptiveDecay != null) updateForm("adaptiveDecay", fields.adaptiveDecay);
  if (fields.dynatempRange != null) updateForm("dynatempRange", fields.dynatempRange);
  if (fields.dynatempExponent != null) updateForm("dynatempExponent", fields.dynatempExponent);
  if (fields.topNSigma != null) updateForm("topNSigma", fields.topNSigma);
  if (fields.smoothingFactor != null) updateForm("smoothingFactor", fields.smoothingFactor);
  if (fields.repeatLastN != null) updateForm("repeatLastN", fields.repeatLastN);
  if (fields.mirostat != null) updateForm("mirostat", fields.mirostat);
  if (fields.mirostatTau != null) updateForm("mirostatTau", fields.mirostatTau);
  if (fields.mirostatEta != null) updateForm("mirostatEta", fields.mirostatEta);
  if (fields.dryMultiplier != null) updateForm("dryMultiplier", fields.dryMultiplier);
  if (fields.dryBase != null) updateForm("dryBase", fields.dryBase);
  if (fields.dryAllowedLength != null) updateForm("dryAllowedLength", fields.dryAllowedLength);
  if (fields.drySequenceBreakers != null) updateForm("drySequenceBreakers", fields.drySequenceBreakers);
  if (fields.dryPenaltyLastN != null) updateForm("dryPenaltyLastN", fields.dryPenaltyLastN);
  if (fields.xtcThreshold != null) updateForm("xtcThreshold", fields.xtcThreshold);
  if (fields.xtcProbability != null) updateForm("xtcProbability", fields.xtcProbability);
  if (fields.frequencyPenalty != null) updateForm("frequencyPenalty", fields.frequencyPenalty);
  if (fields.presencePenalty != null) updateForm("presencePenalty", fields.presencePenalty);
  if (fields.repetitionPenalty != null) updateForm("repetitionPenalty", fields.repetitionPenalty);
  if (fields.maxTokens != null) updateForm("maxTokens", fields.maxTokens);
  if (fields.contextBudget !== undefined) updateForm("contextBudget", fields.contextBudget ?? 0);
  if (fields.pinContextBudget != null) updateForm("pinContextBudget", fields.pinContextBudget);
  if (fields.stopSequences != null) updateForm("stopSequences", fields.stopSequences);
  if (fields.bannedStrings != null) updateForm("bannedStrings", fields.bannedStrings);
  if (fields.logitBias != null) updateForm("logitBias", fields.logitBias);
  if (fields.seed !== undefined) updateForm("seed", fields.seed);
  if (fields.reasoningEffort != null) updateForm("reasoningEffort", fields.reasoningEffort);
  if (fields.showReasoning != null) updateForm("showReasoning", fields.showReasoning);
  if (fields.streamResponse != null) updateForm("streamResponse", fields.streamResponse);
  if (fields.customSamplers != null) updateForm("customSamplers", fields.customSamplers);
}

// ── Sampler-set engine (LOCAL_SUPPORT_PLAN LS-5e/f) ──────────────────────────
// The clipboard trio (schema + apply + extract) IS the set engine; only the
// copy/paste buttons were replaced by the set row. These two helpers carry the
// set semantics the buttons didn't need:

const SAMPLER_FIELD_SET = new Set<string>(SAMPLER_FIELDS);

/**
 * Filter a set payload by the panel's per-protocol capability set (LS-5f — the
 * PREFERRED apply semantics): unsupported sampler values never enter the form,
 * so they can't ride the profile invisibly. Non-capability overlay keys
 * (contextBudget, maxTokens, seed, stopSequences… are capability-gated too —
 * anything in `SamplerFieldId` is; `contextBudget`/`pinContextBudget`/
 * `maxTokens`/`showReasoning`/`streamResponse`/`customSamplers` are not) pass
 * through unchanged — they render on every protocol.
 */
export function filterOverlayByCapabilities(
  payload: Partial<ModelSettingsOverlay>,
  supports: (field: SamplerFieldId) => boolean,
): Partial<ModelSettingsOverlay> {
  const filtered: Partial<ModelSettingsOverlay> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (SAMPLER_FIELD_SET.has(key) && !supports(key as SamplerFieldId)) continue;
    (filtered as Record<string, unknown>)[key] = value;
  }
  return filtered;
}

/** Structural deep-equality for overlay field values (numbers, strings,
 *  booleans, null, string arrays, logit-bias entry arrays). */
function overlayValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => overlayValueEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    return aKeys.length === bKeys.length && aKeys.every((k) => overlayValueEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * Dirty-dot check (LOCAL_SUPPORT_PLAN LS-5, owner decision): true when the
 * panel's current overlay extract diverges from the APPLIED set payload
 * (field-wise deep compare over the baseline's own keys — fields the set never
 * carried don't count; the baseline is the capability-FILTERED payload, so
 * values the protocol silently dropped never show as divergence). Cleared by
 * the 💾 save and by re-applying/re-selecting the set — never by the profile's
 * own autosave (the set is a separate entity).
 */
export function overlayDivergesFromSet(
  baseline: Partial<ModelSettingsOverlay>,
  current: ModelSettingsOverlay,
): boolean {
  const currentRecord = current as unknown as Record<string, unknown>;
  return Object.entries(baseline).some(
    ([key, value]) => !overlayValueEqual(value, currentRecord[key]),
  );
}
