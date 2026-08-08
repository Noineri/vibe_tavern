import { brandId, type ChatId, type EventBus } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ConfigPatchResponse, SummaryResponse } from "../../api/contract/session-types.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import { notFound, validation } from "../../shared/errors.js";
import { BackgroundTaskLocks } from "../../shared/background-task-locks.js";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import {
	providerRequiresApiKey,
	resolveEffectiveSummaryProfile,
} from "./summary-generation-seam.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

export interface SummarizeChatInput {
  chatId: string;
  providerProfileId: string;
  model?: string;
  maxMessages: number;
  signal?: AbortSignal;
}

export interface GenerateChatSummaryInput {
  chatId: string;
  providerProfileId: string;
  model?: string;
  summarizedFrom: number;
  summarizedTo: number;
  targetSummaryId?: string;
  label?: string;
  includeInContext?: boolean;
  excludeSummarized?: boolean;
  source?: 'manual' | 'auto';
  // SUMMARY_PRIOR_CONTEXT_PLAN (SPC-3): prior-context controls threaded through
  // to assembleRangedSummaryPrompt. Auto fills both from autoSummaryConfig;
  // manual ranged omits maxPriorSummaries → lifecycle defaults to 10.
  includePriorSummaries?: boolean;
  maxPriorSummaries?: number;
  signal?: AbortSignal;
}

export interface SummarizeChatResult {
  summary: string;
  snapshot: ConfigPatchResponse;
}

export interface GenerateChatSummaryResult {
  summary: string;
  chatSummary: Awaited<ReturnType<StoreContainer['chatSummaries']['getById']>>;
  snapshot: SummaryResponse;
}

export class ChatSummaryService {
  private readonly autoSummaryLocks = new BackgroundTaskLocks();

  constructor(
    private readonly stores: StoreContainer,
    private readonly sessionRuntime: SessionRuntime,
    private readonly providerProfiles: ProviderProfileService,
    /** Typed bus for background notifications (W7). Optional so non-runtime callers (tests) need not supply one. */
    private readonly events: EventBus | null = null,
    private readonly execute: typeof nonstreamingProviderExecute = nonstreamingProviderExecute,
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
    if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
      throw validation("Selected provider has no saved API key.");
    }
    const model = input.model?.trim() || profile.defaultModel?.trim();
    if (!model) {
      throw validation("Select a model for summarization.");
    }
    const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.providerProfiles);

    const chatId = brandId<ChatId>(input.chatId);
    logSendDebug("summary.generate.start", { chatId: input.chatId, providerProfileId, model, maxMessages });
    const assembled = await this.sessionRuntime.chatLifecycle.assembleSummaryPrompt({
      chatId,
      model,
      recentMessageLimit: maxMessages,
      contextBudget: effectiveProfile.contextBudget ?? null,
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
    const result = await this.execute({
      profile: effectiveProfile,
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

  async generateChatSummary(input: GenerateChatSummaryInput): Promise<GenerateChatSummaryResult> {
    const providerProfileId = input.providerProfileId.trim();
    if (!providerProfileId) {
      throw validation("Provider profile is required for summarization.");
    }
    const profile = await this.providerProfiles.getProviderProfile(providerProfileId);
    if (!profile) {
      throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
    }
    if (providerRequiresApiKey(profile.providerPreset) && !profile.apiKey?.trim()) {
      throw validation("Selected provider has no saved API key.");
    }
    const model = input.model?.trim() || profile.defaultModel?.trim();
    if (!model) {
      throw validation("Select a model for summarization.");
    }
    const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, this.providerProfiles);

    const chatId = brandId<ChatId>(input.chatId);
    const from = normalizeRangePoint(input.summarizedFrom, 1);
    const to = normalizeRangePoint(input.summarizedTo, from);
    logSendDebug("summary.range.generate.start", { chatId: input.chatId, providerProfileId, model, from, to });

    const assembled = await this.sessionRuntime.chatLifecycle.assembleRangedSummaryPrompt({
      chatId,
      model,
      summarizedFrom: from,
      summarizedTo: to,
      contextBudget: effectiveProfile.contextBudget ?? null,
      includePriorSummaries: input.includePriorSummaries,
      maxPriorSummaries: input.maxPriorSummaries,
    });
    const prompt = withSummaryPromptAsFinalUserMessage(assembled.prompt);
    const startedAt = Date.now();
    const result = await this.execute({
      profile: effectiveProfile,
      model,
      prompt,
      signal: input.signal,
      overrideMaxTokens: 16384,
    });
    const summary = result.text.trim();
    if (!summary) {
      throw validation("Provider returned an empty summary.");
    }

    const label = input.label?.trim() || `T${from}–T${to}`;
    const existing = input.targetSummaryId
      ? await this.stores.chatSummaries.getById(input.targetSummaryId)
      : null;
    const chatSummary = existing
      ? await this.stores.chatSummaries.update(existing.id, {
          label,
          content: summary,
          summarizedFrom: from,
          summarizedTo: to,
          includeInContext: input.includeInContext ?? existing.includeInContext,
          excludeSummarized: input.excludeSummarized ?? existing.excludeSummarized,
        })
      : await this.stores.chatSummaries.create({
          chatId: input.chatId,
          branchId: assembled.branchId,
          label,
          content: summary,
          summarizedFrom: from,
          summarizedTo: to,
          includeInContext: input.includeInContext ?? true,
          excludeSummarized: input.excludeSummarized ?? true,
          source: input.source ?? 'manual',
        });
    const snapshot = await this.sessionRuntime.buildSummaryResponse(chatId);
    logSendDebug("summary.range.generate.done", {
      chatId: input.chatId,
      summaryId: chatSummary.id,
      providerProfileId,
      model,
      from,
      to,
      latencyMs: Date.now() - startedAt,
      summaryLength: summary.length,
    });
    return { summary, chatSummary, snapshot };
  }

  async triggerAutoSummary(chatIdValue: string): Promise<void> {
    const chat = await this.stores.chats.getById(chatIdValue);
    if (!chat) return;
    const config = normalizeAutoSummaryConfig(chat.autoSummaryConfig);
    if (!config.enabled) return;

    const lockKey = `${chat.id}:${chat.activeBranchId}`;
    await this.autoSummaryLocks.runExclusive(
      lockKey,
      async () => {
        const summaries = await this.stores.chatSummaries.listByChatBranch(chat.id, chat.activeBranchId);
        const lastCovered = summaries.reduce((max, summary) => Math.max(max, summary.summarizedTo), 0);
        const messages = await this.stores.messages.getMessages(chat.activeBranchId);
        const currentLast = Math.max(1, messages.reduce((max, message) => Math.max(max, message.position + 1), 0) - 1);
        if (currentLast - lastCovered < config.everyN) return;

        const profile = config.useChatModel
          ? await this.providerProfiles.resolveActiveProviderProfile()
          : (config.providerProfileId ? await this.providerProfiles.getProviderProfile(config.providerProfileId) : null);
        if (!profile?.id) {
          logSendDebug("summary.auto.skip", { chatId: chat.id, reason: "no_provider" });
          return;
        }
        const model = config.model?.trim() || profile.defaultModel?.trim();
        if (!model) {
          logSendDebug("summary.auto.skip", { chatId: chat.id, reason: "no_model", providerProfileId: profile.id });
          return;
        }

        // W7: emit "started" so the badge can show a spinner for the duration of
        // the generation. Emitted only AFTER the enabled/provider/model/enough-
        // messages checks pass — skip paths above stay silent (nothing to see).
        this.events?.emit("chat.notification", { chatId: chat.id, kind: "summary.started" });
        const label = `T${lastCovered + 1}–T${currentLast}`;
        try {
          const result = await this.generateChatSummary({
            chatId: chat.id,
            providerProfileId: profile.id,
            model,
            summarizedFrom: lastCovered + 1,
            summarizedTo: currentLast,
            label,
            includeInContext: true,
            excludeSummarized: config.excludeSummarized,
            source: 'auto',
            includePriorSummaries: config.includePriorSummaries,
            maxPriorSummaries: config.maxPriorSummaries,
          });
          // W7: notify any open per-chat SSE channel that a background summary landed.
          // `chatSummary` is the just-created record; the null guard is for the type only.
          if (result.chatSummary) {
            this.events?.emit("chat.notification", {
              chatId: chat.id,
              kind: "summary.generated",
              summaryId: result.chatSummary.id,
              label,
            });
          }
        } catch (err) {
          // Surface the failure so the badge stops spinning and the user gets an
          // error toast; re-throw so runExclusive's error handler still logs it
          // (summary.auto.error) as before.
          this.events?.emit("chat.notification", { chatId: chat.id, kind: "summary.failed" });
          throw err;
        }
      },
      (err) => logSendDebug("summary.auto.error", {
        chatId: chat.id,
        branchId: chat.activeBranchId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  async saveChatSummary(input: { chatId: string; summary: string }): Promise<SummarizeChatResult> {
    const chatId = brandId<ChatId>(input.chatId);
    const summary = input.summary.trim();
    const snapshot = await this.sessionRuntime.chatLifecycle.updateChatSummary(chatId, summary);
    return { summary, snapshot };
  }
}

function normalizeRangePoint(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.floor(value));
}

function normalizeAutoSummaryConfig(raw: Record<string, unknown>): {
  enabled: boolean;
  everyN: number;
  useChatModel: boolean;
  excludeSummarized: boolean;
  includePriorSummaries: boolean;
  maxPriorSummaries: number;
  providerProfileId?: string;
  model?: string;
} {
  const everyN = typeof raw.everyN === "number" && Number.isFinite(raw.everyN)
    ? Math.max(1, Math.floor(raw.everyN))
    : 20;
  const maxPriorSummaries = typeof raw.maxPriorSummaries === "number" && Number.isFinite(raw.maxPriorSummaries)
    ? Math.max(0, Math.min(100, Math.floor(raw.maxPriorSummaries)))
    : 10;
  return {
    enabled: raw.enabled === true,
    everyN,
    useChatModel: raw.useChatModel !== false,
    excludeSummarized: raw.excludeSummarized !== false,
    // SUMMARY_PRIOR_CONTEXT_PLAN (SPC-3): default ON + 10 most-recent priors.
    includePriorSummaries: raw.includePriorSummaries !== false,
    maxPriorSummaries,
    providerProfileId: typeof raw.providerProfileId === "string" ? raw.providerProfileId : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

function normalizeMaxMessages(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.floor(value));
}

export function withSummaryPromptAsFinalUserMessage(prompt: AssemblePromptResponse): AssemblePromptResponse {
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
