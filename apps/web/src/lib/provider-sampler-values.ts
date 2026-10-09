import { PROVIDER_PROFILE_GENERATION_DEFAULTS, type ModelSettingsOverlay } from "@vibe-tavern/domain";

/** Generation values and provider identity required by ProviderSamplerPanel. */
export type ProviderSamplerValues = Required<Omit<ModelSettingsOverlay, "contextBudget">> & {
  contextBudget: number;
  /** Profile-only generation budget margin, hidden on the Co-Author path. */
  tokenPadding: number;
  model: string;
  providerPreset: string;
};

/** The six NovelAI sampler fields as provider-form seed values
 *  (NOVELAI_PROVIDER_PLAN NAI-1a convoy): ProviderModal / SetupWizard form
 *  state starts from these until NAI-1b/1c make the wire record carry the
 *  fields. Derived from the domain defaults constant — no second value
 *  source — and spread (not inlined) so the oversized form files do not
 *  grow past the arch-gate ratchet. */
export const NOVELAI_SAMPLER_FORM_DEFAULTS: Pick<
  ProviderSamplerValues,
  "unifiedLinear" | "unifiedQuad" | "unifiedConf" | "repetitionPenaltySlope" | "phraseRepPen" | "thinkingMode"
> = {
  unifiedLinear: PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedLinear,
  unifiedQuad: PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedQuad,
  unifiedConf: PROVIDER_PROFILE_GENERATION_DEFAULTS.unifiedConf,
  repetitionPenaltySlope: PROVIDER_PROFILE_GENERATION_DEFAULTS.repetitionPenaltySlope,
  phraseRepPen: PROVIDER_PROFILE_GENERATION_DEFAULTS.phraseRepPen,
  thinkingMode: PROVIDER_PROFILE_GENERATION_DEFAULTS.thinkingMode,
};

export type ProviderSamplerOnChange = {
  onChange<K extends keyof ProviderSamplerValues>(
    key: K,
    value: ProviderSamplerValues[K],
  ): void;
}["onChange"];
