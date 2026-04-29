import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import { ProviderAdapter, ProviderProfile, ModelInfo } from "./types.js";
import { PROVIDER_TYPE } from "@rp-platform/domain";

const TIMEOUT_MS = 45_000;

const STATIC_MODELS: ModelInfo[] = [
  { id: "gemini-1.5-pro-latest", name: "gemini-1.5-pro-latest" },
  { id: "gemini-1.5-flash-latest", name: "gemini-1.5-flash-latest" },
  { id: "gemini-1.0-pro", name: "gemini-1.0-pro" },
];

interface GoogleContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GoogleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
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

function convertGoogleMessages(
  rawMessages: Array<{ role: string; content: string }>,
): { systemInstruction: { parts: Array<{ text: string }> } | null; contents: GoogleContent[] } {
  const systemParts: string[] = [];
  const nonSystem: Array<{ role: "user" | "model"; content: string }> = [];

  for (const msg of rawMessages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "assistant") {
      nonSystem.push({ role: "model", content: msg.content });
    } else {
      nonSystem.push({ role: "user", content: msg.content });
    }
  }

  if (nonSystem.length === 0) {
    nonSystem.push({ role: "user", content: "Let's get started." });
  }

  const mapped: GoogleContent[] = nonSystem.map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.content }],
  }));

  const merged: GoogleContent[] = [];
  for (const msg of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const existingText = last.parts.find((p) => typeof p.text === "string");
      const incomingText = msg.parts.find((p) => typeof p.text === "string");
      if (existingText && incomingText) {
        existingText.text += "\n\n" + incomingText.text;
      } else {
        last.parts.push(...msg.parts);
      }
    } else {
      merged.push(msg);
    }
  }

  const systemInstruction =
    systemParts.length > 0
      ? { parts: systemParts.map((text) => ({ text })) }
      : null;

  return { systemInstruction, contents: merged };
}

export class GoogleAdapter implements ProviderAdapter {
  type = PROVIDER_TYPE.google;

  async listModels(_profile: Omit<ProviderProfile, "type">): Promise<ModelInfo[]> {
    return STATIC_MODELS;
  }

  async generateReply(
    profile: Omit<ProviderProfile, "type">,
    input: { model: string; prompt: AssemblePromptResponse },
  ): Promise<string> {
    const baseUrl = (profile.endpoint ?? "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Google endpoint is required.");

    const model = input.model.trim() || profile.default_model?.trim() || "";
    if (!model) throw new Error("Google model is required.");

    const rawMessages = extractMessages(input.prompt);
    const { systemInstruction, contents } = convertGoogleMessages(rawMessages);

    const apiKey = profile.api_key ?? "";
    const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: profile.context_budget ?? 4096,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Google request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
      );
    }

    const data = (await response.json()) as GoogleResponse;
    const text = data.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
    if (!text) throw new Error("Google returned empty content.");
    return text;
  }
}
