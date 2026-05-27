import { brandId, type ChatId } from "@vibe-tavern/domain";
import type { SessionRuntime, SessionSnapshot } from "./session-runtime.js";
import type { ProviderProfileService } from "./provider-profile-service.js";
import { nonstreamingProviderExecute } from "./ai/nonstreaming-provider-executor.js";
import { notFound, validation } from "./errors.js";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import { logSendDebug } from "./send-debug-log.js";

export interface SummarizeChatInput {
  chatId: string;
  providerProfileId: string;
  model?: string;
  maxMessages: number;
  signal?: AbortSignal;
}

export interface SummarizeChatResult {
  summary: string;
  snapshot: SessionSnapshot;
}

export class ChatSummaryService {
  constructor(
    private readonly sessionRuntime: SessionRuntime,
    private readonly providerProfiles: ProviderProfileService,
  ) {}

  async summarizeChat(input: SummarizeChatInput): Promise<SummarizeChatResult> {
    const providerProfileId = input.providerProfileId.trim();
    if (!providerProfileId) {
      throw validation("Provider profile is required for summarization.");
    }

    const maxMessages = normalizeMaxMessages(input.maxMessages);
    const profile = await this.providerProfiles.getProviderProfile(providerProfileId);
    if (!profile) {
      throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
    }
    if (!profile.apiKey?.trim()) {
      throw validation("Selected provider has no saved API key.");
    }
    const model = input.model?.trim() || profile.defaultModel?.trim();
    if (!model) {
      throw validation("Select a model for summarization.");
    }

    const chatId = brandId<ChatId>(input.chatId);
    logSendDebug("summary.generate.start", { chatId: input.chatId, providerProfileId, model, maxMessages });
    const assembled = await this.sessionRuntime.chatLifecycle.assembleSummaryPrompt({
      chatId,
      model,
      recentMessageLimit: maxMessages,
      contextBudget: profile.contextBudget ?? null,
    });

    const prompt = withSummaryPromptAsFinalUserMessage(assembled.prompt);
    const messages = Array.isArray(prompt.finalPayload?.messages) ? prompt.finalPayload.messages : [];
    logSendDebug("summary.generate.prompt", {
      chatId: input.chatId,
      messageCount: messages.length,
      lastRole: (messages[messages.length - 1] as { role?: unknown } | undefined)?.role ?? null,
      layerIds: prompt.layers.map((layer) => layer.id),
    });

    const startedAt = Date.now();
    const result = await nonstreamingProviderExecute({
      profile,
      model,
      prompt,
      signal: input.signal,
      overrideMaxTokens: 16384,
    });
    const summary = result.text.trim();
    if (!summary) {
      throw validation("Provider returned an empty summary.");
    }

    const snapshot = await this.sessionRuntime.chatLifecycle.updateChatSummary(chatId, summary);
    logSendDebug("summary.generate.done", {
      chatId: input.chatId,
      providerProfileId,
      model,
      maxMessages,
      latencyMs: Date.now() - startedAt,
      summaryLength: summary.length,
    });

    return { summary, snapshot };
  }

  async saveChatSummary(input: { chatId: string; summary: string }): Promise<SummarizeChatResult> {
    const chatId = brandId<ChatId>(input.chatId);
    const summary = input.summary.trim();
    const snapshot = await this.sessionRuntime.chatLifecycle.updateChatSummary(chatId, summary);
    return { summary, snapshot };
  }
}

function normalizeMaxMessages(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.floor(value));
}

function withSummaryPromptAsFinalUserMessage(prompt: AssemblePromptResponse): AssemblePromptResponse {
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const summaryLayer = prompt.layers.find((layer) => layer.id === "prompt_preset_summary");
  if (!summaryLayer?.text.trim()) {
    return prompt;
  }

  return {
    ...prompt,
    finalPayload: {
      ...(prompt.finalPayload ?? {}),
      messages: [
        ...messages.filter((message) => {
          if (!message || typeof message !== "object") return true;
          return (message as { layerId?: unknown }).layerId !== "prompt_preset_summary";
        }),
        {
          role: "user",
          content: summaryLayer.text,
          layerId: "prompt_preset_summary",
        },
      ],
    },
  };
}
