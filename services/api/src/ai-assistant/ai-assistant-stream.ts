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
import type { LanguageModelV1 } from "ai";
import {
  assemblePrompt,
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

// ─── Request / response types ────────────────────────────────────────────────

export interface AiAssistantStreamRequest {
  /** Which assistant mode to use. */
  mode: AiAssistantMode;
  /** User's instruction / prompt text. */
  instruction: string;
  /** Current field content being edited/refined. */
  existingContent?: string;
  /** Provider profile ID to use. */
  providerProfileId: string;
  /** Model name override (optional, uses profile default). */
  model?: string;

  // Context bindings (full mode)
  /** Context layers the user toggled on. */
  enabledLayers: string[];
  /** Characters to attach as context. */
  characterIds?: string[];
  /** Personas to attach as context. */
  personaIds?: string[];
  /** Lore entries to attach as context. */
  loreEntryIds?: string[];
  /** Whole lorebooks to attach as context; backend expands enabled entries. */
  lorebookIds?: string[];

  // Lore keys mode extras
  /** Existing primary keys on the entry (for de-duplication). */
  existingKeys?: string[];
  /** Existing secondary keys on the entry. */
  existingSecondaryKeys?: string[];
  /** Entry's activation logic mode. */
  logic?: string;
}

export interface StreamDeps extends ContextResolverDeps {
  resolveModel: (profile: { providerPreset: string; endpoint: string; apiKey: string | null }, model: string) => LanguageModelV1;
  getProviderProfile: (id: string) => Promise<{
    id: string;
    providerPreset: string;
    endpoint: string;
    apiKey: string | null;
    defaultModel: string | null;
  } | null>;
  /** Resolve the active preset's aiAssistantPrompts + legacy column. */
  getPresetPromptData: () => Promise<{
    aiAssistantPrompts: Record<string, string> | null;
    scriptAiSystemPrompt: string | null;
  }>;
  /** Optional debug logger. */
  logDebug?: (event: string, data: Record<string, unknown>) => void;
}

// ─── Assembly / token preview ────────────────────────────────────────────────

interface PreparedAiAssistantRequest {
  config: ReturnType<typeof getModeConfig>;
  profile: NonNullable<Awaited<ReturnType<StreamDeps["getProviderProfile"]>>>;
  modelName: string;
  assembly: PromptAssemblyResult;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
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

  // 2. Resolve system prompt via fallback chain
  const presetData = await deps.getPresetPromptData();
  const { prompt: systemPrompt, source } = await resolveSystemPrompt(request.mode, {
    aiAssistantPrompts: presetData.aiAssistantPrompts,
    scriptAiSystemPrompt: presetData.scriptAiSystemPrompt,
  });

  deps.logDebug?.("api.ai-assistant.prompt-resolved", {
    mode: request.mode,
    source,
    systemPromptLength: systemPrompt.length,
    systemPromptPreview: systemPrompt.slice(0, 120),
    model: modelName,
    providerProfileId: request.providerProfileId,
  });

  // 3. Resolve context bindings
  const resolvedContext: ResolvedContext = await resolveContext(deps, {
    characterIds: request.characterIds,
    personaIds: request.personaIds,
    loreEntryIds: request.loreEntryIds,
    lorebookIds: request.lorebookIds,
  });

  // 4. Build user message (mode-specific)
  const userMessage = buildUserMessage(request, config);

  // 5. Assemble via pipeline using the selected model tokenizer
  const pipelineContext: PromptAssemblyContext = {
    identity: { chatId: "ai-assistant" },
    character: toPipelineCharacters(resolvedContext)[0] ?? {
      id: "",
      name: "",
      description: "",
    },
    persona: toPipelinePersonas(resolvedContext)[0] ?? null,
    lore: toPipelineLore(resolvedContext),
    mode: "ai_assistant",
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
  const assembly = assemblePrompt(pipelineContext);
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

  return { config, profile, modelName, assembly, messages };
}

export async function countAiAssistantTokens(
  request: AiAssistantStreamRequest,
  deps: StreamDeps,
): Promise<{ tokens: number; model: string; layerCount: number; messageCount: number }> {
  const prepared = await prepareAiAssistantRequest(request, deps);
  return {
    tokens: prepared.assembly.totalTokenEstimate,
    model: prepared.modelName,
    layerCount: prepared.assembly.layers.length,
    messageCount: prepared.messages.length,
  };
}

// ─── Main streaming function ─────────────────────────────────────────────────

export async function* streamAiAssistant(
  request: AiAssistantStreamRequest,
  deps: StreamDeps,
): AsyncGenerator<AiAssistantStreamChunk> {
  try {
    const { config, profile, modelName, messages } = await prepareAiAssistantRequest(request, deps);
    const aiModel = deps.resolveModel(profile, modelName);

    // 6. Stream via AI SDK
    const result = await streamText({
      model: aiModel,
      messages,
      temperature: 0.3,
    });

    const splitState: ReasoningSplitState = {
      buffer: "",
      insideMarkerReasoning: false,
      insideThinkTag: false,
    };

    // For lore_keys: buffer everything, strip reasoning, parse JSON at end
    if (config.stripReasoning) {
      let fullText = "";
      for await (const chunk of result.textStream) {
        // Process through reasoning splitter but only accumulate text chunks
        for (const parsed of splitReasoningFromText(splitState, chunk)) {
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

      // Emit the cleaned text result
      if (fullText.trim()) {
        yield { type: "text", text: fullText };
      }
      yield { type: "done" };
    } else {
      // Normal streaming with reasoning split
      for await (const chunk of result.textStream) {
        for (const parsed of splitReasoningFromText(splitState, chunk)) {
          yield parsed;
        }
      }
      for (const parsed of splitReasoningFromText(splitState, "", { flush: true })) {
        yield parsed;
      }
      yield { type: "done" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}

// ─── User message builder ────────────────────────────────────────────────────

function buildUserMessage(
  request: AiAssistantStreamRequest,
  config: ReturnType<typeof getModeConfig>,
): string {
  switch (request.mode) {
    case "script": {
      if (request.existingContent) {
        return `Here is my current script:\n\n${request.existingContent}\n\nModification request:\n${request.instruction}\n\nReturn the complete updated JavaScript script only. Do not return a patch, diff, markdown, or explanation. Preserve unrelated code exactly where possible.`;
      }
      return request.instruction;
    }

    case "lore_entry": {
      let msg = request.instruction;
      if (request.existingContent) {
        msg = `Here is my current lorebook entry:\n\n${request.existingContent}\n\nModification request:\n${request.instruction}`;
      }
      return msg;
    }

    case "lore_keys": {
      const parts: string[] = [];
      parts.push(`Generate activation keys for this lorebook entry:\n\n${request.existingContent ?? ""}`);

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
      return request.instruction || "Write a message as this persona would speak in the current conversation.";
    }

    default:
      return request.instruction;
  }
}

function getLogicHint(logic: string): string {
  switch (logic) {
    case "AND_ANY":
      return "(secondary keys provide additional activation signal — generate related terms)";
    case "AND_ALL":
      return "(ALL secondary keys must match — keep the set small and tightly related)";
    case "NOT_ANY":
      return "(secondary keys PREVENT activation when matched — generate terms indicating the conversation moved away from this topic)";
    case "NOT_ALL":
      return "(secondary keys prevent activation when ALL match — generate unrelated-topic indicators)";
    default:
      return "";
  }
}
