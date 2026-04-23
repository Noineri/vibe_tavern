import type { AssemblePromptResponse } from "@rp-platform/api-contracts";

export interface ProviderConnectionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
}

type ChatCompletionRole = "system" | "user" | "assistant" | "tool";

interface ChatCompletionMessage {
  role: ChatCompletionRole;
  content: string;
}

interface OpenAiModelRecord {
  id?: string;
  name?: string;
  owned_by?: string;
}

interface OpenAiModelsResponse {
  data?: OpenAiModelRecord[];
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
  }>;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  if (normalized.endsWith("/chat/completions")) {
    return normalized.slice(0, -"/chat/completions".length);
  }

  return normalized;
}

export async function listProviderModels(
  input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const response = await fetch(buildModelsUrl(baseUrl), {
    method: "GET",
    headers: buildHeaders(input.apiKey),
    signal: AbortSignal.timeout(6_000),
  });

  if (!response.ok) {
    throw new Error(`Model list request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as OpenAiModelsResponse;
  const records = Array.isArray(payload.data) ? payload.data : [];

  return records
    .map((record) => {
      const id = (record.id ?? record.name ?? "").trim();
      if (!id) {
        return null;
      }

      return {
        id,
        label: record.owned_by ? `${id} - ${record.owned_by}` : id,
      };
    })
    .filter((record): record is ProviderModelOption => Boolean(record))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function generateProviderReply(
  input: ProviderConnectionInput,
  prompt: AssemblePromptResponse,
): Promise<string> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(input.apiKey),
    body: JSON.stringify({
      model: input.model,
      messages: extractChatCompletionMessages(prompt),
      temperature: 0.9,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Chat completion failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
  }

  const payload = (await response.json()) as OpenAiChatCompletionResponse;
  const choice = payload.choices?.[0];
  const content = extractChoiceContent(choice);

  if (!content) {
    throw new Error("Chat completion returned empty content.");
  }

  return content;
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function buildModelsUrl(baseUrl: string): string {
  if (baseUrl.includes("nano-gpt.com")) {
    return `${baseUrl}/models?detailed=true`;
  }

  return `${baseUrl}/models`;
}

function extractChatCompletionMessages(
  prompt: AssemblePromptResponse,
): ChatCompletionMessage[] {
  const payload = prompt.finalPayload as { messages?: unknown };
  const records = Array.isArray(payload.messages) ? payload.messages : [];

  return records
    .map((record) => {
      if (!record || typeof record !== "object") {
        return null;
      }

      const role = typeof record.role === "string" ? record.role : null;
      const content = typeof record.content === "string" ? record.content : null;

      if (!role || !content || !isChatCompletionRole(role)) {
        return null;
      }

      return {
        role,
        content,
      };
    })
    .filter((record): record is ChatCompletionMessage => Boolean(record));
}

function isChatCompletionRole(role: string): role is ChatCompletionRole {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function extractChoiceContent(
  choice:
    | {
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
        text?: string;
      }
    | undefined,
): string {
  if (!choice) {
    return "";
  }

  if (typeof choice.message?.content === "string") {
    return choice.message.content.trim();
  }

  if (Array.isArray(choice.message?.content)) {
    return choice.message.content
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("")
      .trim();
  }

  return (choice.text ?? "").trim();
}
