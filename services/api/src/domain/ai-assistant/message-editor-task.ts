/**
 * The shared message-editor task (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-14).
 *
 * `prepareMessageEditorTask` is the editor preparation that used to live
 * privately in `ai-assistant-stream.ts`, exposed as the ONE shared
 * derivation: the ordinary editor stream and the Director's correction
 * delegate (`domain/director/director-message-editor-delegate.ts`) both run
 * through it, so delegated editing is the ordinary editor with a different
 * instruction author — same prompt, same settings, same model resolution.
 * This module is not a second editor: no Director-only prompt, model
 * setting, merge mode or auto-apply exists here.
 *
 * INTERNAL branch scope: the branch is a task PARAMETER. The ordinary editor
 * derives it from the chat's ACTIVE branch (`prepareAiAssistantRequest`
 * resolves it and passes it in); the Director's delegate passes the thread's
 * own chat/branch scope. The public editor request schema keeps no branch
 * field — this is never a client-selectable editor override.
 *
 * `runMessageEditorTask` adds the generation half for delegates: the same
 * `streamText` call settings as the ordinary editor stream, drained into a
 * candidate + provenance ({ modelId, presetName, finishReason } — the fields
 * `AddEditorVariantInput` persists for editor variants and the DMT-11
 * `directorMessageEditProposalSchema` freezes) WITHOUT applying anything:
 * no message edit, no variant append, no persistence.
 *
 * Failure surface (mirrors the ordinary editor's): preparation problems
 * (missing chat/target/source, missing provider profile, non-canonical
 * targets) THROW the same route-grade errors the public editor request
 * path has always thrown; GENERATION problems come back as the `failed`
 * outcome (the ordinary stream turns them into `error` chunks at the same
 * boundary).
 */

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { Message, MessageVariant, AppDb } from "@vibe-tavern/db";
import type { ProviderProxyMode } from "@vibe-tavern/domain";
import {
  getAiAssistantAssembler,
  setModelHint,
  type PromptAssemblyContext,
  type PromptAssemblyResult,
} from "@vibe-tavern/prompt-pipeline";
import type { ProviderFetch } from "../../domain/providers/provider-fetch-factory.js";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";
import type { BuiltPipelineContext } from "../prompt/prompt-assembly-service.js";
import { notFound, validation } from "../../shared/errors.js";
import { getModeConfig } from "./ai-assistant-modes.js";
import { resolveSystemPrompt } from "./ai-assistant-prompts.js";
import {
  composeMessageEditorPrompt,
  type MessageEditorPromptMode,
  type MessageEditorPromptSource,
} from "./message-editor-prompt.js";
import { splitReasoningFromText, type ReasoningSplitState } from "./reasoning-split.js";

// ─── Shared types (moved from ai-assistant-stream.ts) ────────────────────────

export interface MessageEditorProviderProfile {
  readonly id: string;
  readonly providerPreset: string;
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly defaultModel: string | null;
  readonly contextBudget: number | null;
  readonly maxTokens: number;
  /** Proxy policy used to resolve the proxy-aware fetch for this profile. */
  readonly proxyMode: ProviderProxyMode;
  readonly proxyId: string | null;
}

export interface MessageEditorPipelineContextInput {
  readonly chatId: string;
  readonly branchId: string;
  readonly model: string;
  readonly contextBudget: number | null;
  readonly responseReserve: number;
  readonly throughMessageId: string;
  readonly excludeMessageIds: string[];
  /** Optional cap on how many recent messages (before the target) are included.
   *  Mirrors chat_impersonate's recentMessageCount. Undefined = all up to target. */
  readonly recentMessageLimit?: number;
}

export interface PreparedAiAssistantRequest {
  config: ReturnType<typeof getModeConfig>;
  profile: MessageEditorProviderProfile;
  modelName: string;
  assembly: PromptAssemblyResult | null;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  doneMetadata: { modelId: string; promptPresetId: string | null } | null;
  /** Baked prompt preset NAME resolved for the editor's context — editor
   *  provenance for the delegate (DMT-14). The ordinary stream path does not
   *  emit it (its `done` chunk shape is unchanged). */
  promptPresetName?: string | null;
}

// ─── Task input / deps ───────────────────────────────────────────────────────

export interface MessageEditorTaskInput {
  readonly mode: MessageEditorPromptMode;
  readonly chatId: string;
  /**
   * INTERNAL branch scope: the messages, source variants and pre-target
   * context are resolved against THIS branch — the ordinary editor passes
   * the chat's active branch, the Director's delegate passes the thread's
   * pinned branch. Never derived from browser state, never a public request
   * field.
   */
  readonly branchId: string;
  readonly targetMessageId: string;
  readonly sourceVariantIds: readonly string[];
  /** The instruction text — the user's for the ordinary editor, the Director's for the delegate. Everything else about the request is identical. */
  readonly instruction: string;
  readonly providerProfileId: string;
  /** Blank/undefined falls through to the ordinary editor's downstream model resolution (profile default, then the shared hard default) — callers never invent a substitute model. */
  readonly model?: string;
  readonly enabledLayers: readonly string[];
  readonly recentMessageCount?: number;
  readonly promptFormat?: "json" | "xml";
  /** Generation overrides; omitted = the ordinary editor's mode defaults. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/** The editor-task slice of the stream deps — `StreamDeps` satisfies it structurally. */
export interface MessageEditorTaskDeps {
  readonly db: AppDb;
  readonly resolveModel: (profile: { providerPreset: string; endpoint: string; apiKey: string | null }, model: string, fetch?: ProviderFetch) => LanguageModel;
  readonly getProviderProfile: (id: string) => Promise<MessageEditorProviderProfile | null>;
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<MessageEditorProviderProfile>;
  readonly getMessageEditorChat: (chatId: string) => Promise<{ id: string; activeBranchId: string } | null>;
  readonly getMessageEditorMessages: (branchId: string) => Promise<Message[]>;
  readonly getMessageEditorVariantsByBranch: (branchId: string) => Promise<Map<string, MessageVariant[]>>;
  readonly buildMessageEditorPipelineContext: (input: MessageEditorPipelineContextInput) => Promise<BuiltPipelineContext>;
  /** Optional debug logger. */
  readonly logDebug?: (event: string, data: Record<string, unknown>) => void;
}

// ─── Preparation (the moved ordinary-editor preparation) ─────────────────────

export async function prepareMessageEditorTask(
  input: MessageEditorTaskInput,
  deps: MessageEditorTaskDeps,
): Promise<PreparedAiAssistantRequest> {
  const { branchId } = input;
  if (!input.chatId) {
    throw validation("A chat is required for message editor generation.");
  }
  if (!input.targetMessageId) {
    throw validation("A target message is required for message editor generation.");
  }
  if (!input.sourceVariantIds.length) {
    throw validation("Select at least one canonical message variant.");
  }

  const config = getModeConfig(input.mode);
  const profile = await deps.getProviderProfile(input.providerProfileId);
  if (!profile) {
    throw new Error(`Provider profile not found: ${input.providerProfileId}`);
  }
  // The ordinary editor's downstream model resolution, kept verbatim so a
  // blank saved model keeps resolving to the profile default for BOTH callers.
  const modelName = input.model ?? profile.defaultModel ?? "gpt-4o-mini";

  const chat = await deps.getMessageEditorChat(input.chatId);
  if (!chat) {
    throw notFound("Chat", `Chat '${input.chatId}' was not found.`);
  }
  const messages = await deps.getMessageEditorMessages(branchId);
  const target = messages.find((message) => message.id === input.targetMessageId);
  if (!target) {
    throw notFound("Message", `Message '${input.targetMessageId}' was not found on the active branch.`);
  }
  if (target.role !== "assistant" || target.state !== "complete") {
    throw validation("Message editor targets must be committed assistant messages.");
  }

  const variantsByMessage = await deps.getMessageEditorVariantsByBranch(branchId);
  const targetVariants = new Map((variantsByMessage.get(target.id) ?? []).map((variant) => [variant.id, variant]));
  const branchVariantOwners = new Map<string, string>();
  for (const [messageId, variants] of variantsByMessage) {
    for (const variant of variants) branchVariantOwners.set(variant.id, messageId);
  }
  const sources: MessageEditorPromptSource[] = [];
  for (const variantId of input.sourceVariantIds) {
    const source = targetVariants.get(variantId);
    if (!source) {
      const ownerMessageId = branchVariantOwners.get(variantId);
      if (ownerMessageId) {
        throw validation(`Message editor source variant '${variantId}' does not belong to target message '${target.id}'.`);
      }
      throw notFound("MessageVariant", `Message editor source variant '${variantId}' was not found on the active branch.`);
    }
    sources.push(source);
  }

  const { prompt: systemPrompt, source } = await resolveSystemPrompt(deps.db, input.mode, {
    promptFormat: input.promptFormat,
  });
  const effectiveProfile = await deps.getEffectiveProviderProfile(profile.id, modelName);
  const built = await deps.buildMessageEditorPipelineContext({
    chatId: chat.id,
    branchId,
    model: modelName,
    contextBudget: effectiveProfile.contextBudget,
    responseReserve: effectiveProfile.maxTokens,
    throughMessageId: target.id,
    excludeMessageIds: [target.id],
    recentMessageLimit: input.recentMessageCount,
  });
  const task = composeMessageEditorPrompt({
    mode: input.mode,
    targetMessageId: target.id,
    resolvedModePrompt: systemPrompt,
    sources,
    userInstruction: input.instruction,
  });
  const pipelineContext: PromptAssemblyContext = {
    ...built.context,
    aiAssistant: {
      mode: input.mode,
      enabledLayers: [...input.enabledLayers],
      instruction: task,
      systemPrompt: "",
    },
  };

  deps.logDebug?.("api.ai-assistant.prompt-resolved", {
    mode: input.mode,
    source,
    systemPromptLength: systemPrompt.length,
    systemPromptPreview: systemPrompt.slice(0, 120),
    model: modelName,
    providerProfileId: input.providerProfileId,
  });
  setModelHint(modelName);
  const assembly = getAiAssistantAssembler(input.mode).assemble(pipelineContext);
  const messagesForModel = assembly.finalPayload.messages as Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  deps.logDebug?.("api.ai-assistant.assembly-complete", {
    mode: input.mode,
    layerCount: assembly.layers.length,
    totalTokenEstimate: assembly.totalTokenEstimate,
    messageCount: messagesForModel.length,
    droppedLayers: assembly.droppedLayers.length,
  });

  return {
    config,
    profile: effectiveProfile,
    modelName,
    assembly,
    messages: messagesForModel,
    doneMetadata: { modelId: modelName, promptPresetId: built.promptPresetId },
    promptPresetName: built.promptPresetName ?? null,
  };
}

// ─── Generation (the delegate's entry — candidate without apply) ─────────────

/** The editor candidate + provenance — the fields the DMT-11 `directorMessageEditProposalSchema` freezes as `editor`. */
export interface MessageEditorTaskCandidate {
  readonly candidate: string;
  readonly modelId: string;
  readonly presetName: string | null;
  readonly finishReason: string | undefined;
}

export type MessageEditorTaskOutcome =
  | { readonly status: "completed"; readonly result: MessageEditorTaskCandidate }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Prepare the editor request (same path as the ordinary editor) and run the
 * same `streamText` generation with the ordinary editor's settings, draining
 * the stream into the final candidate. Never writes: the candidate is
 * returned to the caller (DMT-21 assembles the proposal; DMT-22 applies it).
 */
export async function runMessageEditorTask(
  input: MessageEditorTaskInput,
  deps: MessageEditorTaskDeps,
  signal?: AbortSignal,
): Promise<MessageEditorTaskOutcome> {
  const prepared = await prepareMessageEditorTask(input, deps);
  const aiModel = deps.resolveModel(prepared.profile, prepared.modelName, await resolveProviderFetchForProfile(prepared.profile));

  // The ordinary editor stream's exact generation settings (non-md branch:
  // temperature default 0.3, output uncapped unless overridden).
  const result = streamText({
    model: aiModel,
    messages: prepared.messages,
    allowSystemInMessages: true,
    temperature: input.temperature ?? 0.3,
    maxOutputTokens: input.maxOutputTokens ?? undefined,
    abortSignal: signal,
  });

  // The ordinary editor's candidate is the streamed TEXT only — inline
  // reasoning is split off exactly as the modal's accumulated output is
  // (editor modes stream with the shared reasoning splitter, no stripping).
  const splitState: ReasoningSplitState = {
    buffer: "",
    insideThinkTag: false,
  };
  let text = "";
  try {
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "abort") {
        if (signal?.aborted) return { status: "cancelled" };
        throw new Error(part.reason ?? "Message editor task aborted");
      }
      if (part.type !== "text-delta") continue;
      for (const parsed of splitReasoningFromText(splitState, part.text)) {
        if (parsed.type === "text" && parsed.text) {
          text += parsed.text;
        }
      }
    }
    for (const parsed of splitReasoningFromText(splitState, "", { flush: true })) {
      if (parsed.type === "text" && parsed.text) {
        text += parsed.text;
      }
    }
  } catch (err) {
    // Same quiet-exit rule as the ordinary stream: after a caller abort there
    // is nobody left to receive an error.
    if (signal?.aborted) return { status: "cancelled" };
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (signal?.aborted) return { status: "cancelled" };

  // A delegate with empty output is a failure, never a proposal (the DMT-11
  // contract's `candidate` is min(1)).
  const candidate = text.trim();
  if (!candidate) {
    return { status: "failed", reason: "The message editor returned no candidate text." };
  }
  return {
    status: "completed",
    result: {
      candidate,
      modelId: prepared.modelName,
      presetName: prepared.promptPresetName ?? null,
      finishReason: await result.finishReason,
    },
  };
}
