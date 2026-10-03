import type { ModelSettingsOverlay } from "@vibe-tavern/domain";

/** Generation values and provider identity required by ProviderSamplerPanel. */
export type ProviderSamplerValues = Required<Omit<ModelSettingsOverlay, "contextBudget">> & {
  contextBudget: number;
  /** Profile-only generation budget margin, hidden on the Co-Author path. */
  tokenPadding: number;
  model: string;
  providerPreset: string;
};

export type ProviderSamplerOnChange = {
  onChange<K extends keyof ProviderSamplerValues>(
    key: K,
    value: ProviderSamplerValues[K],
  ): void;
}["onChange"];
