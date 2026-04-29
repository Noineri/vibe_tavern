import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import type { ProviderManager } from "./providers/manager.js";
import type { ProviderType } from "./providers/types.js";
import type { SessionRuntime } from "./session-runtime.js";
import { logSendDebug } from "./send-debug-log.js";

interface StoredProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
  typicalP?: number | null;
  repPen?: number | null;
  freqPen?: number | null;
  presPen?: number | null;
  stopSeq?: string | null;
  seed?: number | string | null;
  reasoningEffort?: string | null;
}

export class ProviderOrchestrator {
  constructor(
    private readonly runtime: SessionRuntime,
    private readonly providerManager: ProviderManager,
  ) {}

  async refreshProfileModels(profile: StoredProviderProfileRecord): Promise<Array<{ id: string; label: string }>> {
    try {
      const models = await this.providerManager.listModels(this.toManagerProfile(profile));
      const normalized = models.map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
      }));

      this.runtime.setCachedProviderModels(profile.id, normalized);
      return normalized;
    } catch (error) {
      const cached = this.runtime.getCachedProviderModels(profile.id);
      if (cached?.models.length) {
        return cached.models;
      }

      const fallbackModel = profile.defaultModel?.trim();
      if (fallbackModel) {
        const fallback = [{ id: fallbackModel, label: fallbackModel }];
        this.runtime.setCachedProviderModels(profile.id, fallback);
        return fallback;
      }

      throw error;
    }
  }

  async generateProfileReply(
    profile: StoredProviderProfileRecord,
    input: {
      model: string;
      prompt: AssemblePromptResponse;
    },
  ): Promise<string> {
    const messages = Array.isArray(input.prompt.finalPayload?.messages) ? input.prompt.finalPayload.messages : [];
    logSendDebug("provider.generate.start", {
      profileId: profile.id,
      providerType: profile.type,
      endpoint: profile.endpoint,
      model: input.model,
      promptMessages: messages.length,
      totalContentLength: messages.reduce((sum: number, m: { content?: string }) => sum + (typeof m.content === "string" ? m.content.length : 0), 0),
    });
    try {
      const reply = await this.providerManager.generateReply(this.toManagerProfile(profile), input);
      logSendDebug("provider.generate.success", { profileId: profile.id, replyLength: reply.length });
      return reply;
    } catch (error) {
      logSendDebug("provider.generate.error", {
        profileId: profile.id,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        cause: error instanceof Error ? serializeErrorCause(error.cause) : null,
      });
      throw error;
    }
  }

  private toManagerProfile(profile: StoredProviderProfileRecord) {
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type as ProviderType,
      endpoint: profile.endpoint,
      api_key: profile.apiKey ?? "",
      default_model: profile.defaultModel ?? null,
      context_budget: profile.contextBudget ?? 8192,
      maxTokens: profile.maxTokens ?? null,
      temperature: profile.temperature ?? null,
      topP: profile.topP ?? null,
      minP: profile.minP ?? null,
      topK: profile.topK ?? null,
      typicalP: profile.typicalP ?? null,
      repPen: profile.repPen ?? null,
      freqPen: profile.freqPen ?? null,
      presPen: profile.presPen ?? null,
      stopSeq: profile.stopSeq ?? null,
      seed: profile.seed ?? null,
      reasoningEffort: profile.reasoningEffort ?? null,
    };
  }
}

function serializeErrorCause(cause: unknown): unknown {
  if (!cause) return null;
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      ...Object.fromEntries(
        Object.entries(cause as unknown as Record<string, unknown>).filter(([key]) => key !== "stack"),
      ),
    };
  }
  if (typeof cause === "object") {
    return cause;
  }
  return String(cause);
}
