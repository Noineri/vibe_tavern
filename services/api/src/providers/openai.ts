import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderAdapter, ProviderProfile, ConnectionResult, ModelInfo } from "./types.js";
import {
  generateProviderReply,
  listProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
} from "../prototype-provider-gateway.js";

export class OpenAICompatAdapter implements ProviderAdapter {
  type = "openai_compat" as const;

  async testConnection(profile: Omit<ProviderProfile, 'type'>): Promise<ConnectionResult> {
    const normalizedEndpoint = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");
    if (!normalizedEndpoint) {
      return {
        success: false,
        models: [],
        error: "Provider endpoint is required.",
      };
    }

    const parsed = tryParseUrl(normalizedEndpoint);
    if (!parsed) {
      return {
        success: false,
        models: [],
        error: "Provider endpoint is invalid.",
      };
    }

    if (!/^https?:$/.test(parsed.protocol)) {
      return {
        success: false,
        models: [],
        error: "Provider endpoint must use http or https.",
      };
    }

    const normalizedModels: ModelInfo[] = profile.default_model
      ? [{ id: profile.default_model, name: profile.default_model }]
      : [];

    return {
      success: true,
      models: normalizedModels,
    };
  }

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

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
