import type { AssemblePromptResponse } from "@rp-platform/domain";
import { ProviderAdapter, ProviderProfile, ModelInfo } from "./types.js";
import { PROVIDER_TYPE } from "@rp-platform/domain";

const TIMEOUT_MS = 45_000;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

function extractMessages(prompt: AssemblePromptResponse): Array<{ role: string; content: string }> {
  const payload = prompt.finalPayload as { messages?: unknown };
  const records = Array.isArray(payload.messages) ? payload.messages : [];

  return records
    .map((record) => {
      if (!record || typeof record !== "object") return null;
      const role = typeof record.role === "string" ? record.role : null;
      const content = typeof record.content === "string" ? record.content : null;
      if (!role || !content) return null;
      return { role, content };
    })
    .filter((r): r is { role: string; content: string } => r !== null);
}

function convertAnthropicMessages(
  rawMessages: Array<{ role: string; content: string }>,
): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const nonSystem: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of rawMessages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user" || msg.role === "assistant") {
      nonSystem.push({ role: msg.role, content: msg.content });
    } else {
      nonSystem.push({ role: "user" as const, content: msg.content });
    }
  }

  if (nonSystem.length === 0) {
    nonSystem.push({ role: "user", content: "Let's get started." });
  }

  if (nonSystem[0].role !== "user") {
    nonSystem.unshift({ role: "user", content: "Let's get started." });
  }

  const mapped: AnthropicMessage[] = nonSystem.map((msg) => ({
    role: msg.role,
    content: [{ type: "text" as const, text: msg.content }],
  }));

  const merged: AnthropicMessage[] = [];
  for (const msg of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content.push(...msg.content);
    } else {
      merged.push(msg);
    }
  }

  return { system: systemParts.join("\n\n"), messages: merged };
}

export class AnthropicAdapter implements ProviderAdapter {
  type = PROVIDER_TYPE.anthropic;

  async listModels(profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) return [];

    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          "x-api-key": profile.api_key ?? "",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? [])
        .map((m) => ({ id: m.id ?? "", name: m.id ?? "" }))
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
    if (!baseUrl) throw new Error("Anthropic endpoint is required.");

    const model = input.model.trim() || profile.default_model?.trim() || "";
    if (!model) throw new Error("Anthropic model is required.");

    const rawMessages = extractMessages(input.prompt);
    const { system, messages } = convertAnthropicMessages(rawMessages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: profile.context_budget ?? 4096,
    };

    if (system) {
      body.system = system;
    }

    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": profile.api_key ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned empty content.");
    return text;
  }
}
