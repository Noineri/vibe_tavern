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
import type { BuiltPipelineContext } from "../prompt/prompt-assembly-service.js";
import { notFound, validation } from "../../shared/errors.js";
import {
  composeMessageEditorPrompt,
  type MessageEditorPromptMode,
  type MessageEditorPromptSource,
} from "./message-editor-prompt.js";

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

  // Message editor mode extras
  /** Canonical target message in the chat's active branch. */
  targetMessageId?: string;
  /** Immutable canonical variants selected as editor sources. */
  sourceVariantIds?: string[];

  // Lore keys mode extras
  /** Existing primary keys on the entry (for de-duplication). */
  existingKeys?: string[];
  /** Existing secondary keys on the entry. */
  existingSecondaryKeys?: string[];
  /** Entry's activation logic mode. */
  logic?: string;
  /** Which key set to generate. Default `"both"`. */
  keyTarget?: "primary" | "secondary" | "both";

  // MD import extras
  /** Max output tokens for structured generation (md_import). Default: 10000. */
  maxOutputTokens?: number;
  /** Override temperature for this request. Per-mode defaults used if omitted. */
  temperature?: number;

  // Scene schema extras
  /** Selected Scene prompt format — selects the scene_schema default prompt file
   *  (json/xml) so the generated schema obeys XML-safe key rules when needed. */
  promptFormat?: "json" | "xml";
}

interface AiAssistantProviderProfile {
  readonly id: string;
  readonly providerPreset: string;
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly defaultModel: string | null;
  readonly contextBudget: number | null;
  readonly maxTokens: number;
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

export interface StreamDeps extends ContextResolverDeps {
  readonly resolveModel: (profile: { providerPreset: string; endpoint: string; apiKey: string | null }, model: string) => LanguageModel;
  readonly getProviderProfile: (id: string) => Promise<AiAssistantProviderProfile | null>;
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<AiAssistantProviderProfile>;
  /** Resolve the active preset's aiAssistantPrompts + legacy column. */
  readonly getPresetPromptData: (chatId?: string) => Promise<{
    aiAssistantPrompts: Record<string, string> | null;
    scriptAiSystemPrompt: string | null;
  }>;
  /** Resolve chat messages for chat_impersonate mode. */
  readonly getChatMessages: (chatId: string, count: number) => Promise<Array<{ id: string; role: string; content: string }>>;
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

  const presetData = await deps.getPresetPromptData(chat.id);
  const { prompt: systemPrompt, source } = await resolveSystemPrompt(request.mode, {
    aiAssistantPrompts: presetData.aiAssistantPrompts,
    scriptAiSystemPrompt: presetData.scriptAiSystemPrompt,
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

  // 2. Resolve system prompt via fallback chain
  const presetData = await deps.getPresetPromptData();
  const { prompt: systemPrompt, source } = await resolveSystemPrompt(request.mode, {
    aiAssistantPrompts: presetData.aiAssistantPrompts,
    scriptAiSystemPrompt: presetData.scriptAiSystemPrompt,
    promptFormat: request.promptFormat,
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
): Promise<{ tokens: number; model: string; layerCount: number; messageCount: number; activatedLoreCount: number }> {
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
): AsyncGenerator<AiAssistantStreamChunk> {
  try {
    const prepared = await prepareAiAssistantRequest(request, deps);
    const { config, profile, modelName, messages } = prepared;
    const aiModel = deps.resolveModel(profile, modelName);

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
        const result = await streamText({
          model: aiModel,
          messages,
          allowSystemInMessages: true,
          temperature: request.temperature ?? 0,
          maxOutputTokens: request.maxOutputTokens ?? 6000,
        });

        const mdReasoningState: ReasoningSplitState = {
          buffer: "",
          insideMarkerReasoning: false,
          insideThinkTag: false,
        };

        let fullText = "";
        for await (const chunk of result.textStream) {
          for (const parsedChunk of splitReasoningFromText(mdReasoningState, chunk)) {
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
        const msg = err instanceof Error ? err.message : String(err);
        deps.logDebug?.("api.ai-assistant.md-import.error", { error: msg });
        yield { type: "error", error: msg };
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
      maxOutputTokens: request.maxOutputTokens ?? undefined,
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

      // Emit the cleaned text result. For code-generating modes (dice_script),
      // strip any stray markdown fences the model added despite instructions.
      if (fullText.trim()) {
        const finalText = request.mode === "dice_script"
          ? cleanGeneratedCode(fullText)
          : fullText;
        yield { type: "text", text: finalText };
      }
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
    }
    if (prepared.doneMetadata) {
      yield {
        type: "done",
        ...prepared.doneMetadata,
        finishReason: await result.finishReason,
      };
    } else {
      yield { type: "done" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}

const MD_IMPORT_STRING_FIELDS = ["name", "tagline", "description", "personality", "scenario", "firstMessage", "creatorNotes"] as const;

const MD_IMPORT_FIELD_ALIASES: Record<string, string> = {
  name: "name",
  title: "name",
  character_name: "name",
  card_name: "name",
  tagline: "tagline",
  subtitle: "tagline",
  hook: "tagline",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  firstmessage: "firstMessage",
  first_message: "firstMessage",
  first_message_greeting: "firstMessage",
  greeting: "firstMessage",
  intro: "firstMessage",
  examplemessages: "exampleMessages",
  example_messages: "exampleMessages",
  examples: "exampleMessages",
  mes_example: "exampleMessages",
  creatornotes: "creatorNotes",
  creator_notes: "creatorNotes",
  notes: "creatorNotes",
  author_notes: "creatorNotes",
  alternategreetings: "alternateGreetings",
  alternate_greetings: "alternateGreetings",
  alt_greetings: "alternateGreetings",
  alts: "alternateGreetings",
  additionalcharacters: "additionalCharacters",
  additional_characters: "additionalCharacters",
};

function hasUsefulMdImportJson(obj: Record<string, unknown>): boolean {
  if (MD_IMPORT_STRING_FIELDS.some((key) => typeof obj[key] === "string" && obj[key].trim().length > 0)) return true;
  if (Array.isArray(obj.exampleMessages) && obj.exampleMessages.length > 0) return true;
  if (Array.isArray(obj.alternateGreetings) && obj.alternateGreetings.length > 0) return true;
  if (Array.isArray(obj.additionalCharacters) && obj.additionalCharacters.length > 0) return true;
  return false;
}

function extractMdImportObjectFromText(text: string): Record<string, unknown> | null {
  const json = normalizeMdImportObject(extractJsonFromText(text) ?? extractPartialJsonObject(text));
  if (json && hasUsefulMdImportJson(json)) return json;

  const labels = normalizeMdImportObject(extractLabelFieldsFromText(text));
  if (labels && hasUsefulMdImportJson(labels)) return labels;

  return null;
}

/**
 * Clean generated JavaScript code from a model response: strips a single
 * surrounding markdown code fence (```js ... ``` or ``` ... ```) if the model
 * added one despite instructions, and trims surrounding whitespace. Used for
 * `dice_script` mode so the user receives raw executable code.
 */
export function cleanGeneratedCode(text: string): string {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:javascript|js)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  return cleaned;
}

function mergeMdImportWithSourceSections(
  aiFields: Record<string, unknown> | null,
  sourceMarkdown: string,
): Record<string, unknown> | null {
  const sourceFields = extractMdImportSectionsFromSource(sourceMarkdown);
  if (!sourceFields) return aiFields;

  const merged: Record<string, unknown> = { ...(aiFields ?? {}) };
  for (const key of ["tagline", "description", "personality", "scenario", "firstMessage", "exampleMessages", "creatorNotes", "additionalCharacters"]) {
    if (sourceFields[key] != null) merged[key] = sourceFields[key];
  }
  return Object.keys(merged).length ? normalizeMdImportObject(merged) : null;
}

function extractMdImportSectionsFromSource(markdown: string): Record<string, unknown> | null {
  const sections = splitMarkdownSections(markdown);
  if (sections.length === 0) return null;

  const out: Record<string, unknown> = {};
  for (const section of sections) {
    const key = mapMarkdownHeadingToMdImportField(section.title);
    if (!key) continue;
    const content = section.content.trim();
    if (!content) continue;

    if (key === "exampleMessages") out.exampleMessages = splitExampleMessages(content);
    else out[key] = content;
  }

  if (typeof out.personality === "string") {
    const chars = extractAdditionalCharactersFromPersonality(out.personality);
    if (chars.length > 0) out.additionalCharacters = chars;
  }

  return Object.keys(out).length ? out : null;
}

function splitMarkdownSections(markdown: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string[] }> = [];
  let current: { title: string; content: string[] } | null = null;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), content: [] };
      continue;
    }
    if (current) current.content.push(line);
  }
  if (current) sections.push(current);

  return sections.map((section) => ({ title: section.title, content: section.content.join("\n").trim() }));
}

function mapMarkdownHeadingToMdImportField(title: string): string | null {
  const normalized = title
    .trim()
    .replace(/[`'\"]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();

  switch (normalized) {
    case "tagline":
    case "subtitle":
    case "hook":
      return "tagline";
    case "public_bio":
    case "bio":
      return "creatorNotes";
    case "description":
    case "public_description":
      return "description";
    case "personality":
    case "personalities":
    case "character_personality":
      return "personality";
    case "scenario":
    case "scenario_prompt":
    case "setting":
      return "scenario";
    case "first_message":
    case "firstmessage":
    case "greeting":
    case "initial_message":
      return "firstMessage";
    case "mes_example":
    case "example_messages":
    case "example_dialogue":
    case "examples":
      return "exampleMessages";
    case "creator_notes":
    case "creatornotes":
    case "author_notes":
    case "notes":
      return "creatorNotes";
    default:
      return null;
  }
}

function extractAdditionalCharactersFromPersonality(personality: string): Array<{ name: string; description?: string; personality?: string }> {
  const marker = /^\[Character:\s*([^\]]+)\]\s*$/gim;
  const matches = [...personality.matchAll(marker)];
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? personality.length : personality.length;
    const name = match[1].trim();
    const body = personality.slice(start, end).trim();
    const parts = splitBracketSubsections(body);
    const descriptionParts: string[] = [];
    const personalityParts: string[] = [];

    for (const part of parts) {
      const key = part.title.toLowerCase().replace(/\s+/g, "_");
      const rendered = `[${part.title}]\n${part.content}`.trim();
      if (["base", "appearance", "physiology", "anatomy", "backstory", "setting", "relationships"].includes(key)) {
        descriptionParts.push(rendered);
      } else {
        personalityParts.push(rendered);
      }
    }

    return {
      name,
      description: descriptionParts.join("\n\n") || body || undefined,
      personality: personalityParts.join("\n\n") || undefined,
    };
  }).filter((item) => item.name);
}

function splitBracketSubsections(text: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string[] }> = [];
  let current: { title: string; content: string[] } | null = null;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^\[([^\]]+)\]\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), content: [] };
      continue;
    }
    if (current) current.content.push(line);
    else if (line.trim()) {
      current = { title: "Description", content: [line] };
    }
  }
  if (current) sections.push(current);

  return sections
    .map((section) => ({ title: section.title, content: section.content.join("\n").trim() }))
    .filter((section) => section.content);
}

function normalizeMdImportObject(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = normalizeMdImportFieldKey(rawKey);
    if (!key) continue;

    if (MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number])) {
      if (typeof rawValue === "string" && rawValue.trim()) out[key] = rawValue.trim();
      continue;
    }

    if (key === "exampleMessages") {
      if (Array.isArray(rawValue)) {
        const examples = rawValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
        if (examples.length) out.exampleMessages = examples;
      } else if (typeof rawValue === "string" && rawValue.trim()) {
        out.exampleMessages = splitExampleMessages(rawValue);
      }
      continue;
    }

    if (key === "alternateGreetings") {
      if (Array.isArray(rawValue)) {
        const greetings = rawValue.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
        if (greetings.length) out.alternateGreetings = greetings;
      }
      continue;
    }

    if (key === "additionalCharacters" && Array.isArray(rawValue)) {
      const chars = rawValue
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          name: typeof item.name === "string" ? item.name.trim() : "",
          description: typeof item.description === "string" ? item.description.trim() : undefined,
          personality: typeof item.personality === "string" ? item.personality.trim() : undefined,
        }))
        .filter((item) => item.name);
      if (chars.length) out.additionalCharacters = chars;
    }
  }
  return Object.keys(out).length ? out : null;
}

function normalizeMdImportFieldKey(key: string): string | null {
  const normalized = key
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/[`'\"]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
  return MD_IMPORT_FIELD_ALIASES[normalized] ?? null;
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

function extractPartialJsonObject(text: string): Record<string, unknown> | null {
  const firstBrace = text.indexOf("{");
  const source = firstBrace >= 0 ? text.slice(firstBrace) : text;
  const out: Record<string, unknown> = {};

  const completeStringField = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of source.matchAll(completeStringField)) {
    const key = normalizeMdImportFieldKey(match[1]);
    if (key && MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number])) {
      out[key] = decodeJsonStringFragment(match[2]);
    }
  }

  const incompleteStringField = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([\s\S]*)$/;
  const incomplete = source.match(incompleteStringField);
  if (incomplete) {
    const key = normalizeMdImportFieldKey(incomplete[1]);
    if (key && MD_IMPORT_STRING_FIELDS.includes(key as (typeof MD_IMPORT_STRING_FIELDS)[number]) && out[key] == null) {
      out[key] = decodeJsonStringFragment(incomplete[2].replace(/[,\s]*$/, ""));
    }
  }

  const exampleArray = source.match(/"(?:exampleMessages|example_messages|examples|mes_example)"\s*:\s*\[([\s\S]*?)\]/i);
  if (exampleArray) {
    const examples = [...exampleArray[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => decodeJsonStringFragment(match[1]).trim())
      .filter(Boolean);
    if (examples.length) out.exampleMessages = examples;
  }

  return Object.keys(out).length ? out : null;
}

function extractLabelFieldsFromText(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let buffer: string[] = [];

  function flush(): void {
    if (!currentKey) return;
    const value = buffer.join("\n").trim();
    if (!value) return;
    if (currentKey === "exampleMessages") out.exampleMessages = splitExampleMessages(value);
    else out[currentKey] = value;
  }

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const colonMatch = line.match(/^#{0,6}\s*[-*•]?\s*\*?\*?([A-Za-z][A-Za-z0-9_\s-]{0,40})\*?\*?\s*:\s*(.*)$/);
    const standaloneKey = line.length <= 48 ? normalizeMdImportFieldKey(line) : null;
    const colonKey = colonMatch ? normalizeMdImportFieldKey(colonMatch[1]) : null;

    if (colonKey) {
      flush();
      currentKey = colonKey;
      buffer = colonMatch?.[2] ? [colonMatch[2]] : [];
      continue;
    }

    if (standaloneKey) {
      flush();
      currentKey = standaloneKey;
      buffer = [];
      continue;
    }

    if (currentKey) buffer.push(rawLine);
  }
  flush();

  return Object.keys(out).length ? out : null;
}

function splitExampleMessages(value: string): string[] {
  const parts = value
    .split(/\n\s*(?:<START>|---|={3,}|#{1,6}\s*Example\b|Example\s*\d+\s*:?)\s*\n/gi)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [value.trim()].filter(Boolean);
}

function decodeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
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

    case "dice_script": {
      if (request.existingContent) {
        return `Here is my current Dice script:\n\n${request.existingContent}\n\nModification request:\n${request.instruction}\n\nReturn the complete updated JavaScript Dice script only. Do not return a patch, diff, markdown, or explanation. Preserve unrelated code exactly where possible.`;
      }
      return `${request.instruction}\n\nReturn the complete JavaScript Dice script only. Do not return markdown, explanation, or anything other than the script code.`;
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
      return request.instruction || "Write a message as this persona would speak in the current conversation.";
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
