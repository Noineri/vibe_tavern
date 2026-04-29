import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
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

export class KoboldCppAdapter implements ProviderAdapter {
  type = PROVIDER_TYPE.koboldCpp;

  async listModels(_profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    return [];
  }

  async generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: { model: string; prompt: AssemblePromptResponse },
  ): Promise<string> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("KoboldCPP endpoint is required.");

    const promptText = messagesToPrompt(input.prompt);

    const body: Record<string, unknown> = {
      prompt: promptText,
      max_context_length: profile.context_budget ?? 4096,
      max_length: 512,
    };

    const response = await fetch(`${baseUrl}/api/v1/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `KoboldCPP request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const data = (await response.json()) as { results?: Array<{ text?: string }> };
    const text = data.results?.[0]?.text;
    if (!text) throw new Error("KoboldCPP returned empty response.");
    return text;
  }
}
