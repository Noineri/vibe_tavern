/**
 * Local `CreateProviderData` builder for `packages/db/test/*` (FW-6c).
 *
 * Lives inside `packages/db/test/` rather than importing `services/api/test/`
 * helpers to keep the downward dependency graph intact. Supplies valid
 * defaults mirroring the legacy `BASE_CREATE` fixtures without deprecated
 * `null` casts on optional array columns (`drySequenceBreakers`,
 * `stopSequences`, `logitBias`).
 */
import type { CreateProviderData } from "../src/stores/provider-store.js";

export function makeCreateProviderData(
  over: Partial<CreateProviderData> = {},
): CreateProviderData {
  return {
    name: "Test",
    providerPreset: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
    defaultModel: "model-a",
    contextBudget: null,
    temperature: 1,
    topP: 1,
    minP: 0,
    topK: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 2000,
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    ...over,
  };
}
