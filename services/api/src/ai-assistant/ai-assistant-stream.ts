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

import { streamText, streamObject } from "ai";
import type { LanguageModel } from "ai";
import {
  assemblePrompt,
  estimateMessageArrayTokens,
  setModelHint,
  type AiAssistantMode,
  type PromptAssemblyContext,
  type PromptAssemblyResult,
} from "@vibe-tavern/prompt-pipeline";
import type { ResolvedContext, ContextResolverDeps } from "./context-resolver.js";
import { resolveContext, toPipelineCharacters, toPipelinePersonas, toPipelineLore } from "./context-resolver.js";
import { getModeConfig } from "./ai-assistant-modes.js";
import { mdImportSchema, type MdImportResult } from "./md-import-schema.js";
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

  // Chat impersonate mode extras
  /** Active chat ID (for chat_impersonate to resolve chat history). */
  chatId?: string;
  /** How many recent messages to include (chat_impersonate). Default: 20. */
  recentMessageCount?: number;

  // Lore keys mode extras
  /** Existing primary keys on the entry (for de-duplication). */
  existingKeys?: string[];
  /** Existing secondary keys on the entry. */
  existingSecondaryKeys?: string[];
  /** Entry's activation logic mode. */
  logic?: string;

  // MD import extras
  /** Max output tokens for structured generation (md_import). Default: 10000. */
  maxOutputTokens?: number;
  /** Override temperature for this request. Per-mode defaults used if omitted. */
  temperature?: number;
}

export interface StreamDeps extends ContextResolverDeps {
  resolveModel: (profile: { providerPreset: string; endpoint: string; apiKey: string | null }, model: string) => LanguageModel;
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
  /** Resolve chat messages for chat_impersonate mode. */
  getChatMessages: (chatId: string, count: number) => Promise<Array<{ id: string; role: string; content: string }>>;
  /** Optional debug logger. */
  logDebug?: (event: string, data: Record<string, unknown>) => void;
}

// ─── Assembly / token preview ────────────────────────────────────────────────

interface PreparedAiAssistantRequest {
  config: ReturnType<typeof getModeConfig>;
  profile: NonNullable<Awaited<ReturnType<StreamDeps["getProviderProfile"]>>>;
  modelName: string;
  assembly: PromptAssemblyResult | null;
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
    };
  }

  // 3. Resolve context bindings
  const resolvedContext: ResolvedContext = await resolveContext(deps, {
    characterIds: request.characterIds,
    personaIds: request.personaIds,
    loreEntryIds: request.loreEntryIds,
    lorebookIds: request.lorebookIds,
  });

  // 4. Resolve chat history for chat_impersonate
  let recentMessages: Array<{ id: string; role: string; content: string }> = [];
  if (request.mode === "chat_impersonate" && request.chatId) {
    const count = request.recentMessageCount ?? 20;
    recentMessages = await deps.getChatMessages(request.chatId, count);
  }

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
    mode: "ai_assistant",
    aiAssistant: {
      mode: request.mode,
      enabledLayers: request.enabledLayers,
      existingContent: request.existingContent,
      instruction: userMessage,
      systemPrompt,
    },
    chat: { recentMessages: recentMessages.map((m) => ({ id: m.id, role: m.role as "system" | "user" | "assistant" | "tool", content: m.content })) },
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
  if (prepared.assembly) {
    return {
      tokens: prepared.assembly.totalTokenEstimate,
      model: prepared.modelName,
      layerCount: prepared.assembly.layers.length,
      messageCount: prepared.messages.length,
    };
  }

  // md_import bypasses prompt assembly, but still uses the shared tokenizer.
  setModelHint(prepared.modelName);
  return {
    tokens: estimateMessageArrayTokens(prepared.messages),
    model: prepared.modelName,
    layerCount: prepared.messages.length,
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

    // md_import: try streamObject, fallback to streamText + JSON parse
    if (request.mode === "md_import") {
      deps.logDebug?.("api.ai-assistant.md-import.start", {
        model: modelName,
        messagesCount: messages.length,
        contentLength: request.existingContent?.length ?? 0,
      });

      // Emit early text so the client knows the connection is alive
      yield { type: "reasoning", text: "Parsing character data...\n" };

      const temp = request.temperature ?? 0;
      const maxTokens = request.maxOutputTokens ?? 10000;

      // Try streamObject (structured output), fallback to streamText + manual parse
      let usedStreamObject = false;
      let streamObjectHadUsefulJson = false;
      try {
        const result = await streamObject({
          model: aiModel,
          schema: mdImportSchema,
          messages,
          allowSystemInMessages: true,
          temperature: temp,
          maxOutputTokens: maxTokens,
        });

        usedStreamObject = true;
        let eventCount = 0;
        for await (const event of result.fullStream) {
          eventCount++;
          if (event.type === "text-delta") {
            yield { type: "reasoning", text: event.textDelta };
          } else if (event.type === "object") {
            const obj = event.object as Record<string, unknown>;
            if (hasUsefulMdImportJson(obj)) {
              streamObjectHadUsefulJson = true;
              yield { type: "partial_json", json: obj };
            }
          } else if (event.type === "error") {
            deps.logDebug?.("api.ai-assistant.md-import.stream-object-error", { error: String(event.error), eventCount });
            yield { type: "error", error: String(event.error) };
          }
        }

        deps.logDebug?.("api.ai-assistant.md-import.stream-object-done", { eventCount, streamObjectHadUsefulJson });
      } catch {
        // streamObject not supported by this provider — fallback to streamText
        deps.logDebug?.("api.ai-assistant.md-import.fallback-to-streamText", { model: modelName });
      }

      if (!usedStreamObject || !streamObjectHadUsefulJson) {
        // Fallback: streamText + manual JSON parse
        try {
          const result = await streamText({
            model: aiModel,
            messages,
            allowSystemInMessages: true,
            temperature: temp,
            maxOutputTokens: maxTokens,
          });

          let fullText = "";
          for await (const chunk of result.textStream) {
            fullText += chunk;
            yield { type: "reasoning", text: chunk };
          }

          // Try to extract JSON from the response
          const parsed = extractJsonFromText(fullText);
          if (parsed && hasUsefulMdImportJson(parsed)) {
            yield { type: "partial_json", json: parsed as Record<string, unknown> };
          } else {
            deps.logDebug?.("api.ai-assistant.md-import.json-parse-failed", {
              responseLength: fullText.length,
              responsePreview: fullText.slice(0, 200),
            });
            yield { type: "error", error: "Failed to parse JSON from model response" };
          }
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          deps.logDebug?.("api.ai-assistant.md-import.fallback-error", { error: msg });
          yield { type: "error", error: msg };
        }
      }

      yield { type: "done" };
      return;
    }

    // 6. Stream via AI SDK
    const result = await streamText({
      model: aiModel,
      messages,
      allowSystemInMessages: true,
      temperature: request.temperature ?? 0.3,
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

function hasUsefulMdImportJson(obj: Record<string, unknown>): boolean {
  const usefulStringFields = ["name", "tagline", "description", "personality", "scenario", "firstMessage", "creatorNotes"];
  if (usefulStringFields.some((key) => typeof obj[key] === "string" && obj[key].trim().length > 0)) return true;
  if (Array.isArray(obj.exampleMessages) && obj.exampleMessages.length > 0) return true;
  if (Array.isArray(obj.additionalCharacters) && obj.additionalCharacters.length > 0) return true;
  return false;
}

/**
 * Extract a JSON object from raw model text.
 * Handles markdown fences, leading/trailing prose, and nested braces.
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try to find JSON inside markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const parsed = tryParseJson(fenceMatch[1]);
    if (parsed) return parsed;
  }

  // Find the outermost { ... } block
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return tryParseJson(text.slice(firstBrace, i + 1));
      }
    }
  }

  // Last resort: try to parse the whole text
  return tryParseJson(text);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* not valid JSON */ }
  return null;
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
      if (request.existingContent) {
        return `Here is my current lorebook entry content:\n\n${request.existingContent}\n\nModification request:\n${request.instruction}\n\nReturn the complete updated lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
      }
      return `${request.instruction}\n\nReturn the lorebook entry content only. Do not include a title, keys, JSON, markdown, or explanation.`;
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

    case "md_import": {
      const content = request.existingContent ?? request.instruction;
      return `Parse this character description into structured data:\n\n${content}`;
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
