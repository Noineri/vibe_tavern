import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderAdapter, ProviderProfile, ModelInfo } from "./types.js";

const TIMEOUT_MS = 45_000;

function extractMessages(prompt: AssemblePromptResponse): Array<{ role: string; content: string }> {
  const payload = prompt.finalPayload as { messages?: unknown };
  const records = Array.isArray(payload.messages) ? payload.messages : [];

  return records
    .map((record) => {
      if (!record || typeof record !== "object") return null;
      const content = typeof record.content === "string" ? record.content : null;
      if (!content) return null;
      return { role: typeof record.role === "string" ? record.role : "user", content };
    })
    .filter((r): r is { role: string; content: string } => r !== null);
}

function messagesToPrompt(prompt: AssemblePromptResponse): string {
  return extractMessages(prompt).map((m) => m.content).join("\n\n");
}

export class LlamaCppAdapter implements ProviderAdapter {
  type = "llamacpp" as const;

  async listModels(profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) return [];

    try {
      const response = await fetch(`${baseUrl}/props`, {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) return [];

      const data = (await response.json()) as {
        default_generation_settings?: { model?: string };
      };

      const modelName = data.default_generation_settings?.model;
      if (!modelName) return [];

      return [{ id: modelName, name: modelName }];
    } catch {
      return [];
    }
  }

  async generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: { model: string; prompt: AssemblePromptResponse },
  ): Promise<string> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("llama.cpp endpoint is required.");

    const promptText = messagesToPrompt(input.prompt);

    const body: Record<string, unknown> = {
      prompt: promptText,
      n_predict: profile.context_budget ?? 2048,
      stream: false,
    };

    const response = await fetch(`${baseUrl}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `llama.cpp request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const data = (await response.json()) as { content?: string };
    if (!data.content) throw new Error("llama.cpp returned empty content.");
    return data.content;
  }
}
