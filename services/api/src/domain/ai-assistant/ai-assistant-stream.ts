/**
 * AI assistant streaming — the core runtime.
 *
 * Takes a request, resolves the system prompt via fallback chain, builds
 * the pipeline context, calls `assemblePrompt()` for full pipeline processing,
 * then streams via Vercel AI SDK `streamText()`.
 *
 * For `lore_keys` mode: reasoning is buffered and stripped; only the final
 * parsed JSON result is emitted to the client.
 */

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderFetch } from "../../domain/providers/provider-fetch-factory.js";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";
import type { Message, MessageVariant } from "@vibe-tavern/db";
import {
  getAiAssistantAssembler,
  estimateMessageArrayTokens,
  setModelHint,
  type AiAssistantMode,
  type PromptAssemblyContext,
  type PromptAssemblyResult,
} from "@vibe-tavern/prompt-pipeline";
import type { ResolvedContext, ContextResolverDeps } from "./context-resolver.js";
import { resolveContext, toPipelineCharacters, toPipelinePersonas, toPipelineLore } from "./context-resolver.js";
import { getModeConfig } from "./ai-assistant-modes.js";
import {
  resolveSystemPrompt,
} from "./ai-assistant-prompts.js";
import {
  splitReasoningFromText,
  type ReasoningSplitState,
  type AiAssistantStreamChunk,
} from "./reasoning-split.js";
import { extractMdImportObjectFromText, hasUsefulMdImportJson, mergeMdImportWithSourceSections } from "./md-import-parse.js";
import type { AppDb } from "@vibe-tavern/db";
import type { AiAssistantRequest, AiAssistantTokenCount } from "@vibe-tavern/api-contracts";
import type { BuiltPipelineContext } from "../prompt/prompt-assembly-service.js";
import { notFound, validation } from "../../shared/errors.js";
import {
  composeMessageEditorPrompt,
  type MessageEditorPromptMode,
  type MessageEditorPromptSource,
} from "./message-editor-prompt.js";

// ─── Request / response types ────────────────────────────────────────────────

/** Request body, validated at the route by `aiAssistantRequestSchema`. */
export type AiAssistantStreamRequest = AiAssistantRequest;

interface AiAssistantProviderProfile {
  readonly id: string;
  readonly providerPreset: string;
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly defaultModel: string | null;
  readonly contextBudget: number | null;
  readonly maxTokens: number;
  /** Proxy policy used to resolve the proxy-aware fetch for this profile. */
  readonly proxyMode: import("@vibe-tavern/domain").ProviderProxyMode;
  readonly proxyId: string | null;
}

interface MessageEditorPipelineContextInput {
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

interface ChatImpersonationPipelineContextInput {
  readonly chatId: string;
  readonly model: string;
  readonly contextBudget: number | null;
  readonly responseReserve: number;
  readonly recentMessageLimit: number;
  /** Current composer draft, scanned as the one-shot quiet prompt. */
  readonly quietPrompt?: string;
}

export interface StreamDeps extends ContextResolverDeps {
  readonly db: AppDb;
  readonly resolveModel: (profile: { providerPreset: string; endpoint: string; apiKey: string | null }, model: string, fetch?: ProviderFetch) => LanguageModel;
  readonly getProviderProfile: (id: string) => Promise<AiAssistantProviderProfile | null>;
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<AiAssistantProviderProfile>;
  // SP-10: legacy preset plumbing — prompt resolution now uses service-prompt
  // profiles (db). Kept for compat until SP-10 cleanup.
  readonly getPresetPromptData: (chatId?: string) => Promise<{
    aiAssistantPrompts: Record<string, string> | null;
    scriptAiSystemPrompt: string | null;
  }>;
  /** Build the full RP world for impersonation without persisting lore timed state. */
  readonly buildChatImpersonationPipelineContext: (input: ChatImpersonationPipelineContextInput) => Promise<BuiltPipelineContext>;
  readonly getMessageEditorChat: (chatId: string) => Promise<{ id: string; activeBranchId: string } | null>;
  readonly getMessageEditorMessages: (branchId: string) => Promise<Message[]>;
  readonly getMessageEditorVariantsByBranch: (branchId: string) => Promise<Map<string, MessageVariant[]>>;
  readonly buildMessageEditorPipelineContext: (input: MessageEditorPipelineContextInput) => Promise<BuiltPipelineContext>;
  /** Optional debug logger. */
  readonly logDebug?: (event: string, data: Record<string, unknown>) => void;
}

// ─── Assembly / token preview ────────────────────────────────────────────────

interface PreparedAiAssistantRequest {
  config: ReturnType<typeof getModeConfig>;
  profile: AiAssistantProviderProfile;
  modelName: string;
  assembly: PromptAssemblyResult | null;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  doneMetadata: { modelId: string; promptPresetId: string | null } | null;
}

interface MessageEditorPreparationInput {
  readonly request: AiAssistantStreamRequest & { readonly mode: MessageEditorPromptMode };
  readonly deps: StreamDeps;
  readonly config: ReturnType<typeof getModeConfig>;
  readonly profile: AiAssistantProviderProfile;
  readonly modelName: string;
}

async function prepareMessageEditorRequest(input: MessageEditorPreparationInput): Promise<PreparedAiAssistantRequest> {
  const { request, deps, config, profile, modelName } = input;
  if (!request.chatId) {
    throw validation("A chat is required for message editor generation.");
  }
  if (!request.targetMessageId) {
    throw validation("A target message is required for message editor generation.");
  }
  if (!request.sourceVariantIds?.length) {
    throw validation("Select at least one canonical message variant.");
  }

  const chat = await deps.getMessageEditorChat(request.chatId);
  if (!chat) {
    throw notFound("Chat", `Chat '${request.chatId}' was not found.`);
  }
  const messages = await deps.getMessageEditorMessages(chat.activeBranchId);
  const target = messages.find((message) => message.id === request.targetMessageId);
  if (!target) {
    throw notFound("Message", `Message '${request.targetMessageId}' was not found on the active branch.`);
  }
  if (target.role !== "assistant" || target.state !== "complete") {
    throw validation("Message editor targets must be committed assistant messages.");
  }

  const variantsByMessage = await deps.getMessageEditorVariantsByBranch(chat.activeBranchId);
  const targetVariants = new Map((variantsByMessage.get(target.id) ?? []).map((variant) => [variant.id, variant]));
  const branchVariantOwners = new Map<string, string>();
  for (const [messageId, variants] of variantsByMessage) {
    for (const variant of variants) branchVariantOwners.set(variant.id, messageId);
  }
  const sources: MessageEditorPromptSource[] = [];
  for (const variantId of request.sourceVariantIds) {
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

  const { prompt: systemPrompt, source } = await resolveSystemPrompt(deps.db, request.mode, {
    promptFormat: request.promptFormat,
  });
  const effectiveProfile = await deps.getEffectiveProviderProfile(profile.id, modelName);
  const built = await deps.buildMessageEditorPipelineContext({
    chatId: chat.id,
    branchId: chat.activeBranchId,
    model: modelName,
    contextBudget: effectiveProfile.contextBudget,
    responseReserve: effectiveProfile.maxTokens,
    throughMessageId: target.id,
    excludeMessageIds: [target.id],
    recentMessageLimit: request.recentMessageCount,
  });
  const task = composeMessageEditorPrompt({
    mode: request.mode,
    targetMessageId: target.id,
    resolvedModePrompt: systemPrompt,
    sources,
    userInstruction: request.instruction,
  });
  const pipelineContext: PromptAssemblyContext = {
    ...built.context,
    aiAssistant: {
      mode: request.mode,
      enabledLayers: request.enabledLayers,
      instruction: task,
      systemPrompt: "",
    },
  };

  deps.logDebug?.("api.ai-assistant.prompt-resolved", {
    mode: request.mode,
    source,
    systemPromptLength: systemPrompt.length,
    systemPromptPreview: systemPrompt.slice(0, 120),
    model: modelName,
    providerProfileId: request.providerProfileId,
  });
  setModelHint(modelName);
  const assembly = getAiAssistantAssembler(request.mode).assemble(pipelineContext);
  const messagesForModel = assembly.finalPayload.messages as Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  deps.logDebug?.("api.ai-assistant.assembly-complete", {
    mode: request.mode,
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
  };
}

function isMessageEditorRequest(
  request: AiAssistantStreamRequest,
): request is AiAssistantStreamRequest & { readonly mode: MessageEditorPromptMode } {
  return request.mode === "message_edit" || request.mode === "message_merge";
}

async function prepareAiAssistantRequest(
  request: AiAssistantStreamRequest,
  deps: StreamDeps,
): Promise<PreparedAiAssistantRequest> {
  const config = getModeConfig(request.mode);

  // 1. Resolve provider + model
  const profile = await deps.getProviderProfile(request.providerProfileId);
  if (!profile) {
    throw new Error(`Provider profile not found: ${request.providerProfileId}`);
  }
  const modelName = request.model ?? profile.defaultModel ?? "gpt-4o-mini";

  if (isMessageEditorRequest(request)) {
    return prepareMessageEditorRequest({ request, deps, config, profile, modelName });
  }

  // 2. Resolve system prompt via service-prompt profiles
  const promptField = request.mode === "chat_impersonate"
    ? getChatImpersonatePromptKey(request)
    : undefined;
  const { prompt: systemPrompt, source } = await resolveSystemPrompt(deps.db, request.mode, {
    promptFormat: request.promptFormat,
    field: promptField,
  });

  deps.logDebug?.("api.ai-assistant.prompt-resolved", {
    mode: request.mode,
    source,
    systemPromptLength: systemPrompt.length,
    systemPromptPreview: systemPrompt.slice(0, 120),
    model: modelName,
    providerProfileId: request.providerProfileId,
  });

  // 2b. md_import: skip context resolution, build simple messages
  if (request.mode === "md_import") {
    const userContent = request.existingContent ?? request.instruction ?? "";
    return {
      config,
      profile,
      modelName,
      assembly: null,
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userContent },
      ],
      doneMetadata: null,
    };
  }

  // 3. chat_impersonate reuses the full RP world assembly so the draft is
  // quiet-prompt scanned and activated lore reaches the persona writer.
  if (request.mode === "chat_impersonate") {
    if (!request.chatId) throw validation("A chat is required for impersonation.");
    const effectiveProfile = await deps.getEffectiveProviderProfile(profile.id, modelName);
    const built = await deps.buildChatImpersonationPipelineContext({
      chatId: request.chatId,
      model: modelName,
      contextBudget: effectiveProfile.contextBudget,
      responseReserve: effectiveProfile.maxTokens,
      recentMessageLimit: request.recentMessageCount ?? 20,
      ...(request.draftText?.trim() ? { quietPrompt: request.draftText } : {}),
    });
    const pipelineContext: PromptAssemblyContext = {
      ...built.context,
      aiAssistant: {
        mode: request.mode,
        // Activated lore is part of the full RP world for impersonation; the
        // explicit character/persona settings retain their existing control.
        enabledLayers: [...new Set([...request.enabledLayers, "lore"])],
        existingContent: request.existingContent,
        instruction: buildUserMessage(request, config),
        systemPrompt,
      },
    };
    setModelHint(modelName);
    const assembly = getAiAssistantAssembler(request.mode).assemble(pipelineContext);
    const messages = assembly.finalPayload.messages as Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    return { config, profile: effectiveProfile, modelName, assembly, messages, doneMetadata: null };
  }

  // 4. Resolve context bindings for non-chat assistant modes.
  const resolvedContext: ResolvedContext = await resolveContext(deps, {
    characterIds: request.characterIds,
    personaIds: request.personaIds,
    loreEntryIds: request.loreEntryIds,
    lorebookIds: request.lorebookIds,
  });

  // 5. Build user message (mode-specific)
  const userMessage = buildUserMessage(request, config);

  // 6. Assemble via pipeline using the selected model tokenizer
  const pipelineContext: PromptAssemblyContext = {
    identity: { chatId: request.chatId ?? "ai-assistant" },
    character: toPipelineCharacters(resolvedContext)[0] ?? {
      id: "",
      name: "",
      description: "",
    },
    persona: toPipelinePersonas(resolvedContext)[0] ?? null,
    lore: toPipelineLore(resolvedContext),
    aiAssistant: {
      mode: request.mode,
      enabledLayers: request.enabledLayers,
      existingContent: request.existingContent,
      instruction: userMessage,
      systemPrompt,
    },
    chat: { recentMessages: [] },
  };

  setModelHint(modelName);
  const assembly = getAiAssistantAssembler(request.mode).assemble(pipelineContext);
  const messages = assembly.finalPayload.messages as Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;

  deps.logDebug?.("api.ai-assistant.assembly-complete", {
    mode: request.mode,
    layerCount: assembly.layers.length,
    totalTokenEstimate: assembly.totalTokenEstimate,
    messageCount: messages.length,
    droppedLayers: assembly.droppedLayers.length,
  });

  return { config, profile, modelName, assembly, messages, doneMetadata: null };
}

export async function countAiAssistantTokens(
  request: AiAssistantStreamRequest,
  deps: StreamDeps,
): Promise<AiAssistantTokenCount> {
  const prepared = await prepareAiAssistantRequest(request, deps);
  if (prepared.assembly) {
    return {
      tokens: prepared.assembly.totalTokenEstimate,
      model: prepared.modelName,
      layerCount: prepared.assembly.layers.length,
      messageCount: prepared.messages.length,
      // activatedLoreEntries is the chat-pipeline activation result for message
      // modes (buildLayers) and the resolved context set for default modes.
      activatedLoreCount: prepared.assembly.activatedLoreEntries.length,
    };
  }

  // md_import bypasses prompt assembly, but still uses the shared tokenizer.
  setModelHint(prepared.modelName);
  return {
    tokens: estimateMessageArrayTokens(prepared.messages),
    model: prepared.modelName,
    layerCount: prepared.messages.length,
    messageCount: prepared.messages.length,
    activatedLoreCount: 0,
  };
}

// ─── Main streaming function ─────────────────────────────────────────────────

export async function* streamAiAssistant(
  request: AiAssistantStreamRequest,
  deps: StreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<AiAssistantStreamChunk> {
  try {
    const prepared = await prepareAiAssistantRequest(request, deps);
    const { config, profile, modelName, messages } = prepared;
    const aiModel = deps.resolveModel(profile, modelName, await resolveProviderFetchForProfile(profile));

    // md_import intentionally uses plain streamText instead of streamObject.
    // Some providers/models (notably Gemini Flash Lite and OpenAI-compatible
    // aggregators) can loop or emit malformed never-closed JSON when forced into
    // structured streaming. This mirrors lore_keys: collect text, then parse.
    if (request.mode === "md_import") {
      deps.logDebug?.("api.ai-assistant.md-import.start", {
        model: modelName,
        messagesCount: messages.length,
        contentLength: request.existingContent?.length ?? 0,
      });

      try {
        const result = streamText({
          model: aiModel,
          messages,
          allowSystemInMessages: true,
          temperature: request.temperature ?? 0,
          maxOutputTokens: request.maxOutputTokens ?? 6000,
          abortSignal: signal,
        });

        const mdReasoningState: ReasoningSplitState = {
          buffer: "",
          insideThinkTag: false,
        };

        let fullText = "";
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error;
          if (part.type === "abort") {
            if (signal?.aborted) return;
            throw new Error(part.reason ?? "AI assistant stream aborted");
          }
          if (part.type === "reasoning-delta") {
            yield { type: "reasoning", text: part.text };
            continue;
          }
          if (part.type !== "text-delta") continue;
          for (const parsedChunk of splitReasoningFromText(mdReasoningState, part.text)) {
            if (parsedChunk.type === "reasoning" && parsedChunk.text) {
              yield { type: "reasoning", text: parsedChunk.text };
            }
            if (parsedChunk.type === "text" && parsedChunk.text) {
              fullText += parsedChunk.text;
              // Raw model output for debugging. The md_import UI shows this separately
              // from parsed fields, so users can see provider/model failures directly.
              yield { type: "text", text: parsedChunk.text };
            }
          }
        }
        for (const parsedChunk of splitReasoningFromText(mdReasoningState, "", { flush: true })) {
          if (parsedChunk.type === "reasoning" && parsedChunk.text) {
            yield { type: "reasoning", text: parsedChunk.text };
          }
          if (parsedChunk.type === "text" && parsedChunk.text) {
            fullText += parsedChunk.text;
            yield { type: "text", text: parsedChunk.text };
          }
        }

        // fullStream emits abort parts explicitly; don't parse partial JSON for a disconnected client.
        if (signal?.aborted) return;

        const parsed = mergeMdImportWithSourceSections(
          extractMdImportObjectFromText(fullText),
          request.existingContent ?? "",
        );
        if (parsed && hasUsefulMdImportJson(parsed)) {
          yield { type: "partial_json", json: parsed };
        } else {
          deps.logDebug?.("api.ai-assistant.md-import.parse-failed", {
            responseLength: fullText.length,
            responsePreview: fullText.slice(0, 300),
          });
          yield { type: "error", error: "Model returned output, but no importable fields could be parsed. See raw output above." };
        }
      } catch (err) {
        // The consumer is gone (client hit Stop / closed the modal) — an error
        // event on a dead stream is noise; stop quietly, as the chat SSE routes do.
        if (signal?.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        deps.logDebug?.("api.ai-assistant.md-import.error", { error: msg });
        yield { type: "error", error: msg };
      }

      yield { type: "done" };
      return;
    }

    // 6. Stream via AI SDK
    const result = streamText({
      model: aiModel,
      messages,
      allowSystemInMessages: true,
      temperature: request.temperature ?? 0.3,
      maxOutputTokens: request.maxOutputTokens ?? undefined,
      abortSignal: signal,
    });

    const splitState: ReasoningSplitState = {
      buffer: "",
      insideThinkTag: false,
    };

    // For lore_keys: buffer everything, strip reasoning, parse JSON at end
    if (config.stripReasoning) {
      let fullText = "";
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") {
          if (signal?.aborted) return;
          throw new Error(part.reason ?? "AI assistant stream aborted");
        }
        if (part.type !== "text-delta") continue;
        for (const parsed of splitReasoningFromText(splitState, part.text)) {
          // Process through the inline reasoning splitter but only accumulate answer text.
          if (parsed.type === "text" && parsed.text) {
            fullText += parsed.text;
          }
        }
      }
      // Flush
      for (const parsed of splitReasoningFromText(splitState, "", { flush: true })) {
        if (parsed.type === "text" && parsed.text) {
          fullText += parsed.text;
        }
      }

      // Emit the cleaned text result — the reasoning-stripped accumulated
      // output is yielded once, as a single final text event.
      if (fullText.trim()) {
        yield { type: "text", text: fullText };
      }
    } else {
      // Normal streaming with reasoning split
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") {
          if (signal?.aborted) return;
          throw new Error(part.reason ?? "AI assistant stream aborted");
        }
        if (part.type === "reasoning-delta") {
          yield { type: "reasoning", text: part.text };
          continue;
        }
        if (part.type !== "text-delta") continue;
        for (const parsed of splitReasoningFromText(splitState, part.text)) {
          yield parsed;
        }
      }
      for (const parsed of splitReasoningFromText(splitState, "", { flush: true })) {
        yield parsed;
      }
    }
    if (prepared.doneMetadata) {
      if (signal?.aborted) return;
      yield {
        type: "done",
        ...prepared.doneMetadata,
        finishReason: await result.finishReason,
      };
    } else {
      if (signal?.aborted) return;
      yield { type: "done" };
    }
  } catch (err) {
    // Same quiet-exit rule as the md_import branch above: after a caller abort
    // there is nobody left to receive an error event.
    if (signal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}


// ─── User message builder ────────────────────────────────────────────────────

export function getChatImpersonatePromptKey(request: AiAssistantStreamRequest): "chat_impersonate" | "chat_impersonate_enhance" {
  return request.mode === "chat_impersonate" && request.enhanceDraft === true && Boolean(request.draftText?.trim())
    ? "chat_impersonate_enhance"
    : "chat_impersonate";
}

export function buildUserMessage(
  request: AiAssistantStreamRequest,
  config: ReturnType<typeof getModeConfig>,
): string {
  switch (request.mode) {
    case "lore_entry": {
      if (request.existingContent) {
        return `Here is my current lorebook entry content:\n\n${request.existingContent}\n\nModification request:\n${request.instruction}\n\nReturn the complete updated lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
      }
      return `${request.instruction}\n\nReturn the lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
    }

    case "lore_keys": {
      const parts: string[] = [];
      parts.push(`Generate activation keys for this lorebook entry:\n\n${request.existingContent ?? ""}`);

      // Per-request target directive — constrains the model to one key set so
      // the output does not contradict the user's dropdown choice. The model is
      // still asked to return the full {keys, secondaryKeys} shape (the unused
      // array as []) so existing response parsing stays valid.
      const target = request.keyTarget ?? "both";
      if (target === "primary") {
        parts.push("\nTarget: generate ONLY primary keys. Return secondaryKeys as an empty array.");
      } else if (target === "secondary") {
        parts.push("\nTarget: generate ONLY secondary keys. Return keys as an empty array.");
      }

      if (request.existingKeys?.length) {
        parts.push(`\nExisting primary keys (do NOT duplicate): ${JSON.stringify(request.existingKeys)}`);
      }
      if (request.existingSecondaryKeys?.length) {
        parts.push(`Existing secondary keys (do NOT duplicate): ${JSON.stringify(request.existingSecondaryKeys)}`);
      }
      if (request.logic) {
        parts.push(`\nLogic mode: ${request.logic}`);
        parts.push(getLogicHint(request.logic));
      }
      if (request.instruction?.trim()) {
        parts.push(`\nAdditional instruction: ${request.instruction}`);
      }
      return parts.join("\n");
    }

    case "chat_impersonate": {
      const instruction = request.instruction || "Write a message as this persona would speak in the current conversation.";
      const draft = request.draftText?.trim();
      return draft
        ? `${instruction}\n\nBuild on this draft as the persona would write it:\n\n${draft}`
        : instruction;
    }

    case "md_import": {
      const content = request.existingContent ?? request.instruction;
      return `Parse this character description into structured data:\n\n${content}`;
    }

    case "scene_schema": {
      const parts: string[] = [request.instruction?.trim() || "Design a Scene Tracker schema."];
      if (request.existingContent?.trim()) {
        parts.push(`\nCurrent schema (refine it, keeping what still fits):\n${request.existingContent.trim()}`);
      }
      return parts.join("\n");
    }

    case "scene_rules": {
      const parts: string[] = [request.instruction?.trim() || "Extract scene tracker rules from this character's prompt."];
      if (request.existingContent?.trim()) {
        parts.push(`\nCurrent scene tracker rules (refine them, keeping what still fits):\n${request.existingContent.trim()}`);
      }
      return parts.join("\n");
    }

    default:
      return request.instruction;
  }
}

function getLogicHint(logic: string): string {
  // Normalize to lowercase — matches the canonical LoreLogic values and the
  // editor's (post-fix) SegmentedControl. Also tolerates legacy uppercase.
  switch (logic.toLowerCase()) {
    case "and_any":
      return "(secondary keys provide additional activation signal — generate related terms)";
    case "and_all":
      return "(ALL secondary keys must match — keep the set small and tightly related)";
    case "not_any":
      return "(secondary keys PREVENT activation when matched — generate terms indicating the conversation moved away from this topic)";
    case "not_all":
      return "(secondary keys prevent activation when ALL match — generate unrelated-topic indicators)";
    default:
      return "";
  }
}
