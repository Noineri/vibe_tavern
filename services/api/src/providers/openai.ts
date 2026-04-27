import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderAdapter, ProviderProfile, ModelInfo } from "./types.js";
import {
  generateProviderReply,
  listProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
} from "../provider-gateway.js";

export class OpenAICompatAdapter implements ProviderAdapter {
  type = "openai_compat" as const;

  async listModels(profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    const normalizedEndpoint = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");
    if (!normalizedEndpoint) {
      throw new Error("Provider endpoint is required.");
    }

    return (await listProviderModels({
      apiKey: profile.api_key ?? "",
      baseUrl: normalizedEndpoint,
    })).map((model) => ({
      id: model.id,
      name: model.label,
    }));
  }

  async generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: {
      model: string;
      prompt: AssemblePromptResponse;
    },
  ): Promise<string> {
    const normalizedEndpoint = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");
    if (!normalizedEndpoint) {
      throw new Error("Provider endpoint is required.");
    }

    const model = input.model.trim() || profile.default_model?.trim() || "";
    if (!model) {
      throw new Error("Provider model is required.");
    }

    return generateProviderReply(
      {
        apiKey: profile.api_key ?? "",
        baseUrl: normalizedEndpoint,
        model,
      },
      input.prompt,
    );
  }
}
