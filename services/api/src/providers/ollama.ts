import type { AssemblePromptResponse } from "@rp-platform/domain";
import { ProviderAdapter, ProviderProfile, ModelInfo } from "./types.js";
import { PROVIDER_TYPE } from "@rp-platform/domain";

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

export class OllamaAdapter implements ProviderAdapter {
  type = PROVIDER_TYPE.ollama;

  async listModels(profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) return [];

    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) return [];

      const data = (await response.json()) as {
        models?: Array<{ name?: string }>;
      };

      return (data.models ?? [])
        .map((m) => ({ id: m.name ?? "", name: m.name ?? "" }))
        .filter((m) => m.id.length > 0);
    } catch {
      return [];
    }
  }

  async generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: { model: string; prompt: AssemblePromptResponse },
  ): Promise<string> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Ollama endpoint is required.");

    const model = input.model.trim() || profile.default_model?.trim() || "";
    if (!model) throw new Error("Ollama model is required.");

    const promptText = messagesToPrompt(input.prompt);

    const body: Record<string, unknown> = {
      model,
      prompt: promptText,
      stream: false,
      options: {
        num_ctx: profile.context_budget ?? 4096,
      },
    };

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const data = (await response.json()) as { response?: string };
    if (!data.response) throw new Error("Ollama returned empty response.");
    return data.response;
  }
}
