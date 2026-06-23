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

import type { ModelSettingsOverlay } from "@vibe-tavern/domain";
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
  if (fields.repeatLastN != null) updateForm("repeatLastN", fields.repeatLastN);
  if (fields.mirostat != null) updateForm("mirostat", fields.mirostat);
  if (fields.mirostatTau != null) updateForm("mirostatTau", fields.mirostatTau);
  if (fields.mirostatEta != null) updateForm("mirostatEta", fields.mirostatEta);
  if (fields.dryMultiplier != null) updateForm("dryMultiplier", fields.dryMultiplier);
  if (fields.dryBase != null) updateForm("dryBase", fields.dryBase);
  if (fields.dryAllowedLength != null) updateForm("dryAllowedLength", fields.dryAllowedLength);
  if (fields.drySequenceBreakers != null) updateForm("drySequenceBreakers", fields.drySequenceBreakers);
  if (fields.xtcThreshold != null) updateForm("xtcThreshold", fields.xtcThreshold);
  if (fields.xtcProbability != null) updateForm("xtcProbability", fields.xtcProbability);
  if (fields.frequencyPenalty != null) updateForm("frequencyPenalty", fields.frequencyPenalty);
  if (fields.presencePenalty != null) updateForm("presencePenalty", fields.presencePenalty);
  if (fields.repetitionPenalty != null) updateForm("repetitionPenalty", fields.repetitionPenalty);
  if (fields.maxTokens != null) updateForm("maxTokens", fields.maxTokens);
  if (fields.contextBudget !== undefined) updateForm("contextBudget", fields.contextBudget ?? 0);
  if (fields.pinContextBudget != null) updateForm("pinContextBudget", fields.pinContextBudget);
  if (fields.stopSequences != null) updateForm("stopSequences", fields.stopSequences);
  if (fields.logitBias != null) updateForm("logitBias", fields.logitBias);
  if (fields.seed !== undefined) updateForm("seed", fields.seed);
  if (fields.reasoningEffort != null) updateForm("reasoningEffort", fields.reasoningEffort);
  if (fields.showReasoning != null) updateForm("showReasoning", fields.showReasoning);
  if (fields.streamResponse != null) updateForm("streamResponse", fields.streamResponse);
  if (fields.customSamplers != null) updateForm("customSamplers", fields.customSamplers);
}
